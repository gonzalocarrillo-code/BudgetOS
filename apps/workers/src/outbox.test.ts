import "./test-support/env.js";
import { randomUUID } from "node:crypto";
import { insertNotification, outbox, withTenant, type TenantContext } from "@budget/db";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePush, handleOnce, type EventHandler, type OutboxEvent } from "./consumer.js";
import { publishBatch, type EventPublisher, type OutboxMessage } from "./outbox-publisher.js";

/**
 * T-016 done-when: exactly-once with duplicate delivery. The publisher delivers at least once
 * (a failed pass republishes); the consumer applies each outbox id once per consumer, however many
 * times Pub/Sub delivers it. Publishing to a live topic is phase 20; here the publisher is in memory.
 */

const url = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set (packages/db/.env)`);
  return v;
};
const owner = new PrismaClient({ datasources: { db: { url: url("DATABASE_URL") } } });
const app = new PrismaClient({ datasources: { db: { url: url("APP_DATABASE_URL") } } });
const publisherDb = new PrismaClient({ datasources: { db: { url: url("PUBLISHER_DATABASE_URL") } } });

const orgId = randomUUID();
const ws = randomUUID();
const otherWs = randomUUID();
const userId = randomUUID();
const ctx = (workspaceId = ws): TenantContext => ({ workspaceId, orgId, userId, isOrgAdmin: false, actorType: "user", requestId: `t016-${randomUUID()}` });

class MemoryPublisher implements EventPublisher {
  readonly sent: OutboxMessage[] = [];
  constructor(private readonly failOn?: (m: OutboxMessage) => boolean) {}
  async publish(m: OutboxMessage): Promise<string> {
    this.sent.push(m);
    if (this.failOn?.(m)) throw new Error(`publish failed for ${m.attributes.outboxId}`);
    return `msg-${m.attributes.outboxId}-${this.sent.length}`;
  }
  mine(workspaceId = ws) {
    return this.sent.filter((m) => m.attributes.workspaceId === workspaceId);
  }
}

/** The app write path: one outbox row per call, inside withTenant as budget_app. */
async function emit(n: number, workspaceId = ws, topic = "budget.changed"): Promise<string[]> {
  const before = new Set(await unpublished(workspaceId));
  await withTenant(app, ctx(workspaceId), async (tx) => {
    for (let i = 0; i < n; i += 1) await outbox(tx, { workspaceId, topic, payload: { seq: i, envelopeId: randomUUID() } });
  });
  return (await unpublished(workspaceId)).filter((id) => !before.has(id));
}
async function unpublished(workspaceId = ws): Promise<string[]> {
  const rows = await owner.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text AS id FROM outbox WHERE workspace_id = $1::uuid AND published_at IS NULL ORDER BY id`, workspaceId);
  return rows.map((r) => r.id);
}
/** Passes until one publishes nothing (other suites may have rows queued too). */
async function drain(publisher: EventPublisher, limit?: number): Promise<void> {
  for (let guard = 0; guard < 100; guard += 1) {
    if ((await publishBatch(publisherDb, publisher, limit)).published.length === 0) return;
  }
  throw new Error("outbox did not drain");
}
/** A Pub/Sub push body for a published message, as Cloud Run would receive it. */
const push = (m: OutboxMessage, messageId: string = randomUUID()) => ({
  message: { data: m.data.toString("base64"), attributes: m.attributes, messageId },
  subscription: "projects/budget-os-test/subscriptions/test",
});
async function notifications(kind: string): Promise<number> {
  const rows = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM notification WHERE workspace_id = $1::uuid AND kind = $2`, ws, kind);
  return Number(rows[0]?.n ?? 0);
}
const notifyHandler =
  (kind: string): EventHandler =>
  async (tx, event: OutboxEvent) => {
    await insertNotification(tx, { workspaceId: event.workspaceId, userId, kind, payload: { outboxId: event.outboxId } });
  };

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t016" } });
  await owner.workspace.createMany({
    data: [
      { id: ws, orgId, slug: `t016-${ws}`, name: "T-016", reportingCurrency: "USD" },
      { id: otherWs, orgId, slug: `t016-${otherWs}`, name: "T-016 other", reportingCurrency: "USD" },
    ],
  });
  await owner.user.create({ data: { id: userId, orgId, email: `${userId}@t016.test`, name: "T-016", googleSub: `g-${userId}` } });
});

afterAll(async () => {
  for (const sql of [
    `DELETE FROM notification WHERE workspace_id = ANY($1::uuid[])`,
    `DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = ANY($1::uuid[]))`,
    `DELETE FROM outbox WHERE workspace_id = ANY($1::uuid[])`,
  ]) {
    await owner.$executeRawUnsafe(sql, [ws, otherWs]);
  }
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect(), publisherDb.$disconnect()]);
});

describe("outbox publisher (spec §19)", () => {
  it("publishes every row once, in id order, to budget-os.<topic> keyed by workspace, and marks it published", async () => {
    const ids = await emit(3);
    const p = new MemoryPublisher();
    await drain(p);
    const mine = p.mine();
    expect(mine.map((m) => m.attributes.outboxId)).toEqual(ids);
    expect(mine.every((m) => m.topic === "budget-os.budget.changed" && m.orderingKey === ws && m.attributes.orgId === orgId && m.attributes.topic === "budget.changed")).toBe(true);
    expect(JSON.parse(mine[0]?.data.toString() ?? "{}")).toMatchObject({ seq: 0 });
    expect(await unpublished()).toEqual([]);
    const again = new MemoryPublisher();
    await drain(again);
    expect(again.mine()).toEqual([]);
  });

  it("a failed publish leaves the batch unpublished; the next pass redelivers it (at least once)", async () => {
    const ids = await emit(3);
    const failing = new MemoryPublisher((m) => m.attributes.outboxId === ids[1]);
    await expect(drain(failing)).rejects.toThrow(/publish failed/);
    expect(await unpublished()).toEqual(ids);
    expect(failing.mine().map((m) => m.attributes.outboxId)).toEqual([ids[0], ids[1]]); // row 0 already left
    const ok = new MemoryPublisher();
    await drain(ok);
    expect(ok.mine().map((m) => m.attributes.outboxId)).toEqual(ids);
    expect(await unpublished()).toEqual([]);
  });

  it("two publishers side by side never take the same row (FOR UPDATE SKIP LOCKED)", async () => {
    const ids = await emit(60, otherWs);
    const a = new MemoryPublisher();
    const b = new MemoryPublisher();
    await Promise.all([drain(a, 7), drain(b, 7)]);
    const fromA = a.mine(otherWs).map((m) => m.attributes.outboxId);
    const fromB = b.mine(otherWs).map((m) => m.attributes.outboxId);
    expect([...fromA, ...fromB].sort()).toEqual([...ids].sort());
    expect(fromA.filter((id) => fromB.includes(id))).toEqual([]);
  });

  it("budget_publisher reads outbox and workspace ids only, and writes nothing but published_at", async () => {
    await expect(publisherDb.$queryRawUnsafe(`SELECT id FROM envelope LIMIT 1`)).rejects.toThrow(/permission denied/);
    await expect(publisherDb.$queryRawUnsafe(`SELECT name FROM workspace LIMIT 1`)).rejects.toThrow(/permission denied/);
    await expect(publisherDb.$executeRawUnsafe(`UPDATE outbox SET payload = '{}'::jsonb WHERE false`)).rejects.toThrow(/permission denied/);
    await expect(publisherDb.$executeRawUnsafe(`DELETE FROM outbox WHERE false`)).rejects.toThrow(/permission denied/);
  });
});

describe("subscriber: exactly once per consumer (T-016 done-when)", () => {
  let messages: OutboxMessage[];
  beforeAll(async () => {
    await emit(4, ws, "alert.triggered");
    const p = new MemoryPublisher();
    await drain(p);
    messages = p.mine().filter((m) => m.attributes.topic === "alert.triggered");
    expect(messages).toHaveLength(4);
  });
  const msg = (i: number) => messages[i] as OutboxMessage;

  it("the same outbox id delivered twice is applied once", async () => {
    const first = await handleOnce(app, "notify-worker", decodePush(push(msg(0))), notifyHandler("dup-seq"));
    const second = await handleOnce(app, "notify-worker", decodePush(push(msg(0), "redelivery")), notifyHandler("dup-seq"));
    expect([first, second]).toEqual(["applied", "duplicate"]);
    expect(await notifications("dup-seq")).toBe(1);
  });

  it("concurrent duplicate deliveries still apply once", async () => {
    const body = push(msg(1));
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => handleOnce(app, "notify-worker", decodePush(body), notifyHandler("dup-par"))));
    expect(outcomes.filter((o) => o === "applied")).toHaveLength(1);
    expect(await notifications("dup-par")).toBe(1);
  });

  it("a handler that fails is not recorded, so the redelivery applies it — once", async () => {
    let calls = 0;
    const flaky: EventHandler = async (tx, event) => {
      calls += 1;
      await notifyHandler("flaky")(tx, event);
      if (calls === 1) throw new Error("downstream timeout");
    };
    await expect(handleOnce(app, "notify-worker", decodePush(push(msg(2))), flaky)).rejects.toThrow(/downstream timeout/);
    expect(await notifications("flaky")).toBe(0); // the handler's write rolled back with the dedupe row
    expect(await handleOnce(app, "notify-worker", decodePush(push(msg(2))), flaky)).toBe("applied");
    expect(await handleOnce(app, "notify-worker", decodePush(push(msg(2))), flaky)).toBe("duplicate");
    expect(await notifications("flaky")).toBe(1);
  });

  it("dedupe is per consumer: each subscriber applies the event once", async () => {
    const e = () => decodePush(push(msg(3)));
    expect(await handleOnce(app, "rollup-worker", e(), notifyHandler("per-consumer"))).toBe("applied");
    expect(await handleOnce(app, "search-indexer", e(), notifyHandler("per-consumer"))).toBe("applied");
    expect(await handleOnce(app, "rollup-worker", e(), notifyHandler("per-consumer"))).toBe("duplicate");
    expect(await notifications("per-consumer")).toBe(2);
  });

  it("a message claiming another workspace is refused by RLS and applies nothing", async () => {
    const forged = { ...push(msg(3)) };
    forged.message = { ...forged.message, attributes: { ...forged.message.attributes, workspaceId: otherWs } };
    await expect(handleOnce(app, "audit-probe", decodePush(forged), notifyHandler("forged"))).rejects.toThrow(/row-level security/);
    expect(await notifications("forged")).toBe(0);
  });

  it("rejects a push body that is not an outbox event", () => {
    expect(() => decodePush({ message: { data: "e30=", attributes: { outboxId: "0", workspaceId: ws, orgId, topic: "x" }, messageId: "m" }, subscription: "s" })).toThrow(/Invalid Pub\/Sub push body/);
    expect(() => decodePush({ message: { data: Buffer.from("not json").toString("base64"), attributes: msg(0).attributes, messageId: "m" }, subscription: "s" })).toThrow(/not base64 JSON/);
  });
});
