import { pathToFileURL } from "node:url";
import { newId } from "@budget/domain";
import { withTenant } from "@budget/db";
import { PrismaClient } from "@prisma/client";
import { ensureDefaultMetrics } from "../modules/registry/commands/metrics.js";

/**
 * The deployment's one-time setup (ADR-065), run by the `budgetos-migrate` Cloud Run job after
 * `prisma migrate deploy`, as the owner role. Idempotent: every run leaves the same state.
 *
 * - The owner role never holds BYPASSRLS (W2-3, audit S-2, S-3, S-21; ADR-005 addendum). It is a
 *   DDL owner: migrations create every table, and `ensure_fact_partitions` is SECURITY DEFINER so
 *   `budget_app` can create a fact partition without CREATE on the schema. For the three identity
 *   tables this function writes before any org admin exists to authorize it under their ordinary
 *   policies (`organization`, `app_user`, `role_assignment`), migration
 *   `20261010050000_owner_bootstrap_policies` grants the owner role itself — by name, not by
 *   attribute — an explicit, permanent, table-scoped policy. Nothing here, or anywhere else the
 *   owner connects, bypasses RLS on any other table.
 * - The login roles the migrations create get their passwords from Secret Manager (the migrations
 *   carry a placeholder).
 * - The organization and its superadmin exist: SUPERADMIN_EMAIL holds ORG_ADMIN org-wide, so they
 *   can create workspaces and add people in the org console. Everyone else is added there.
 */
export async function bootstrap(owner: PrismaClient, env: NodeJS.ProcessEnv = process.env): Promise<{ orgId: string; userId: string }> {
  for (const [role, key] of [["budget_app", "APP_DB_PASSWORD"], ["budget_publisher", "PUBLISHER_DB_PASSWORD"], ["budget_mcp", "MCP_DB_PASSWORD"]] as const) {
    const password = env[key];
    if (!password) throw new Error(`${key} is required`);
    // Role names are constants; the password is a quoted literal (no placeholders in ALTER ROLE).
    await owner.$executeRawUnsafe(`ALTER ROLE ${role} PASSWORD '${password.replace(/'/g, "''")}'`);
  }
  const email = (env["SUPERADMIN_EMAIL"] ?? "").trim().toLowerCase();
  if (!email) throw new Error("SUPERADMIN_EMAIL is required");
  const orgName = env["ORG_NAME"] ?? "DEPT";

  // One transaction: the owner_bootstrap policies (organization, app_user, role_assignment) make
  // these reads and writes visible to the owner with no tenant context at all, which is exactly
  // the point — there is no org yet to scope them to.
  const { orgId, userId } = await owner.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email } });
    const orgId =
      existing?.orgId ??
      (await tx.organization.findFirst({ where: { name: orgName }, select: { id: true } }))?.id ??
      (await tx.organization.create({ data: { id: newId(), name: orgName } })).id;
    const name = env["SUPERADMIN_NAME"] ?? email.split("@")[0]!.split(".").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
    const user = existing ?? (await tx.user.create({ data: { id: newId(), orgId, email, name } }));
    if (!user.isActive) await tx.user.update({ where: { id: user.id }, data: { isActive: true } });
    const admin = await tx.roleAssignment.findFirst({ where: { workspaceId: null, principalType: "user", principalId: user.id, role: "ORG_ADMIN" } });
    if (!admin) await tx.roleAssignment.create({ data: { id: newId(), workspaceId: null, principalType: "user", principalId: user.id, role: "ORG_ADMIN", createdBy: user.id } });
    return { orgId, userId: user.id };
  });

  // R11-001: an org whose workspaces were created before workspace creation seeded the metric
  // library gets it now (its CPA and ROAS rules could not run without it). Unlike the identity
  // writes above, `workspace` and `metric_definition` read fine under the ordinary org-admin
  // tenant context (workspace's org_read policy only needs org_id = app_org_id()) — no owner
  // policy needed here.
  const listCtx = { workspaceId: null, orgId, userId, isOrgAdmin: true, actorType: "system" as const, requestId: "bootstrap-metrics" };
  const first = await withTenant(owner, listCtx, (tx) => tx.workspace.findFirst({ where: { orgId, deletedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true } }));
  if (first) {
    const ctx = { ...listCtx, workspaceId: first.id };
    const seeded = await withTenant(owner, ctx, (tx) => tx.metricDefinition.count({ where: { orgId } }));
    if (seeded === 0) await withTenant(owner, ctx, (tx) => ensureDefaultMetrics(tx, ctx, { id: first.id, orgId }));
  }
  return { orgId, userId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const owner = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
  bootstrap(owner)
    .then((r) => process.stdout.write(`${JSON.stringify({ bootstrap: "ok", ...r })}\n`))
    .catch((err: unknown) => {
      process.stderr.write(`${String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => void owner.$disconnect());
}
