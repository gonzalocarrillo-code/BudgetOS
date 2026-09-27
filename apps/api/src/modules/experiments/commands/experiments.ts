import {
  ConcludeExperimentInput,
  CreateExperimentInput,
  CreateThreadInput,
  DomainError,
  EXPERIMENT_TRANSITIONS,
  LinkEnvelopeInput,
  UpdateExperimentInput,
  newId,
} from "@budget/domain";
import { audit, metricLibrary, outbox, withTenant, type Tx } from "@budget/db";
import type { Experiment, Prisma, PrismaClient } from "@prisma/client";
import { clock } from "../../../common/clock.js";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { createThreadIn } from "../../threads/commands/threads.js";
import { experimentView } from "../queries/experiments.js";

/**
 * Experiments write side (spec §25.3). Every write is one audit_event (`experiment.*`) and one
 * `experiment.changed` outbox row (search re-indexes the experiment and its envelopes). Linking a
 * TEST envelope applies the system tag `experiment`. Concluding needs a decision of 20+ characters
 * and posts it as a comment in a new thread on every linked envelope, so it lands in their
 * Decision Timeline; those threads carry their own thread.changed rows for notify.
 */

const json = (v: unknown) => v as Prisma.InputJsonValue;
const FINAL = new Set(["CONCLUDED", "ABANDONED"]);
export const EXPERIMENT_TAG = "experiment";

async function record(tx: Tx, auth: AuthContext, x: Experiment, action: string, before: unknown, envelopeIds: string[] = []) {
  await audit(tx, { workspaceId: x.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action, entityType: "experiment", entityId: x.id, before, after: experimentView(x), requestId: auth.ctx.requestId });
  await outbox(tx, { workspaceId: x.workspaceId, topic: "experiment.changed", payload: { experimentId: x.id, action, status: x.status, envelopeIds } });
}

async function load(tx: Tx, rawId: string): Promise<Experiment> {
  const x = await tx.experiment.findUnique({ where: { id: parseId(rawId) } });
  if (x === null) throw new DomainError("NOT_FOUND", "Experiment not found");
  return x;
}

async function checkMetricAndOwner(tx: Tx, auth: AuthContext, metric: string | undefined, ownerId: string | undefined) {
  if (metric !== undefined && !(await metricLibrary(tx, auth.user.orgId)).has(metric)) throw new DomainError("VALIDATION", `Unknown metric ${metric}`, { metric });
  if (ownerId !== undefined && (await tx.user.findFirst({ where: { id: ownerId, orgId: auth.user.orgId }, select: { id: true } })) === null) throw new DomainError("VALIDATION", "Owner is not a user of this organization", { ownerId });
}

/** POST /workspaces/:ws/experiments */
export async function createExperiment(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateExperimentInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    await checkMetricAndOwner(tx, auth, input.primaryMetric, input.ownerId);
    const x = await tx.experiment.create({
      data: {
        id: newId(),
        workspaceId,
        name: input.name,
        hypothesis: input.hypothesis,
        kind: input.kind,
        testFilter: json(input.testFilter),
        ...(input.controlFilter ? { controlFilter: json(input.controlFilter) } : {}),
        primaryMetric: input.primaryMetric,
        criterion: json(input.criterion),
        startDate: new Date(input.startDate),
        endDate: new Date(input.endDate),
        ownerId: input.ownerId ?? auth.user.id,
      },
    });
    await record(tx, auth, x, "experiment.created", null);
    return experimentView(x);
  });
}

/** PATCH /experiments/:id — while PLANNED, RUNNING or EVALUATING. */
export async function updateExperiment(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const input = parseInput(UpdateExperimentInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const before = await load(tx, rawId);
    if (FINAL.has(before.status)) throw new DomainError("CONFLICT", `A ${before.status.toLowerCase()} experiment cannot be edited`);
    await checkMetricAndOwner(tx, auth, input.primaryMetric, input.ownerId);
    const start = input.startDate ?? before.startDate.toISOString().slice(0, 10);
    const end = input.endDate ?? before.endDate.toISOString().slice(0, 10);
    if (start > end) throw new DomainError("VALIDATION", "startDate after endDate");
    const criterion = input.criterion ?? (before.criterion as { vs: string });
    const control = input.controlFilter === undefined ? before.controlFilter : input.controlFilter;
    const hasControlLinks = (await tx.experimentEnvelope.count({ where: { experimentId: before.id, role: "CONTROL" } })) > 0;
    if (criterion.vs === "control" && control === null && !hasControlLinks) throw new DomainError("VALIDATION", "A vs-control criterion needs a control scope or a CONTROL envelope");
    const x = await tx.experiment.update({
      where: { id: before.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.testFilter !== undefined ? { testFilter: json(input.testFilter) } : {}),
        ...(input.controlFilter !== undefined ? { controlFilter: input.controlFilter === null ? (null as unknown as Prisma.InputJsonValue) : json(input.controlFilter) } : {}),
        ...(input.primaryMetric !== undefined ? { primaryMetric: input.primaryMetric } : {}),
        ...(input.criterion !== undefined ? { criterion: json(input.criterion) } : {}),
        ...(input.startDate !== undefined ? { startDate: new Date(input.startDate) } : {}),
        ...(input.endDate !== undefined ? { endDate: new Date(input.endDate) } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      },
    });
    await record(tx, auth, x, "experiment.updated", experimentView(before));
    return experimentView(x);
  });
}

/** POST /experiments/:id/link { envelopeId, role } — a TEST envelope is tagged `experiment`. */
export async function linkEnvelope(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const input = parseInput(LinkEnvelopeInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const x = await load(tx, rawId);
    if (FINAL.has(x.status)) throw new DomainError("CONFLICT", `A ${x.status.toLowerCase()} experiment cannot take new envelopes`);
    const env = await tx.envelope.findFirst({ where: { id: input.envelopeId, workspaceId: x.workspaceId }, select: { id: true } });
    if (env === null) throw new DomainError("NOT_FOUND", "Envelope not found");
    assertInScope(auth, "envelope.edit_draft", await envelopeScopeTarget(tx, env.id));
    const previous = await tx.experimentEnvelope.findUnique({ where: { experimentId_envelopeId: { experimentId: x.id, envelopeId: env.id } } });
    await tx.experimentEnvelope.upsert({
      where: { experimentId_envelopeId: { experimentId: x.id, envelopeId: env.id } },
      create: { experimentId: x.id, envelopeId: env.id, workspaceId: x.workspaceId, role: input.role },
      update: { role: input.role },
    });
    let tagged = false;
    if (input.role === "TEST") {
      const tag =
        (await tx.tag.findUnique({ where: { workspaceId_name: { workspaceId: x.workspaceId, name: EXPERIMENT_TAG } } })) ??
        (await tx.tag.create({ data: { id: newId(), workspaceId: x.workspaceId, name: EXPERIMENT_TAG, kind: "system", createdBy: auth.user.id } }));
      tagged = (await tx.taggable.createMany({ data: [{ workspaceId: x.workspaceId, tagId: tag.id, entityType: "envelope", entityId: env.id, taggedBy: auth.user.id }], skipDuplicates: true })).count > 0;
    }
    await audit(tx, { workspaceId: x.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "experiment.linked", entityType: "experiment", entityId: x.id, before: previous ? { envelopeId: env.id, role: previous.role } : null, after: { envelopeId: env.id, role: input.role, tagged }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId: x.workspaceId, topic: "experiment.changed", payload: { experimentId: x.id, action: "experiment.linked", status: x.status, envelopeIds: [env.id] } });
    return { experimentId: x.id, envelopeId: env.id, role: input.role, tagged };
  });
}

/** POST /experiments/:id/{start,evaluate,abandon} */
export async function transitionExperiment(prisma: PrismaClient, auth: AuthContext, rawId: string, move: "start" | "evaluate" | "abandon") {
  const rule = EXPERIMENT_TRANSITIONS[move];
  return withTenant(prisma, auth.ctx, async (tx) => {
    const before = await load(tx, rawId);
    if (!rule.from.includes(before.status)) throw new DomainError("CONFLICT", `Cannot ${move} a ${before.status.toLowerCase()} experiment`, { status: before.status, allowedFrom: rule.from });
    const x = await tx.experiment.update({ where: { id: before.id }, data: { status: rule.to } });
    await record(tx, auth, x, `experiment.${rule.to.toLowerCase()}`, { status: before.status });
    return experimentView(x);
  });
}

/**
 * POST /experiments/:id/conclude { decision } — RUNNING or EVALUATING, with at least one linked
 * envelope: the decision is posted as a comment on each of them (their Decision Timeline).
 */
export async function concludeExperiment(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const input = parseInput(ConcludeExperimentInput, raw);
  const rule = EXPERIMENT_TRANSITIONS.conclude;
  return withTenant(prisma, auth.ctx, async (tx) => {
    const before = await load(tx, rawId);
    if (!rule.from.includes(before.status)) throw new DomainError("CONFLICT", `Cannot conclude a ${before.status.toLowerCase()} experiment`, { status: before.status, allowedFrom: rule.from });
    const links = await tx.experimentEnvelope.findMany({ where: { experimentId: before.id }, orderBy: { envelopeId: "asc" } });
    if (links.length === 0) throw new DomainError("VALIDATION", "Link at least one envelope before concluding: the decision is posted on the linked envelopes");
    const x = await tx.experiment.update({ where: { id: before.id }, data: { status: rule.to, decision: input.decision, decidedBy: auth.user.id, decidedAt: clock.now() } });
    const threads: Array<{ envelopeId: string; threadId: string; commentId: string }> = [];
    for (const link of links) {
      const t = await createThreadIn(
        tx,
        auth,
        x.workspaceId,
        CreateThreadInput.parse({ anchorType: "envelope", anchorId: link.envelopeId, title: `Experiment concluded: ${x.name}`, firstComment: { bodyMd: `**Decision (${link.role === "TEST" ? "test" : "control"}):** ${input.decision}` } }),
      );
      threads.push({ envelopeId: link.envelopeId, threadId: t.id, commentId: t.comments[0]?.id ?? "" });
    }
    await audit(tx, { workspaceId: x.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "experiment.concluded", entityType: "experiment", entityId: x.id, before: { status: before.status }, after: { ...experimentView(x), threads }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId: x.workspaceId, topic: "experiment.changed", payload: { experimentId: x.id, action: "experiment.concluded", status: x.status, envelopeIds: links.map((l) => l.envelopeId) } });
    return { ...experimentView(x), threads };
  });
}

