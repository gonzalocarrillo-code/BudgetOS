import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { newId, type Role } from "@budget/domain";
import { GOLDEN_COLLAB, GOLDEN_CUSTOM_DIMENSIONS, GOLDEN_FACTS, GOLDEN_FILTER_TARGET, GOLDEN_FY, GOLDEN_PACING, GOLDEN_PENDING_BULK, GOLDEN_ROUNDS, GOLDEN_SPLIT, GOLDEN_TARGET_POLICY, splitAmounts, GOLDEN_TEMPLATES, goldenFactsCsv, goldenPlan, goldenTagLeaves, goldenTargets, withTenant, type PlannedEnvelope, type TenantContext } from "@budget/db";
import { MemoryObjectStore, evaluateWorkspace, reindexWorkspace, runIngest, uploadBucket } from "@budget/workers";
import { PrismaClient } from "@prisma/client";
import { clock } from "../common/clock.js";
import type { AuthContext } from "../common/tenant.js";
import { assignRole } from "../modules/admin/commands/assign-role.js";
import { decide } from "../modules/approvals/commands/decide.js";
import { createPolicy, seedDefaultPolicies } from "../modules/approvals/commands/policies.js";
import { PolicySnapshot } from "../modules/approvals/engine.js";
import { createDraftVersion } from "../modules/envelopes/commands/create-draft-version.js";
import { createEnvelope } from "../modules/envelopes/commands/create-envelope.js";
import { splitEnvelope } from "../modules/envelopes/commands/structure.js";
import { submitVersion } from "../modules/envelopes/commands/submit-version.js";
import { commitBulk } from "../modules/envelopes/bulk/commit.js";
import { buildPreview } from "../modules/envelopes/bulk/preview.js";
import { MemoryPreviewStore } from "../modules/envelopes/bulk/preview-store.js";
import { InMemoryAssetStore } from "../modules/registry/assets/asset-store.js";
import { addValues } from "../modules/registry/commands/add-values.js";
import { createDimension } from "../modules/registry/commands/create-dimension.js";
import { saveHierarchyTemplate } from "../modules/registry/commands/save-hierarchy-template.js";
import { createSource, queueRun } from "../modules/sources/commands/sources.js";
import { seedDefaultRules } from "../modules/pacing/rules.js";
import { applyTag, createTag } from "../modules/threads/commands/tags.js";
import { addComment, createThread, resolveThread } from "../modules/threads/commands/threads.js";
import { seedDefaultRegistry } from "../modules/registry/commands/seed-registry.js";
import { uploadAsset } from "../modules/registry/commands/upload-asset.js";
import { createTarget } from "../modules/targets/commands/create-target.js";
import { submitTarget } from "../modules/targets/commands/submit-target.js";

/**
 * Golden dataset generator (spec §21, T-006). Every envelope, version, approval and registry row
 * comes from the real commands, so the audit trail is real; only the org, workspace, users and the
 * first org-admin grant are inserted directly, because no command creates them yet (§27).
 * Amounts and structure come from `goldenPlan()` in @budget/db; `GOLDEN_ASSERTIONS` holds the totals.
 */

const PERSONAS = {
  orgAdmin: "ORG_ADMIN",
  admin: "WORKSPACE_ADMIN",
  planner: "PLANNER",
  budgetOwner: "BUDGET_OWNER",
  approver: "APPROVER",
  finance1: "FINANCE",
  finance2: "FINANCE",
} as const satisfies Record<string, Role>;
type Persona = keyof typeof PERSONAS;

export interface GoldenResult {
  orgId: string;
  workspaceId: string;
  users: Record<Persona, string>;
  envelopeIds: Map<string, string>;
  /** T-017: the golden CSV source, its run, and the object store holding the upload and the rejected-rows report. */
  ingest: { sourceId: string; runId: string; store: MemoryObjectStore } | null;
  created: boolean;
  elapsedMs: number;
}

export interface GoldenOptions {
  /** Workspace slug; "golden" for `pnpm db:seed`, unique per test run otherwise. */
  slug?: string;
  concurrency?: number;
  log?: (line: string) => void;
}

const MARKET_TIER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 20h18M6 16V9m6 7V5m6 11v-4" stroke="currentColor" fill="none" stroke-width="2"/></svg>';

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        await fn(item);
      }
    }),
  );
}

export async function seedGolden(app: PrismaClient, owner: PrismaClient, opts: GoldenOptions = {}): Promise<GoldenResult> {
  const started = performance.now();
  const slug = opts.slug ?? "golden";
  const log = opts.log ?? (() => undefined);
  const concurrency = opts.concurrency ?? 8;

  const existing = await owner.workspace.findFirst({ where: { slug }, select: { id: true, orgId: true } });
  if (existing) {
    log(`golden: workspace '${slug}' already exists (${existing.id}); nothing to do. Use pnpm db:reset for a fresh one.`);
    return { orgId: existing.orgId, workspaceId: existing.id, users: {} as Record<Persona, string>, envelopeIds: new Map(), ingest: null, created: false, elapsedMs: performance.now() - started };
  }

  // ---- Bootstrap: no command creates orgs, workspaces or users yet (spec §27). ----
  const orgId = newId();
  const workspaceId = newId();
  const users = Object.fromEntries(Object.keys(PERSONAS).map((p) => [p, newId()])) as Record<Persona, string>;
  await owner.organization.create({ data: { id: orgId, name: `Golden (${slug})` } });
  await owner.workspace.create({ data: { id: workspaceId, orgId, slug, name: "Golden", reportingCurrency: "USD", fiscalYearStartMonth: 1 } });
  await owner.user.createMany({
    data: (Object.keys(PERSONAS) as Persona[]).map((p) => ({ id: users[p], orgId, email: `${p.toLowerCase()}@${slug}.golden.test`, name: `Golden ${p}`, googleSub: `golden-${slug}-${p}` })),
  });
  await owner.roleAssignment.create({ data: { id: newId(), workspaceId: null, principalType: "user", principalId: users.orgAdmin, role: "ORG_ADMIN", createdBy: users.orgAdmin } });

  let seq = 0;
  const auth = (p: Persona): AuthContext => {
    const role = PERSONAS[p] as Role;
    return {
      ctx: { workspaceId, orgId, userId: users[p], isOrgAdmin: false, actorType: "user", requestId: `golden-${slug}-${++seq}` },
      user: { id: users[p], orgId, email: `${p.toLowerCase()}@${slug}.golden.test`, name: `Golden ${p}` },
      isOrgAdmin: p === "orgAdmin",
      roles: [role],
      assignments: [{ role, scope: {} }],
    };
  };
  const orgAdminCtx = (): TenantContext => ({ ...auth("orgAdmin").ctx, isOrgAdmin: true });

  // ---- Registry: defaults, 3 custom dimensions (one with an asset: icon), 2 templates. ----
  const store = new InMemoryAssetStore();
  await seedDefaultRegistry(app, orgAdminCtx(), ["ORG_ADMIN"], store);
  const { icon: tierIcon } = await uploadAsset(app, orgAdminCtx(), ["ORG_ADMIN"], { contentType: "image/svg+xml", svg: MARKET_TIER_SVG }, store);
  for (const [i, d] of GOLDEN_CUSTOM_DIMENSIONS.entries()) {
    const created = await createDimension(
      app,
      orgAdminCtx(),
      ["ORG_ADMIN"],
      { key: d.key, label: d.label, dataType: "ENUM", icon: d.icon === "asset" ? tierIcon : d.icon, allowedParents: [], isRequiredForLeaf: false, sortOrder: 100 + i, workspaceId },
      store,
    );
    await addValues(app, orgAdminCtx(), ["ORG_ADMIN"], created.id, { values: d.values.map(([code, label]) => ({ code, label })) });
  }
  for (const t of GOLDEN_TEMPLATES) {
    await saveHierarchyTemplate(app, orgAdminCtx(), ["ORG_ADMIN"], { name: t.name, path: [...t.path], isDefault: false });
  }
  log("golden: registry seeded");

  // ---- People and policies. ----
  for (const p of Object.keys(PERSONAS) as Persona[]) {
    if (p === "orgAdmin") continue;
    await assignRole(app, auth("orgAdmin"), { principalType: "user", principalId: users[p], role: PERSONAS[p] });
  }
  await seedDefaultPolicies(app, auth("admin").ctx);

  // ---- Approvals: walk each request through its frozen chain with the right personas. ----
  const decidersFor: Record<string, Persona[]> = {
    BUDGET_OWNER: ["budgetOwner"],
    APPROVER: ["approver"],
    FINANCE: ["finance1", "finance2"],
    WORKSPACE_ADMIN: ["admin"],
  };
  const approve = async (envelopeId: string, versionId: string): Promise<void> => {
    const submitted = await submitVersion(app, auth("planner"), envelopeId, { versionId });
    if (submitted.autoApproved) return;
    const requestId = submitted.requestId as string;
    for (let guard = 0; guard < 10; guard += 1) {
      const r = await withTenant(app, auth("planner").ctx, (tx) => tx.approvalRequest.findUniqueOrThrow({ where: { id: requestId } }));
      if (r.status === "APPROVED") return;
      const step = PolicySnapshot.parse(r.policySnapshot).chain[r.currentStep];
      if (step === undefined) throw new Error(`golden: request ${requestId} has no step ${r.currentStep}`);
      const people = decidersFor[step.role] ?? [];
      if (people.length < step.minApprovals) throw new Error(`golden: not enough ${step.role} personas for ${requestId}`);
      for (const p of people.slice(0, step.minApprovals)) await decide(app, auth(p), requestId, { decision: "approve" });
    }
    throw new Error(`golden: request ${requestId} did not finish`);
  };

  // ---- Envelope tree, top-down so parents are approved before children count against them. ----
  const plan = goldenPlan();
  const ids = new Map<string, string>();
  const byLevel = new Map<number, PlannedEnvelope[]>();
  for (const e of plan) byLevel.set(e.level, [...(byLevel.get(e.level) ?? []), e]);
  const round1 = GOLDEN_ROUNDS[0];
  clock.now = () => new Date(round1.approvedAt);
  try {
    for (const level of [0, 1, 2, 3, 4]) {
      await pool(byLevel.get(level) ?? [], concurrency, async (e) => {
        const v1 = e.versions[0];
        if (v1 === undefined) throw new Error(`golden: ${e.key} has no version`);
        const created = await createEnvelope(app, auth("planner"), {
          name: e.name,
          parentId: e.parentKey ? (ids.get(e.parentKey) ?? null) : null,
          dimensionValues: e.dimensionValues,
          startDate: GOLDEN_FY.start,
          endDate: GOLDEN_FY.end,
          currency: "USD",
          amount: v1.amount,
          phasing: v1.phasing,
          rationale: `FY2026 plan (round 1)`,
        });
        ids.set(e.key, created.id);
        await approve(created.id, created.draftVersionId as string);
      });
      log(`golden: level ${level} approved (${byLevel.get(level)?.length ?? 0})`);
    }
    for (const round of GOLDEN_ROUNDS.slice(1)) {
      clock.now = () => new Date(round.approvedAt);
      await pool(byLevel.get(4) ?? [], concurrency, async (e) => {
        const v = e.versions.find((x) => x.round === round.round);
        if (v === undefined) return;
        const id = ids.get(e.key) as string;
        const head = await withTenant(app, auth("planner").ctx, (tx) => tx.envelope.findUniqueOrThrow({ where: { id }, select: { currentVersionId: true } }));
        const draft = await createDraftVersion(app, auth("planner"), id, { amount: v.amount, phasing: v.phasing, basedOnVersionId: head.currentVersionId, rationale: `Re-plan (round ${round.round})` });
        await approve(id, draft.id);
      });
      log(`golden: round ${round.round} approved`);
    }
    // T-013: one bulk change through preview + commit, left pending approval (not counted as budget).
    const bulk = GOLDEN_PENDING_BULK;
    const bulkIds = plan
      .filter((e) => e.level === 4 && e.dimensionValues["region"] === bulk.region && e.dimensionValues["platform"] === bulk.platform)
      .map((e) => ids.get(e.key) as string);
    const previews = new MemoryPreviewStore();
    const preview = await buildPreview(app, auth("planner"), { workspaceId, selection: { envelopeIds: bulkIds }, operation: { op: "pct", pct: bulk.pct }, rationale: bulk.rationale }, previews);
    await commitBulk(app, auth("planner"), preview.previewId, previews);
    log(`golden: bulk change pending (${bulkIds.length} rows)`);

    // T-014: one split, auto-approved (a structural change keeps the total), source archived.
    clock.now = () => new Date(GOLDEN_SPLIT.at);
    const sourceId = ids.get(GOLDEN_SPLIT.sourceKey) as string;
    const head = await withTenant(app, auth("planner").ctx, (tx) => tx.envelope.findUniqueOrThrow({ where: { id: sourceId }, select: { currentVersionId: true } }));
    const parts = splitAmounts(plan);
    const split = await splitEnvelope(app, auth("planner"), sourceId, {
      basedOnVersionId: head.currentVersionId,
      rationale: GOLDEN_SPLIT.rationale,
      parts: parts.map((p) => ({ name: p.name, amount: p.amount, dimensionValues: { retailer: p.retailer } })),
    });
    split.partIds.forEach((pid, i) => ids.set(`${GOLDEN_SPLIT.sourceKey}#${parts[i]?.retailer}`, pid));
    log(`golden: split ${GOLDEN_SPLIT.sourceKey} into ${split.partIds.length} (${split.autoApproved ? "auto-approved" : "pending"})`);

    // T-015: CPA targets (countries + every other leaf) and one filter-scoped ROAS target, through
    // the real commands; a workspace policy auto-approves target versions. Metrics came with the registry.
    await createPolicy(app, auth("admin"), { name: GOLDEN_TARGET_POLICY.name, priority: GOLDEN_TARGET_POLICY.priority, conditions: { entityType: "target_version" }, chain: [] });
    const submitNew = async (created: { id: string; draft: { id: string } }) => {
      const s = await submitTarget(app, auth("planner"), created.id, { versionId: created.draft.id });
      if (!s.autoApproved) throw new Error(`golden: target ${created.id} was not auto-approved`);
    };
    const targets = goldenTargets(plan);
    await pool(targets, concurrency, async (t) => {
      await submitNew(await createTarget(app, auth("planner"), { scope: { type: "envelope", envelopeId: ids.get(t.envelopeKey) }, metricKey: t.metricKey, value: t.value, comparator: "lte", rationale: "FY2026 CPA target" }));
    });
    const f = GOLDEN_FILTER_TARGET;
    await submitNew(
      await createTarget(app, auth("planner"), {
        scope: { type: "filter", filter: { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: f.region }] } },
        metricKey: f.metricKey,
        value: f.value,
        comparator: f.comparator,
        startDate: GOLDEN_FY.start,
        endDate: GOLDEN_FY.end,
        rationale: `${f.region} ROAS floor`,
      }),
    );
    log(`golden: ${targets.length + 1} targets approved`);
  } finally {
    clock.now = () => new Date();
  }

  // ---- T-017: actuals through the real ingest pipeline (CSV connector, in-memory object store). ----
  const objects = new MemoryObjectStore();
  const uri = `gs://${uploadBucket()}/uploads/${workspaceId}/golden-2026.csv`;
  await objects.write(uri, goldenFactsCsv(plan), "text/csv");
  const source = await createSource(app, auth("admin"), { name: "Golden actuals (CSV)", config: { kind: "csv", uri }, mapping: GOLDEN_FACTS.mapping });
  const { runId } = await queueRun(app, auth("admin"), source.id);
  const run = await runIngest({ prisma: app, store: objects, reportBucket: uploadBucket() }, { workspaceId, orgId }, runId);
  log(`golden: ${run.rowsRead} fact rows, ${run.rowsRejected} rejected, match coverage ${run.coverage.matchCoverage}`);

  // ---- T-018: default pacing rules, evaluated on three consecutive days by the real job function. ----
  await seedDefaultRules(app, auth("admin").ctx);
  let opened = 0;
  for (const day of GOLDEN_PACING.days) opened += (await evaluateWorkspace(app, { workspaceId, orgId }, day, new Date(`${day}T12:00:00Z`))).opened.length;
  log(`golden: pacing evaluated for ${GOLDEN_PACING.days.length} days, ${opened} alerts open`);

  // ---- T-019: tags and threads through the real commands (mentions in the canonical @[user:id] form). ----
  for (const t of GOLDEN_COLLAB.tags) {
    const tag = await createTag(app, auth("admin"), { name: t.name, color: t.color });
    await applyTag(app, auth("planner"), { tagId: tag.id, entities: goldenTagLeaves(plan, t.name).map((key) => ({ type: "envelope", id: ids.get(key) as string })) }, "add");
  }
  const canonical = (body: string) => body.replace(/@(\w+)/g, (m, p: string) => (p in users ? `@[user:${users[p as Persona]}]` : m));
  for (const t of GOLDEN_COLLAB.threads) {
    const author = t.author as Persona;
    const replier: Persona = author === "planner" ? "budgetOwner" : "planner";
    const [first, ...rest] = t.comments.map(canonical);
    const created = await createThread(app, auth(author), {
      anchorType: t.anchor,
      anchorId: ids.get(t.leafKey) as string,
      anchorMeta: t.anchor === "cell" ? { month: "2026-10-01" } : {},
      title: t.title,
      isBlocking: t.isBlocking,
      firstComment: { bodyMd: first ?? "" },
    });
    for (const [i, body] of rest.entries()) await addComment(app, auth(i % 2 === 0 ? replier : author), created.id, { bodyMd: body });
    if (t.resolve) await resolveThread(app, auth(author), created.id);
  }
  log(`golden: ${GOLDEN_COLLAB.tags.length} tags, ${GOLDEN_COLLAB.threads.length} threads`);

  // ---- T-020: full search re-index (facets for the pacing day, so the documents are deterministic). ----
  const indexed = await reindexWorkspace(app, { workspaceId, orgId }, GOLDEN_PACING.days[GOLDEN_PACING.days.length - 1]);
  log(`golden: search indexed ${Object.values(indexed).reduce((n, c) => n + c, 0)} documents`);

  const elapsedMs = performance.now() - started;
  log(`golden: ${plan.length} envelopes in ${(elapsedMs / 1000).toFixed(1)} s`);
  return { orgId, workspaceId, users, envelopeIds: ids, ingest: { sourceId: source.id, runId, store: objects }, created: true, elapsedMs };
}

// ---- CLI: `pnpm db:seed [--size small|large]` ----

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    const i = t.indexOf("=");
    if (t === "" || t.startsWith("#") || i === -1) continue;
    const key = t.slice(0, i).trim();
    if (process.env[key] === undefined) process.env[key] = t.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}

async function main(): Promise<void> {
  const size = process.argv.includes("--size") ? process.argv[process.argv.indexOf("--size") + 1] : "small";
  if (size !== "small") {
    process.stderr.write(`golden: --size ${size} is the T-034 load generator (scripts/load-test.ts), not built yet\n`);
    process.exit(2);
  }
  loadEnv(join(dirname(fileURLToPath(import.meta.url)), "../../../../packages/db/.env"));
  const app = new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });
  const owner = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
  try {
    const out = await seedGolden(app, owner, { log: (l) => process.stdout.write(`${l}\n`) });
    if (out.created) process.stdout.write(`golden: workspace ${out.workspaceId} (org ${out.orgId}) ready\n`);
  } finally {
    await Promise.all([app.$disconnect(), owner.$disconnect()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`golden: failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}

