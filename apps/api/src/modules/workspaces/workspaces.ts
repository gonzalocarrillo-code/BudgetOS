import { CreatePolicyInput, CreateRuleInput, CreateWorkspaceInput, DomainError, PurgeDemoInput, TemplateSavedView, TourStep, newId, type Role } from "@budget/domain";
import { audit, defaultAgencyTemplate, demoPeriod, ensureDefaultTemplate, ensurePartitions, outbox, purgeDemoData, reseedCampaignDemoData, seedDemoData, withTenant, type TenantContext } from "@budget/db";
import type { Prisma, PrismaClient, WorkspaceTemplate } from "@prisma/client";
import { z } from "zod";
import { parseInput, requireWorkspace } from "../../common/parse-input.js";
import { orgAdminCtx, type AuthContext } from "../../common/tenant.js";
import { insertPolicy } from "../approvals/commands/policies.js";
import { insertRule } from "../pacing/rules.js";
import { ensureDefaultMetrics } from "../registry/commands/metrics.js";
import { InMemoryAssetStore } from "../registry/assets/asset-store.js";
import { addValues } from "../registry/commands/add-values.js";
import { createDimension } from "../registry/commands/create-dimension.js";

/**
 * Workspace templates and new workspaces (spec §27, plan §11.7 "Templates"). An org admin creates
 * a workspace from a template: its hierarchy templates, approval policies, pacing rules, a shared
 * sample view and a tour per role are written in one transaction with the workspace (one
 * `workspace.created` audit_event and outbox row, plus each policy's and rule's own); the template's
 * granularities the org does not share yet are created as the workspace's own (ORG-006); `withDemoData`
 * writes the demo dataset (every row `demo = true`), which the purge deletes in one transaction.
 */

const json = (v: unknown) => v as Prisma.InputJsonValue;
const Registry = z.array(z.object({ key: z.string(), label: z.string(), dataType: z.enum(["ENUM", "TEXT", "REFERENCE", "DATE_BUCKET"]), icon: z.string(), allowedParents: z.array(z.string()), isRequiredForLeaf: z.boolean(), sortOrder: z.number(), values: z.array(z.object({ code: z.string(), label: z.string(), parentCode: z.string().optional(), externalIds: z.record(z.string(), z.string()).optional() })) }));
const Hierarchies = z.array(z.object({ name: z.string(), path: z.array(z.string()), isDefault: z.boolean() }));
const Tours = z.array(z.object({ role: z.enum(["planner", "approver", "finance", "data_admin"]), name: z.string(), steps: z.array(TourStep) }));

export function templateView(t: WorkspaceTemplate) {
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return { id: t.id, key: t.key, name: t.name, description: t.description, builtIn: t.orgId === null, counts: { dimensions: count(t.registry), hierarchyTemplates: count(t.hierarchyTemplates), policies: count(t.policies), rules: count(t.rules), savedViews: count(t.savedViews), tours: count(t.tours) } };
}

/** GET /workspace-templates (org admins): the built-in one (created during workspace creation) and the org's. */
export async function listTemplates(prisma: PrismaClient, auth: AuthContext) {
  if (!auth.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only an org admin creates workspaces");
  return withTenant(prisma, orgAdminCtx(auth), async (tx) => {
    // Read-only query: defaults are created in createWorkspace and syncDefaultTours, not on GET
    const rows = await tx.workspaceTemplate.findMany({ orderBy: [{ orgId: "asc" }, { name: "asc" }] });
    // If the org has no templates, return the built-in default in memory
    if (rows.length === 0) {
      const def = defaultAgencyTemplate();
      // Use a stable ID for the in-memory default (deterministic from the key)
      const stableId = "00000000-0000-0000-0000-000000000001";
      return [{ id: stableId, key: def.key, name: def.name, description: def.description, builtIn: true, counts: { dimensions: def.registry.length, hierarchyTemplates: def.hierarchyTemplates.length, policies: def.policies.length, rules: def.rules.length, savedViews: def.savedViews.length, tours: def.tours.length } }];
    }
    return rows.map(templateView);
  });
}

const slugify = (name: string) => name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "workspace";

/** POST /workspaces (org admins). */
export async function createWorkspace(prisma: PrismaClient, auth: AuthContext, raw: unknown, now: Date = new Date()) {
  if (!auth.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only an org admin creates workspaces");
  const started = performance.now();
  const input = parseInput(CreateWorkspaceInput, raw);
  const orgCtx = orgAdminCtx(auth);
  const template = await withTenant(prisma, orgCtx, async (tx) => {
    await ensureDefaultTemplate(tx, newId);
    // If the in-memory default ID is passed, look up the actual default template
    let templateId = input.templateId;
    if (templateId === "00000000-0000-0000-0000-000000000001") {
      const defaultTemplate = await tx.workspaceTemplate.findFirst({ where: { orgId: null, key: "default_agency" }, select: { id: true } });
      if (defaultTemplate) templateId = defaultTemplate.id;
    }
    const t = await tx.workspaceTemplate.findUnique({ where: { id: templateId } });
    if (t === null || (t.orgId !== null && t.orgId !== auth.user.orgId)) throw new DomainError("NOT_FOUND", "Workspace template not found");
    return t;
  });
  const workspaceId = newId();
  const ctx: TenantContext = { ...orgCtx, workspaceId, isOrgAdmin: true };

  const created = await withTenant(prisma, ctx, async (tx) => {
    let slug = input.slug ?? slugify(input.name);
    if (await tx.workspace.findFirst({ where: { orgId: auth.user.orgId, slug }, select: { id: true } })) {
      if (input.slug) throw new DomainError("CONFLICT", "A workspace with this slug exists", { slug });
      slug = `${slug}-${workspaceId.slice(-6)}`;
    }
    const ws = await tx.workspace.create({ data: { id: workspaceId, orgId: auth.user.orgId, slug, name: input.name, reportingCurrency: input.reportingCurrency, fiscalYearStartMonth: input.fiscalYearStartMonth } });
    const hierarchies = Hierarchies.parse(template.hierarchyTemplates);
    for (const h of hierarchies) await tx.hierarchyTemplate.create({ data: { id: newId(), workspaceId, name: h.name, path: h.path, isDefault: h.isDefault, createdBy: auth.user.id } });
    const policies = z.array(z.unknown()).parse(template.policies);
    for (const p of policies) await insertPolicy(tx, ctx, workspaceId, parseInput(CreatePolicyInput, p));
    // The rules below name library metrics (CPA, ROAS): a new org gets the defaults first.
    await ensureDefaultMetrics(tx, ctx, { id: workspaceId, orgId: auth.user.orgId });
    const rules = z.array(z.record(z.string(), z.unknown())).parse(template.rules);
    for (const r of rules) await insertRule(tx, ctx, workspaceId, parseInput(CreateRuleInput, { ...r, delivery: { inApp: true } }));
    const views = z.array(TemplateSavedView).parse(template.savedViews);
    // "shared" (not @budget/domain's SavedViewVisibility, which only covers the user-facing
    // "private" | "workspace" on POST /saved-views) is a third, system-only value a workspace
    // template's own views are seeded with (home.test.ts asserts it); the W3-11 CHECK constraint
    // on saved_view.visibility includes it for exactly this write path.
    for (const v of views) await tx.savedView.create({ data: { id: newId(), workspaceId, name: v.name, screen: v.screen, definition: json(v.definition), visibility: "shared", createdBy: auth.user.id } });
    const tours = Tours.parse(template.tours);
    for (const t of tours) await tx.tour.create({ data: { id: newId(), workspaceId, role: t.role, name: t.name, steps: json(t.steps) } });
    const summary = { templateId: template.id, template: template.key, hierarchyTemplates: hierarchies.length, policies: policies.length, rules: rules.length, savedViews: views.length, tours: tours.length };
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "workspace.created", entityType: "workspace", entityId: workspaceId, after: { name: ws.name, slug: ws.slug, ...summary }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "workspace.created", payload: { workspaceId, ...summary } });
    return { ws, summary };
  });

  // The template's granularities the org does not share yet become this workspace's own (ORG-006,
  // ADR-052): its admins can change them, and no other workspace sees them. Shared org-wide rows a
  // superadmin publishes are used as they are.
  const registry = Registry.parse(template.registry);
  const have = new Set((await withTenant(prisma, ctx, (tx) => tx.dimension.findMany({ where: { orgId: auth.user.orgId, workspaceId: null }, select: { key: true } }))).map((d) => d.key));
  const store = new InMemoryAssetStore();
  const roles: Role[] = ["ORG_ADMIN"];
  let dimensionsAdded = 0;
  for (const d of registry.filter((x) => !have.has(x.key))) {
    const dim = await createDimension(prisma, ctx, roles, { key: d.key, label: d.label, dataType: d.dataType, icon: d.icon, allowedParents: d.allowedParents.filter((p) => have.has(p) || registry.some((x) => x.key === p)), isRequiredForLeaf: d.isRequiredForLeaf, sortOrder: d.sortOrder, workspaceId }, store);
    if (d.values.length) await addValues(prisma, ctx, roles, dim.id, { values: d.values.map((v) => ({ code: v.code, label: v.label, ...(v.parentCode ? { parentCode: v.parentCode } : {}), ...(v.externalIds ? { externalIds: v.externalIds } : {}) })) });
    have.add(d.key);
    dimensionsAdded += 1;
  }

  const firstAdmin = input.firstAdmin ? await appointFirstAdmin(prisma, auth, ctx, input.firstAdmin) : null;
  const demo = input.withDemoData ? await seedDemo(prisma, auth, ctx, created.ws, now) : null;
  return { id: created.ws.id, slug: created.ws.slug, name: created.ws.name, ...created.summary, dimensionsAdded, firstAdmin, demo, elapsedMs: Math.round(performance.now() - started) };
}

/** ADR-052: the new workspace's first admin, found by email in the org or created in it, with WORKSPACE_ADMIN. */
async function appointFirstAdmin(prisma: PrismaClient, auth: AuthContext, ctx: TenantContext, who: { email: string; name: string }) {
  return withTenant(prisma, ctx, async (tx) => {
    const workspaceId = ctx.workspaceId as string;
    let user = await tx.user.findUnique({ where: { email: who.email }, select: { id: true, orgId: true } });
    if (user && user.orgId !== auth.user.orgId) throw new DomainError("CONFLICT", "That email belongs to another organisation", { email: who.email });
    if (!user) {
      user = await tx.user.create({ data: { id: newId(), orgId: auth.user.orgId, email: who.email, name: who.name }, select: { id: true, orgId: true } }).catch((e: unknown) => {
        if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "That email belongs to another organisation", { email: who.email });
        throw e;
      });
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "user.added", entityType: "user", entityId: user.id, after: { email: who.email, name: who.name }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "user.added", payload: { userId: user.id } });
    }
    const id = newId();
    await tx.roleAssignment.create({ data: { id, workspaceId, principalType: "user", principalId: user.id, role: "WORKSPACE_ADMIN", scope: {}, createdBy: auth.user.id } });
    const after = { principalType: "user", principalId: user.id, role: "WORKSPACE_ADMIN", scope: {} };
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "role.assigned", entityType: "role_assignment", entityId: id, after, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "access.changed", payload: { kind: "role.assigned", roleAssignmentId: id, ...after } });
    return { userId: user.id, email: who.email };
  });
}

async function seedDemo(prisma: PrismaClient, auth: AuthContext, ctx: TenantContext, ws: { id: string; reportingCurrency: string; fiscalYearStartMonth: number }, now: Date) {
  // W3-10: the demo year's month partitions, in short transactions of their own before the seed's.
  const period = demoPeriod(now.toISOString().slice(0, 10), ws.fiscalYearStartMonth);
  await ensurePartitions(prisma, period.start, period.end);
  return withTenant(
    prisma,
    ctx,
    async (tx) => {
      const summary = await seedDemoData(tx, { workspaceId: ws.id, orgId: auth.user.orgId, createdBy: auth.user.id, reportingCurrency: ws.reportingCurrency, fiscalYearStartMonth: ws.fiscalYearStartMonth, today: now.toISOString().slice(0, 10) }, newId);
      const { envelopeIds, ...counts } = summary;
      await audit(tx, { workspaceId: ws.id, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "workspace.demo_seeded", entityType: "workspace", entityId: ws.id, after: counts, requestId: auth.ctx.requestId });
      // Same topic as an ingest run: rollups, pacing and search pick the demo rows up.
      await outbox(tx, { workspaceId: ws.id, topic: "facts.loaded", payload: { sourceSystem: "demo", envelopeIds } });
      return counts;
    },
    { timeoutMs: 60_000 },
  );
}

/**
 * GET /workspaces/:ws/demo-data — how many demo rows the workspace still has, and T-5: whether it
 * has real budgets too (the Explorer shows demo rows only while it does not). HF-1 (audit T-5
 * follow-up): `hidden` is that same condition, named for what it means to the caller — the planner
 * is excluding demo money from every total right now, with nothing else saying so.
 */
export async function demoStatus(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const envelopes = await tx.envelope.count({ where: { workspaceId, demo: true } });
    const targets = await tx.target.count({ where: { workspaceId, demo: true } });
    const hasRealBudgets = (await tx.envelope.count({ where: { workspaceId, demo: false } })) > 0;
    const hasCampaignData =
      (
        await tx.$queryRaw<Array<{ present: boolean }>>`SELECT EXISTS(
          SELECT 1 FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid AND demo AND dimension_values ? 'campaign' AND superseded_at IS NULL
        ) AS present`
      )[0]?.present === true;
    return { envelopes, targets, hasRealBudgets, hidden: envelopes > 0 && hasRealBudgets, hasCampaignData };
  });
}

/**
 * POST /workspaces/:ws/demo-data/campaigns (EX-3, org admins only): adds campaign-level demo data
 * (and one demo experiment) to a workspace that only has the older, leaf-level monthly demo facts —
 * how the production Sandbox picks this feature up. Idempotent: a workspace that already has
 * campaign-tagged demo facts is unchanged, and nothing is audited or published for that no-op.
 */
export async function addCampaignDemoData(prisma: PrismaClient, auth: AuthContext) {
  if (!auth.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only an org admin can add demo campaign data");
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const today = new Date().toISOString().slice(0, 10);
  // W3-10: the demo period's month partitions, in a short transaction of their own before the write.
  const fiscalYearStartMonth = await withTenant(prisma, auth.ctx, (tx) => tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { fiscalYearStartMonth: true } })).then((w) => w.fiscalYearStartMonth);
  const period = demoPeriod(today, fiscalYearStartMonth);
  await ensurePartitions(prisma, period.start, period.end);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const r = await reseedCampaignDemoData(tx, { workspaceId, orgId: auth.user.orgId, createdBy: auth.user.id, today }, newId);
      if (r.alreadyPresent) return r;
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "workspace.demo_campaigns_added", entityType: "workspace", entityId: workspaceId, after: r, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "facts.loaded", payload: { sourceSystem: "demo", action: "demo.campaigns_added" } });
      return r;
    },
    { timeoutMs: 60_000 },
  );
}

/** POST /workspaces/:ws/demo-data/purge — every demo row, in one transaction. I-3: the caller must confirm. */
export async function purgeDemo(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  parseInput(PurgeDemoInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const r = await purgeDemoData(tx, workspaceId);
      const { envelopeIds, ...counts } = r;
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "workspace.demo_purged", entityType: "workspace", entityId: workspaceId, after: counts, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "registry.changed", payload: { action: "demo.purged", envelopeIds } });
      return counts;
    },
    { timeoutMs: 60_000 },
  );
}
