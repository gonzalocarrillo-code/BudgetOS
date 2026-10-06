import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleOnce } from "./consumer.js";
import { deleteWorkspaceForTests } from "./purge/purge.js";

/** ADR-052: an archived or deleted workspace is frozen, so its events are acknowledged and not applied. */
const url = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const owner = new PrismaClient({ datasources: { db: { url: url("DATABASE_URL") } } });
const app = new PrismaClient({ datasources: { db: { url: url("APP_DATABASE_URL") } } });
const orgId = randomUUID();
const live = randomUUID();
const frozen = randomUUID();

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "consumer-freeze" } });
  await owner.workspace.createMany({ data: [
    { id: live, orgId, slug: `live-${live.slice(0, 8)}`, name: "Live", reportingCurrency: "USD" },
    { id: frozen, orgId, slug: `frozen-${frozen.slice(0, 8)}`, name: "Frozen", reportingCurrency: "USD", status: "ARCHIVED" },
  ] });
});

afterAll(async () => {
  await owner.$executeRawUnsafe(`DELETE FROM processed_event WHERE consumer = 'freeze-test'`);
  // W3-11 (audit I-32): deletes every row that FKs to these workspaces (and the workspace rows
  // themselves), in the same order `purgeWorkspace` validates against production.
  await deleteWorkspaceForTests(owner, [live, frozen]);
  await owner.organization.deleteMany({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("handleOnce and frozen workspaces (ADR-052)", () => {
  it("applies an active workspace's event and skips an archived one's, once each", async () => {
    let ran = 0;
    const handler = async () => void (ran += 1);
    const row = async (workspaceId: string) => (await owner.$queryRawUnsafe<Array<{ id: string }>>(`INSERT INTO outbox (workspace_id, topic, payload, published_at) VALUES ($1::uuid, 'budget.changed', '{}'::jsonb, now()) RETURNING id::text`, workspaceId))[0]?.id as string;
    const event = (workspaceId: string, outboxId: string) => ({ outboxId, workspaceId, orgId, topic: "budget.changed", payload: {} });
    expect(await handleOnce(app, "freeze-test", event(live, await row(live)), handler)).toBe("applied");
    const frozenId = await row(frozen);
    expect(await handleOnce(app, "freeze-test", event(frozen, frozenId), handler)).toBe("skipped");
    expect(await handleOnce(app, "freeze-test", event(frozen, frozenId), handler)).toBe("duplicate");
    expect(ran).toBe(1);
  });
});
