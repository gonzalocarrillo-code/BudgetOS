import { z } from "zod";
import type { OutboxTopic } from "./outbox-topics.js";

/**
 * I-29: outbox payloads are free-form JSON until a handler reads them. These schemas say what the
 * roll-up, search-indexer and notify (in-app, Slack) handlers expect on the topics they act on
 * (apps/workers/src/{rollup/rollup,search-indexer/indexer,notify/in-app,notify/slack}.ts). Every
 * field is optional and every schema is `.passthrough()`: a payload can carry more than one
 * handler reads, and an older row may be missing a field a newer writer always sets. The goal is a
 * parse failure — a handler failure, retried with backoff like any other (local-runner.ts) — in
 * place of `undefined` silently reaching a Prisma `where`.
 */

const uuid = z.string().uuid();
const uuidArray = z.array(uuid);

export const BudgetChangedPayload = z
  .object({
    kind: z.string().optional(),
    envelopeId: uuid.optional(),
    envelopeIds: uuidArray.optional(),
    sourceId: uuid.optional(),
    sourceIds: uuidArray.optional(),
    targetId: uuid.optional(),
    partIds: uuidArray.optional(),
    versionIds: uuidArray.optional(),
    bulkChangeId: uuid.optional(),
    requestId: uuid.optional(),
  })
  .passthrough();
export type BudgetChangedPayload = z.infer<typeof BudgetChangedPayload>;

export const FactsLoadedPayload = z.object({ envelopeIds: uuidArray.optional() }).passthrough();
export type FactsLoadedPayload = z.infer<typeof FactsLoadedPayload>;

export const NamingChangedPayload = z.object({ kind: z.string().optional() }).passthrough();
export type NamingChangedPayload = z.infer<typeof NamingChangedPayload>;

export const RegistryChangedPayload = z.object({ dimensionId: uuid.optional(), envelopeIds: uuidArray.optional() }).passthrough();
export type RegistryChangedPayload = z.infer<typeof RegistryChangedPayload>;

/** period.closed and period.restated share this shape (rollup.ts, indexer.ts). */
export const PeriodClosurePayload = z.object({ closureId: uuid.optional() }).passthrough();
export type PeriodClosurePayload = z.infer<typeof PeriodClosurePayload>;

export const TargetChangedPayload = z.object({ targetId: uuid.optional() }).passthrough();
export type TargetChangedPayload = z.infer<typeof TargetChangedPayload>;

/** approval.changed and approval.reminded share this shape (rollup.ts, indexer.ts, notify/in-app.ts, notify/slack.ts). */
export const ApprovalEventPayload = z
  .object({
    requestId: uuid.optional(),
    action: z.string().optional(),
    status: z.string().optional(),
    comment: z.string().nullable().optional(),
    by: uuid.optional(),
  })
  .passthrough();
export type ApprovalEventPayload = z.infer<typeof ApprovalEventPayload>;

/** alert.triggered and alert.changed share this shape (indexer.ts, notify/in-app.ts, notify/slack.ts). */
export const AlertEventPayload = z.object({ alertId: uuid.optional(), reopened: z.boolean().optional() }).passthrough();
export type AlertEventPayload = z.infer<typeof AlertEventPayload>;

/** spec §13. notify/in-app.ts already parsed this strictly; it is reused from here instead of redeclared. */
export const ThreadChangedPayload = z
  .object({
    threadId: uuid.optional(),
    commentId: uuid.nullable().optional(),
    action: z.string().optional(),
    actorId: uuid.optional(),
    anchorType: z.string().optional(),
    anchorId: uuid.optional(),
    mentions: z.array(z.object({ type: z.enum(["user", "group"]), id: uuid })).optional(),
  })
  .passthrough();
export type ThreadChangedPayload = z.infer<typeof ThreadChangedPayload>;

export const TagChangedPayload = z
  .object({
    tagId: uuid.optional(),
    mergedFrom: z.object({ id: uuid.optional() }).passthrough().optional(),
    entities: z.array(z.object({ type: z.string(), id: uuid })).optional(),
  })
  .passthrough();
export type TagChangedPayload = z.infer<typeof TagChangedPayload>;

export const ExperimentChangedPayload = z.object({ experimentId: uuid.optional(), envelopeIds: uuidArray.optional() }).passthrough();
export type ExperimentChangedPayload = z.infer<typeof ExperimentChangedPayload>;

/** workspace.created carries no fields the search indexer reads (it seeds the settings catalog instead). */
export const WorkspaceCreatedPayload = z.object({}).passthrough();
export type WorkspaceCreatedPayload = z.infer<typeof WorkspaceCreatedPayload>;

/** requestedBy here is the requester's display name (notify/slack.ts's testMessage), not an id. */
export const SlackTestPayload = z.object({ channel: z.string().optional(), requestedBy: z.string().optional() }).passthrough();
export type SlackTestPayload = z.infer<typeof SlackTestPayload>;

/** A topic with no schema below falls back to this: any JSON object, so a scalar or array payload still fails loudly instead of reaching a handler as `{}`. */
const OpenPayload = z.record(z.string(), z.unknown());

/** Every topic the roll-up, search-indexer or notify handlers read a field from (I-29). A topic with no entry is untouched by those handlers and validated against OpenPayload only. */
export const OUTBOX_PAYLOAD_SCHEMAS: Partial<Record<OutboxTopic, z.ZodTypeAny>> = {
  "budget.changed": BudgetChangedPayload,
  "facts.loaded": FactsLoadedPayload,
  "naming.changed": NamingChangedPayload,
  "registry.changed": RegistryChangedPayload,
  "period.closed": PeriodClosurePayload,
  "period.restated": PeriodClosurePayload,
  "target.changed": TargetChangedPayload,
  "approval.changed": ApprovalEventPayload,
  "approval.reminded": ApprovalEventPayload,
  "alert.triggered": AlertEventPayload,
  "alert.changed": AlertEventPayload,
  "thread.changed": ThreadChangedPayload,
  "tag.changed": TagChangedPayload,
  "experiment.changed": ExperimentChangedPayload,
  "workspace.created": WorkspaceCreatedPayload,
  "slack.test": SlackTestPayload,
};

/**
 * Parses an outbox row's payload against its topic's schema (the open fallback for a topic with
 * none declared above). Throws a ZodError on a mismatch; callers run this inside the consumer's
 * handler so that failure is a handler failure like any other — attempts/backoff in local-runner.ts,
 * never an unhandled crash (I-29).
 */
export function parseOutboxPayload(topic: string, payload: unknown): Record<string, unknown> {
  const schema = (OUTBOX_PAYLOAD_SCHEMAS as Record<string, z.ZodTypeAny | undefined>)[topic] ?? OpenPayload;
  return schema.parse(payload ?? {}) as Record<string, unknown>;
}
