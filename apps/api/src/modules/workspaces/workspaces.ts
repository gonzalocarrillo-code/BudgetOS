import { CreatePolicyInput, CreateRuleInput, CreateWorkspaceInput, DomainError, TemplateSavedView, TourStep, newId, type Role } from "@budget/domain";
import { audit, ensureDefaultTemplate, ensureDefaultTours, outbox, purgeDemoData, seedDemoData, withTenant, type TenantContext } from "@budget/db";
import type { Prisma, PrismaClient, WorkspaceTemplate } from "@prisma/client";
import { z } from "zod";
import { parseInput, requireWorkspace } from "../../common/parse-input.js";
import { orgAdminCtx, type AuthContext } from "../../common/tenant.js";
import { insertPolicy } from "../approvals/commands/policies.js";
import { insertRule } from "../pacing/rules.js";
import { InMemoryAssetStore } from "../registry/assets/asset-store.js";
import { addValues } from "../registry/commands/add-values.js";
import { createDimension } from "../registry/commands/create-dimension.js";

/**
 * Workspace templates and new workspaces (spec §27, plan §11.7 "Templates"). An org admin creates
 * a workspace from a template: its hierarchy templates, approval policies, pacing rules, a shared
 * sample view and a tour per role are written in one transaction with the workspace (one
 * `workspace.created` audit_event and outbox row, plus each policy's and rule's own); org-wide
 * dimensions the org does not have yet are added from the template's registry; `withDemoData`
 * writes the demo dataset (every row `demo = true`), which the purge deletes in one transaction.
 */

const json = (v: unknown) => v as Prisma.InputJsonValue;
const Registry = z.array(z.object({ key: z.string(), label: z.string(), dataType: z.enum(["ENUM", "TEXT", "REFERENCE", "DATE_BUCKET"]), icon: z.string(), allowedParents: z.array(z.string()), isRequiredForLeaf: z.boolean(), sortOrder: z.number(), values: z.array(z.object({ code: z.string(), label: z.string(), parentCode: z.string().optional() })) }));
const Hierarchies = z.array(z.object({ name: z.string(), path: z.array(z.string()), isDefault: z.boolean() }));
const Tours = z.array(z.object({ role: z.enum(["planner", "approver", "finance", "data_admin"]), name: z.string(), steps: z.array(TourStep) }));

export function templateView(t: WorkspaceTemplate) {
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return { id: t.id, key: t.key, name: t.name, description: t.description, builtIn: t.orgId === null, counts: { dimensions: count(t.registry), hierarchyTemplates: count(t.hierarchyTemplates), policies: count(t.policies), rules: count(t.rules), savedViews: count(t.savedViews), tours: count(t.tours) } };
}

/** GET /workspace-templates (org admins): the built-in one (written from the defaults) and the org's. */
export async function listTemplates(prisma: PrismaClient, auth: AuthContext) {
  if (!auth.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only an org admin creates workspaces");
  return withTenant(prisma, orgAdminCtx(auth), async (tx) => {
    await ensureDefaultTemplate(tx, newId);
    await ensureDefaultTours(tx, newId);
    return (await tx.workspaceTemplate.findMany({ orderBy: [{ orgId: "asc" }, { name: "asc" }] })).map(templateView);
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
    const t = await tx.workspaceTemplate.findUnique({ where: { id: input.templateId } });
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
    const rules = z.array(z.record(z.string(), z.unknown())).parse(template.rules);
    for (const r of rules) await insertRule(tx, ctx, workspaceId, parseInput(CreateRuleInput, { ...r, delivery: { inApp: true } }));
    const views = z.array(TemplateSavedView).parse(template.savedViews);
    for (const v of views) await tx.savedView.create({ data: { id: newId(), workspaceId, name: v.name, screen: v.screen, definition: json(v.definition), visibility: "shared", createdBy: auth.user.id } });
    const tours = Tours.parse(template.tours);
    for (const t of tours) await tx.tour.create({ data: { id: newId(), workspaceId, role: t.role, name: t.name, steps: json(t.steps) } });
    const summary = { templateId: template.id, template: template.key, hierarchyTemplates: hierarchies.length, policies: policies.length, rules: rules.length, savedViews: views.length, tours: tours.length };
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "workspace.created", entityType: "workspace", entityId: workspaceId, after: { name: ws.name, slug: ws.slug, ...summary }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "workspace.created", payload: { workspaceId, ...summary } });
    return { ws, summary };
  });

  // Org-wide dimensions the org does not have yet, from the template's registry (a no-op for an org that has them).
  const registry = Registry.parse(template.registry);
  const have = new Set((await withTenant(prisma, ctx, (tx) => tx.dimension.findMany({ where: { orgId: auth.user.orgId }, select: { key: true } }))).map((d) => d.key));
  const store = new InMemoryAssetStore();
  const roles: Role[] = ["ORG_ADMIN"];
  let dimensionsAdded = 0;
  for (const d of registry.filter((x) => !have.has(x.key))) {
    const dim = await createDimension(prisma, ctx, roles, { key: d.key, label: d.label, dataType: d.dataType, icon: d.icon, allowedParents: d.allowedParents.filter((p) => have.has(p) || registry.some((x) => x.key === p)), isRequiredForLeaf: d.isRequiredForLeaf, sortOrder: d.sortOrder, workspaceId: null }, store);
    if (d.values.length) await addValues(prisma, ctx, roles, dim.id, { values: d.values.map((v) => ({ code: v.code, label: v.label, ...(v.parentCode ? { parentCode: v.parentCode } : {}) })) });
    have.add(d.key);
    dimensionsAdded += 1;
  }

  const demo = input.withDemoData ? await seedDemo(prisma, auth, ctx, created.ws, now) : null;
  return { id: created.ws.id, slug: created.ws.slug, name: created.ws.name, ...created.summary, dimensionsAdded, demo, elapsedMs: Math.round(performance.now() - started) };
}

async function seedDemo(prisma: PrismaClient, auth: AuthContext, ctx: TenantContext, ws: { id: string; reportingCurrency: string; fiscalYearStartMonth: number }, now: Date) {
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

/** GET /workspaces/:ws/demo-data — how many demo rows the workspace still has. */
export async function demoStatus(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => ({ envelopes: await tx.envelope.count({ where: { workspaceId, demo: true } }), targets: await tx.target.count({ where: { workspaceId, demo: true } }) }));
}

/** POST /workspaces/:ws/demo-data/purge — every demo row, in one transaction. */
export async function purgeDemo(prisma: PrismaClient, auth: AuthContext) {
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
