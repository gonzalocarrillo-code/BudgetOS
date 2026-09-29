/**
 * Every outbox topic, and the workers that consume it besides the search indexer, which takes all
 * of them (spec §19). The outbox publisher needs a Pub/Sub topic `budget-os.<topic>` for each one
 * (a missing topic fails the whole batch, ADR-010); the local runner polls the topics of the
 * workers it stands in for; GCP's topics and push subscriptions are to be generated from this list
 * (docs/SLACK_TOOLSET_PLAN.md §3.12). apps/workers/src/outbox-topics.test.ts fails when code writes
 * a topic that is not declared here, or when a declared one is no longer written.
 */
export type OutboxConsumer = "ingest" | "rollup" | "notify" | "export";

export const OUTBOX_TOPICS = {
  "access.changed": [],
  "alert.changed": ["notify"],
  "alert.triggered": ["notify"],
  "allocation.changed": [],
  "approval.changed": ["rollup", "notify"],
  "baseline.changed": [],
  "baseline.saved": [],
  "budget.changed": ["rollup"],
  "experiment.changed": [],
  "export.completed": [],
  "export.requested": ["export"],
  "facts.loaded": ["rollup"],
  "facts.pruned": [],
  "ingest.failed": [],
  "ingest.requested": ["ingest"],
  "integrity.alert": [],
  "mapping_profile.changed": [],
  "mapping_synonym.changed": [],
  "naming.changed": ["rollup"],
  "notifications.read": [],
  "period.changed": [],
  "period.closed": ["rollup"],
  "period.restated": ["rollup"],
  "policy.changed": [],
  "registry.changed": ["rollup"],
  "rule.changed": [],
  "slack.settings.changed": [],
  "slack.test": ["notify"],
  "source.changed": [],
  "subscription.changed": [],
  "tag.changed": [],
  "target.changed": [],
  "thread.changed": ["notify"],
  "tour.changed": [],
  "tour.completed": [],
  "tour.dismissed": [],
  "uploads.pruned": [],
  "user.added": [],
  "user.updated": [],
  "view.changed": [],
  "workspace.changed": [],
  "workspace.created": [],
  "workspace.deleted": [],
  "workspace.purged": [],
} as const satisfies Record<string, readonly OutboxConsumer[]>;

export type OutboxTopic = keyof typeof OUTBOX_TOPICS;

/** The topics a worker subscribes to, in the list's order. */
export function topicsFor(consumer: OutboxConsumer): OutboxTopic[] {
  return (Object.keys(OUTBOX_TOPICS) as OutboxTopic[]).filter((t) => (OUTBOX_TOPICS[t] as readonly OutboxConsumer[]).includes(consumer));
}
