import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { claimOutbox, markOutboxPublished, type OutboxRow } from "@budget/db";
import { PubSub, type Topic } from "@google-cloud/pubsub";
import { PrismaClient } from "@prisma/client";
import { log } from "./log.js";

/**
 * Outbox publisher (spec §19): Cloud Run service, one instance minimum, a loop every 500 ms.
 * Claims unpublished rows (FOR UPDATE SKIP LOCKED), publishes each to `budget-os.<topic>` with
 * ordering key workspace_id, then marks them published in the same transaction. A crash between
 * publish and commit republishes those rows: delivery is at least once, and subscribers dedupe on
 * the outbox id (processed_event, see consumer.ts). Connects as budget_publisher (ADR-010).
 */

export interface OutboxMessage {
  topic: string; // Pub/Sub topic name, `budget-os.<outbox topic>`
  orderingKey: string;
  data: Buffer;
  attributes: { outboxId: string; workspaceId: string; orgId: string; topic: string };
}

export interface EventPublisher {
  publish(message: OutboxMessage): Promise<string>;
}

export const BATCH_LIMIT = 500;
export const LOOP_MS = 500;

export function toMessage(row: OutboxRow): OutboxMessage {
  if (row.workspaceId === null || row.orgId === null) throw new Error(`outbox ${row.id} has no workspace`);
  return {
    topic: `budget-os.${row.topic}`,
    orderingKey: row.workspaceId,
    data: Buffer.from(JSON.stringify(row.payload)),
    attributes: { outboxId: row.id, workspaceId: row.workspaceId, orgId: row.orgId, topic: row.topic },
  };
}

/**
 * One publisher pass. Rows are published in id order; if a publish fails the transaction rolls
 * back and every row of the batch stays unpublished for the next pass (earlier rows of the batch
 * may be delivered twice, which consumers absorb).
 */
export async function publishBatch(db: PrismaClient, publisher: EventPublisher, limit = BATCH_LIMIT): Promise<{ published: string[] }> {
  return db.$transaction(
    async (tx) => {
      const rows = await claimOutbox(tx, limit);
      for (const row of rows) await publisher.publish(toMessage(row));
      if (rows.length) await markOutboxPublished(tx, rows.map((r) => r.id));
      return { published: rows.map((r) => r.id) };
    },
    { timeout: 60_000 },
  );
}

/** Runs passes until `signal` aborts: straight away while batches are full, else every LOOP_MS. */
export async function runPublisher(db: PrismaClient, publisher: EventPublisher, signal: AbortSignal, loopMs = LOOP_MS): Promise<void> {
  while (!signal.aborted) {
    let full = false;
    try {
      const { published } = await publishBatch(db, publisher);
      full = published.length === BATCH_LIMIT;
      if (published.length) log.info({ count: published.length, first: published[0], last: published.at(-1) }, "outbox published");
    } catch (error) {
      log.error({ err: error }, "outbox publish pass failed; rows stay unpublished");
    }
    if (!full) await new Promise((resolve) => setTimeout(resolve, loopMs));
  }
}

/** Google Cloud Pub/Sub with message ordering (topics are created by Terraform, spec §20). */
export class PubSubPublisher implements EventPublisher {
  private readonly topics = new Map<string, Topic>();
  constructor(private readonly client: PubSub = new PubSub()) {}

  async publish(m: OutboxMessage): Promise<string> {
    let topic = this.topics.get(m.topic);
    if (topic === undefined) {
      topic = this.client.topic(m.topic, { messageOrdering: true });
      this.topics.set(m.topic, topic);
    }
    try {
      return await topic.publishMessage({ data: m.data, orderingKey: m.orderingKey, attributes: m.attributes });
    } catch (error) {
      // A failed publish pauses its ordering key; resume so the next pass can retry it.
      topic.resumePublishing(m.orderingKey);
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const url = process.env["PUBLISHER_DATABASE_URL"];
  if (!url) throw new Error("PUBLISHER_DATABASE_URL is required");
  const db = new PrismaClient({ datasources: { db: { url } } });
  const stop = new AbortController();
  // Cloud Run needs a listening port; /healthz is the liveness probe.
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/healthz" ? 200 : 404).end();
  }).listen(Number(process.env["PORT"] ?? 8080));
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => stop.abort());
  log.info("outbox publisher started");
  await runPublisher(db, new PubSubPublisher(), stop.signal);
  server.close();
  await db.$disconnect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    log.fatal({ err: error }, "outbox publisher crashed");
    process.exit(1);
  });
}
