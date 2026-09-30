import { pathToFileURL } from "node:url";
import { newId, type Role } from "@budget/domain";
import { DEFAULT_TEMPLATE_KEY, audit, ensureDefaultTemplate, openAlert, outbox, withTenant } from "@budget/db";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import type { AuthContext } from "../common/tenant.js";
import { commitBulk } from "../modules/envelopes/bulk/commit.js";
import { buildPreview } from "../modules/envelopes/bulk/preview.js";
import { MemoryPreviewStore } from "../modules/envelopes/bulk/preview-store.js";
import { createDraftVersion } from "../modules/envelopes/commands/create-draft-version.js";
import { submitVersion } from "../modules/envelopes/commands/submit-version.js";
import { updateSlackSettings } from "../modules/slack/slack.service.js";
import { addComment, createThread } from "../modules/threads/commands/threads.js";
import { createWorkspace } from "../modules/workspaces/workspaces.js";

/**
 * A Slack sandbox for the deployment (owner request, 2026-09-30): something real for the bot to
 * post, without touching real workspaces. Run as a one-off execution of `budgetos-migrate`:
 *
 *   tsx src/deploy/slack-sandbox.ts
 *   env: SUPERADMIN_EMAIL (who approves and is mentioned), SANDBOX_CHANNEL (optional, e.g. #budgetos-test),
 *        TEST_USER_EMAIL (optional; default budgetos.tester@deptagency.com)
 *
 * - A workspace "Slack sandbox" from the default template with demo budgets (created once).
 * - A test user, "BudgetOS Tester" (Planner there). The superadmin gets Budget owner, Approver and
 *   Finance there, so every approval step waits on them and they get the DMs.
 * - Every run adds: up to three budget changes and a bulk change sent for approval by the tester
 *   (while budgets are free to change), open alerts (critical, warning, info; one per rule and
 *   budget), and a thread whose comments @mention the superadmin.
 *
 * Everything goes through the app's commands (audit + outbox), so the notify worker posts it to
 * Slack as it would the real thing. Alerts are opened the way pacing opens them.
 */
const SLUG = "slack-sandbox";

export async function seedSlackSandbox(app: PrismaClient, owner: PrismaClient, env: NodeJS.ProcessEnv = process.env) {
  const email = (env["SUPERADMIN_EMAIL"] ?? "").trim().toLowerCase();
  const testerEmail = (env["TEST_USER_EMAIL"] ?? "budgetos.tester@deptagency.com").trim().toLowerCase();
  const channel = env["SANDBOX_CHANNEL"]?.trim() || null;
  const boss = await owner.user.findUnique({ where: { email } });
  if (!boss) throw new Error(`No user ${email}: run the bootstrap first`);
  const orgId = boss.orgId;
  let seq = 0;
  const as = (u: { id: string; email: string; name: string }, workspaceId: string | null, roles: Role[], isOrgAdmin = false): AuthContext => ({
    ctx: { workspaceId, orgId, userId: u.id, isOrgAdmin: isOrgAdmin && workspaceId === null, actorType: "user", requestId: `slack-sandbox-${Date.now()}-${++seq}` },
    user: { id: u.id, orgId, email: u.email, name: u.name },
    isOrgAdmin,
    roles,
    assignments: roles.map((role) => ({ role, scope: {} })),
  });

  // ---- The workspace, once ----
  let ws = await owner.workspace.findFirst({ where: { orgId, slug: SLUG, deletedAt: null }, select: { id: true } });
  if (!ws) {
    const ctx = { workspaceId: null, orgId, userId: boss.id, isOrgAdmin: true, actorType: "system" as const, requestId: "slack-sandbox-template" };
    const templateId = (await owner.workspaceTemplate.findFirst({ where: { key: DEFAULT_TEMPLATE_KEY, OR: [{ orgId }, { orgId: null }] }, select: { id: true } }))?.id ?? (await withTenant(owner, ctx, (tx) => ensureDefaultTemplate(tx, newId)));
    const created = await createWorkspace(app, as(boss, null, ["ORG_ADMIN"], true), { name: "Slack sandbox", slug: SLUG, templateId, withDemoData: true, reportingCurrency: "USD", fiscalYearStartMonth: 1 });
    ws = { id: String((created as { id: string }).id) };
  }
  const workspaceId = ws.id;

  // ---- People and roles, once ----
  const tester = (await owner.user.findUnique({ where: { email: testerEmail } })) ?? (await owner.user.create({ data: { id: newId(), orgId, email: testerEmail, name: "BudgetOS Tester" } }));
  const grant = async (userId: string, role: Role) => {
    const has = await owner.roleAssignment.findFirst({ where: { workspaceId, principalType: "user", principalId: userId, role } });
    if (!has) await owner.roleAssignment.create({ data: { id: newId(), workspaceId, principalType: "user", principalId: userId, role, createdBy: boss.id } });
  };
  await grant(tester.id, "PLANNER");
  for (const role of ["BUDGET_OWNER", "APPROVER", "FINANCE"] as const) await grant(boss.id, role);
  const planner = as(tester, workspaceId, ["PLANNER"]);
  const admin = as(boss, workspaceId, ["WORKSPACE_ADMIN", "BUDGET_OWNER", "APPROVER", "FINANCE"]);

  if (channel) await updateSlackSettings(app, admin, { defaultChannel: channel, alertChannel: channel, alertSeverities: ["critical", "warning", "info"], approvals: true, dms: true });

  // ---- Approvals: three budget changes and a bulk change, from the tester ----
  // Budgets free to change (no draft or request open), and every live leaf for alerts and comments.
  const all = await owner.$queryRawUnsafe<Array<{ id: string; name: string; amount: string }>>(
    `SELECT e.id::text, e.name, coalesce((SELECT v.amount::text FROM envelope_version v WHERE v.envelope_id = e.id AND v.status IN ('APPROVED', 'SUPERSEDED') ORDER BY v.approved_at DESC NULLS LAST LIMIT 1), '0') AS amount
       FROM envelope e WHERE e.workspace_id = $1::uuid AND e.status <> 'ARCHIVED' AND e.ended_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM envelope c WHERE c.parent_id = e.id) ORDER BY e.name`,
    workspaceId,
  );
  const leaves = await owner.$queryRawUnsafe<Array<{ id: string; name: string; version_id: string; amount: string }>>(
    `SELECT e.id::text, e.name, v.id::text AS version_id, v.amount::text
       FROM envelope e
       JOIN LATERAL (SELECT id, amount FROM envelope_version WHERE envelope_id = e.id AND status = 'APPROVED' ORDER BY approved_at DESC LIMIT 1) v ON true
      WHERE e.workspace_id = $1::uuid AND e.status = 'APPROVED' AND e.ended_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM envelope c WHERE c.parent_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM envelope_version d WHERE d.envelope_id = e.id AND d.status IN ('DRAFT', 'PENDING'))
      ORDER BY e.name`,
    workspaceId,
  );
  if (all.length === 0) throw new Error("The sandbox has no budgets");
  const requests: string[] = [];
  const why = ["Q4 push: holiday campaign", "Moving budget from paid search", "New retail partner launch"];
  for (const [i, leaf] of leaves.slice(0, 3).entries()) {
    const amount = new Decimal(leaf.amount).mul([1.35, 0.7, 1.6][i] ?? 1.3).toDecimalPlaces(2).toFixed(2);
    const draft = await createDraftVersion(app, planner, leaf.id, { amount, basedOnVersionId: leaf.version_id, rationale: why[i] });
    const sent = (await submitVersion(app, planner, leaf.id, { versionId: (draft as { id: string }).id })) as { requestId?: string; autoApproved?: boolean };
    if (sent.requestId) requests.push(sent.requestId);
  }
  // A bulk change needs two free budgets; later runs, once every budget waits, add none.
  const bulkIds = leaves.slice(3, 6).map((l) => l.id);
  let bulk = 0;
  if (bulkIds.length >= 2) {
    const previews = new MemoryPreviewStore();
    const preview = await buildPreview(app, planner, { workspaceId, selection: { envelopeIds: bulkIds }, operation: { op: "pct", pct: 15 }, rationale: "Sandbox: +15% on the remaining budgets" }, previews);
    await commitBulk(app, planner, preview.previewId, previews);
    bulk = 1;
  }

  // ---- Alerts: one per severity, opened the way pacing opens them ----
  const alerts: string[] = [];
  await withTenant(app, { workspaceId, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `slack-sandbox-alerts-${Date.now()}` }, async (tx) => {
    const rules = await tx.pacingRule.findMany({ where: { workspaceId, deletedAt: null, isActive: true }, orderBy: { name: "asc" } });
    const today = new Date().toISOString().slice(0, 10);
    for (const [i, severity] of (["critical", "warning", "info"] as const).entries()) {
      const rule = rules.find((r) => r.severity === severity) ?? rules[i % Math.max(rules.length, 1)];
      if (!rule) continue;
      // One open alert per rule and budget: the first budget this rule has none open on.
      const busy = new Set((await tx.alert.findMany({ where: { ruleId: rule.id, status: { in: ["OPEN", "ACKNOWLEDGED", "SNOOZED"] } }, select: { envelopeId: true } })).map((x) => x.envelopeId));
      const leaf = [...all.slice(i), ...all.slice(0, i)].find((l) => !busy.has(l.id));
      if (!leaf) continue;
      const id = newId();
      const budget = new Decimal(leaf.amount);
      const context = { budget: budget.toFixed(2), actual: budget.mul([1.3, 0.2, 0.9][i] ?? 1).toFixed(2), projected: "0.00", dataAsOf: new Date().toISOString(), evaluatedFor: today, sandbox: true };
      const inserted = await openAlert(tx, { id, workspaceId, ruleId: rule.id, envelopeId: leaf.id, severity: rule.severity, metricValue: ["1.3000", "0.2000", "0.9000"][i] ?? "1.0000", threshold: "1.1000", context, ownerId: boss.id });
      if (!inserted) continue;
      await audit(tx, { workspaceId, actorId: null, actorType: "system", action: "alert.opened", entityType: "alert", entityId: id, after: { rule: rule.name, envelopeId: leaf.id, sandbox: true }, requestId: `slack-sandbox-alert-${id}` });
      await outbox(tx, { workspaceId, topic: "alert.triggered", payload: { alertId: id, ruleId: rule.id, envelopeId: leaf.id, severity: rule.severity, delivery: rule.delivery } });
      alerts.push(id);
    }
  });

  // ---- Comments that mention the superadmin ----
  const anchor = all[0];
  if (!anchor) throw new Error("no budget to comment on");
  const mention = `@[user:${boss.id}]`;
  const thread = (await createThread(app, planner, { anchorType: "envelope", anchorId: anchor.id, title: "Sandbox: Q4 push", firstComment: { bodyMd: `${mention} I sent the Q4 raise for ${anchor.name} for approval. Can you look at it today?` } })) as { id: string };
  await addComment(app, planner, thread.id, { bodyMd: `${mention} one more thing: the retail partner wants an answer by Friday.` });

  return { workspaceId, tester: tester.email, requests: requests.length, bulk, alerts: alerts.length, threadId: thread.id, channel };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });
  const owner = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
  seedSlackSandbox(app, owner)
    .then((r) => process.stdout.write(`${JSON.stringify({ slackSandbox: "ok", ...r })}\n`))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => void Promise.all([app.$disconnect(), owner.$disconnect()]));
}
