import { CreateNamingTemplateInput, DomainError, NamingPreviewInput, UpdateNamingTemplateInput, newId, renderTemplate, type NamingChip, type NamingTemplateT } from "@budget/domain";
import { audit, dimensionLabels, fiscalLabel, outbox, recomputeNames, withTenant, type Tx } from "@budget/db";
import type { NamingTemplate, Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";

/**
 * Naming templates (spec §24, T-036): one active `display` and one active `match_key` template per
 * workspace. Each write is one audit_event and one `naming.changed` outbox row (the rollup worker
 * recomputes every envelope's display name and match key); small workspaces are recomputed in the
 * same transaction too, so the change shows at once.
 */

const INLINE_RECOMPUTE = 20_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function namingView(t: NamingTemplate) {
  return { id: t.id, kind: t.kind, chips: t.chips as NamingChip[], casing: t.casing, whitespace: t.whitespace, stripAccents: t.stripAccents, version: t.version, isActive: t.isActive, createdBy: t.createdBy, createdAt: t.createdAt.toISOString() };
}

async function recordAndRecompute(tx: Tx, auth: AuthContext, t: NamingTemplate, action: string, before: unknown) {
  await audit(tx, { workspaceId: t.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action, entityType: "naming_template", entityId: t.id, before, after: namingView(t), requestId: auth.ctx.requestId });
  await outbox(tx, { workspaceId: t.workspaceId, topic: "naming.changed", payload: { templateId: t.id, kind: t.kind, action } });
  const envelopes = await tx.envelope.count({ where: { workspaceId: t.workspaceId } });
  return envelopes <= INLINE_RECOMPUTE ? { recomputed: await recomputeNames(tx, t.workspaceId), queued: false } : { recomputed: 0, queued: true };
}

/** GET /workspaces/:ws/naming-templates: the active one of each kind first, then earlier ones. */
export function listNamingTemplates(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => (await tx.namingTemplate.findMany({ where: { workspaceId }, orderBy: [{ isActive: "desc" }, { kind: "asc" }, { createdAt: "desc" }] })).map(namingView));
}

/** POST /workspaces/:ws/naming-templates: the new active template of its kind. */
export async function createNamingTemplate(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateNamingTemplateInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      await assertDimensions(tx, auth, workspaceId, input.chips);
      await tx.namingTemplate.updateMany({ where: { workspaceId, kind: input.kind, isActive: true }, data: { isActive: false } });
      const t = await tx.namingTemplate.create({ data: { id: newId(), workspaceId, kind: input.kind, chips: input.chips as Prisma.InputJsonValue, casing: input.casing, whitespace: input.whitespace, stripAccents: input.stripAccents, createdBy: auth.user.id } });
      return { ...namingView(t), ...(await recordAndRecompute(tx, auth, t, "naming.created", null)) };
    },
    { timeoutMs: 120_000 },
  );
}

/** PATCH /naming-templates/:id: a new version (version + 1); switching one on retires the other of its kind. */
export async function updateNamingTemplate(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const input = parseInput(UpdateNamingTemplateInput, raw);
  const id = parseId(rawId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const current = await tx.namingTemplate.findUnique({ where: { id } });
      if (current === null) throw new DomainError("NOT_FOUND", "Naming template not found");
      if (input.chips) await assertDimensions(tx, auth, current.workspaceId, input.chips);
      if (input.isActive === true && !current.isActive) await tx.namingTemplate.updateMany({ where: { workspaceId: current.workspaceId, kind: current.kind, isActive: true }, data: { isActive: false } });
      const t = await tx.namingTemplate.update({
        where: { id },
        data: {
          ...(input.chips ? { chips: input.chips as Prisma.InputJsonValue } : {}),
          ...(input.casing ? { casing: input.casing } : {}),
          ...(input.whitespace ? { whitespace: input.whitespace } : {}),
          ...(input.stripAccents === undefined ? {} : { stripAccents: input.stripAccents }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
          version: { increment: 1 },
        },
      });
      return { ...namingView(t), ...(await recordAndRecompute(tx, auth, t, "naming.updated", namingView(current))) };
    },
    { timeoutMs: 120_000 },
  );
}

/** Every dimension chip names a granularity of this workspace. */
async function assertDimensions(tx: Tx, auth: AuthContext, workspaceId: string, chips: NamingChip[]) {
  const keys = chips.flatMap((c) => (c.type === "dimension" ? [c.key] : []));
  if (!keys.length) return;
  const known = new Set((await tx.dimension.findMany({ where: { orgId: auth.user.orgId, key: { in: keys }, OR: [{ workspaceId: null }, { workspaceId }] }, select: { key: true } })).map((d) => d.key));
  const unknown = keys.filter((k) => !known.has(k));
  if (unknown.length) throw new DomainError("VALIDATION", `Unknown dimension ${unknown.join(", ")}`, { unknown });
}

/**
 * POST /naming-templates/preview: the template (saved or not) rendered for sample envelopes — the
 * given ones, else five live leaves — so the builder shows what it will produce. Nothing is saved.
 */
export async function previewNamingTemplate(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(NamingPreviewInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { orgId: true, fiscalYearStartMonth: true } });
    const select = { id: true, name: true, dimensionValues: true, startDate: true, endDate: true } as const;
    const samples = input.sampleEnvelopeIds.length
      ? await tx.envelope.findMany({ where: { workspaceId, id: { in: input.sampleEnvelopeIds } }, select })
      : await tx.envelope.findMany({ where: { workspaceId, status: { not: "ARCHIVED" }, children: { none: { status: { not: "ARCHIVED" } } } }, select, orderBy: { name: "asc" }, take: 5 });
    const labels = await dimensionLabels(tx, ws.orgId, workspaceId);
    const t: NamingTemplateT = input.template;
    return {
      previews: samples.map((e) => {
        const dv = e.dimensionValues as Record<string, string>;
        const dims = Object.fromEntries(Object.entries(dv).map(([k, code]) => [k, { code, label: labels.get(k)?.get(code) ?? code }]));
        const start = iso(e.startDate);
        return { envelopeId: e.id, name: e.name, rendered: renderTemplate(t, { dims, period: { start, end: iso(e.endDate), fiscalLabel: fiscalLabel(start, ws.fiscalYearStartMonth) } }) };
      }),
    };
  });
}
