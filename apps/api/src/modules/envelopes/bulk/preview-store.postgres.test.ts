import { randomUUID } from "node:crypto";
import { withTenant, type TenantContext } from "@budget/db";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerDb } from "../../../test-support/harness.js";
import { PostgresPreviewStore } from "./preview-store.js";

/**
 * W1-5 (audit I-5, ADR-0072, decision D-2): previews move to Postgres so any API instance can
 * commit a preview another instance built. Runs the Memory/Redis stores' contract (put → get,
 * delete) plus the cases only Postgres proves: a preview written by one process and consumed by
 * another, atomic `take` so a double commit can't both succeed, expiry, and RLS across workspaces.
 *
 * `app` and `app2` are two separate `PrismaClient`s on the `budget_app` role, standing in for two
 * API instances: unlike `MemoryPreviewStore`, nothing here is shared in one process's memory.
 */
const owner = ownerDb();
const app = new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });
const app2 = new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });
const store = new PostgresPreviewStore();

const orgId = randomUUID();
const wsA = randomUUID();
const wsB = randomUUID();
const userId = randomUUID();

function ctx(workspaceId: string): TenantContext {
  return { workspaceId, orgId, userId, isOrgAdmin: false, actorType: "user", requestId: "w1-5-preview-store" };
}

beforeAll(async () => {
  await owner.$executeRaw`INSERT INTO organization (id, name) VALUES (${orgId}::uuid, 'w1-5 preview store')`;
  await owner.$executeRaw`
    INSERT INTO workspace (id, org_id, slug, name, reporting_currency) VALUES (${wsA}::uuid, ${orgId}::uuid, ${`w15a-${wsA}`}, 'W1-5 A', 'USD')`;
  await owner.$executeRaw`
    INSERT INTO workspace (id, org_id, slug, name, reporting_currency) VALUES (${wsB}::uuid, ${orgId}::uuid, ${`w15b-${wsB}`}, 'W1-5 B', 'USD')`;
});

afterAll(async () => {
  await owner.$executeRaw`DELETE FROM bulk_preview WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
  await owner.$executeRaw`DELETE FROM workspace WHERE id IN (${wsA}::uuid, ${wsB}::uuid)`;
  await owner.$executeRaw`DELETE FROM organization WHERE id = ${orgId}::uuid`;
  await Promise.all([owner.$disconnect(), app.$disconnect(), app2.$disconnect()]);
});

describe("PostgresPreviewStore", () => {
  it("put then get returns the payload; delete removes it", async () => {
    const id = randomUUID();
    await withTenant(app, ctx(wsA), (tx) => store.put(tx, id, "bulk-edit", JSON.stringify({ x: 1 }), 60));
    const got = await withTenant(app, ctx(wsA), (tx) => store.get(tx, id));
    expect(JSON.parse(got ?? "null")).toEqual({ x: 1 });
    await withTenant(app, ctx(wsA), (tx) => store.delete(tx, id));
    expect(await withTenant(app, ctx(wsA), (tx) => store.get(tx, id))).toBeNull();
  });

  it("a preview put on one instance is taken on another (cross-instance commit)", async () => {
    const id = randomUUID();
    await withTenant(app, ctx(wsA), (tx) => store.put(tx, id, "bulk-edit", JSON.stringify({ rows: [1, 2, 3] }), 60));
    const taken = await withTenant(app2, ctx(wsA), (tx) => store.take(tx, id));
    expect(JSON.parse(taken ?? "null")).toEqual({ rows: [1, 2, 3] });
    // consumed: gone for everyone
    expect(await withTenant(app, ctx(wsA), (tx) => store.get(tx, id))).toBeNull();
  });

  it("take is atomic: of two concurrent takes, exactly one gets the payload and the other gets null", async () => {
    const id = randomUUID();
    await withTenant(app, ctx(wsA), (tx) => store.put(tx, id, "bulk-edit", JSON.stringify({ once: true }), 60));
    const [a, b] = await Promise.all([withTenant(app, ctx(wsA), (tx) => store.take(tx, id)), withTenant(app2, ctx(wsA), (tx) => store.take(tx, id))]);
    const nonNull = [a, b].filter((v) => v !== null);
    expect(nonNull).toHaveLength(1);
    expect(JSON.parse(nonNull[0] as string)).toEqual({ once: true });
    expect(await withTenant(app, ctx(wsA), (tx) => store.get(tx, id))).toBeNull();
  });

  it("expired rows are returned by neither get nor take", async () => {
    const id = randomUUID();
    await withTenant(app, ctx(wsA), (tx) => store.put(tx, id, "bulk-edit", "{}", -1)); // already expired
    expect(await withTenant(app, ctx(wsA), (tx) => store.get(tx, id))).toBeNull();
    expect(await withTenant(app, ctx(wsA), (tx) => store.take(tx, id))).toBeNull();
  });

  it("a different workspace's session can neither read nor take another workspace's preview (RLS)", async () => {
    const id = randomUUID();
    await withTenant(app, ctx(wsA), (tx) => store.put(tx, id, "bulk-edit", JSON.stringify({ secret: true }), 60));
    expect(await withTenant(app, ctx(wsB), (tx) => store.get(tx, id))).toBeNull();
    expect(await withTenant(app, ctx(wsB), (tx) => store.take(tx, id))).toBeNull();
    // still there, untouched, for its own workspace
    const stillThere = await withTenant(app, ctx(wsA), (tx) => store.get(tx, id));
    expect(JSON.parse(stillThere ?? "null")).toEqual({ secret: true });
  });

  it("put opportunistically sweeps this workspace's own expired rows", async () => {
    const stale = randomUUID();
    await withTenant(app, ctx(wsA), (tx) => store.put(tx, stale, "bulk-edit", "{}", -1));
    const beforeSweep = await owner.$queryRaw<Array<{ id: string }>>`SELECT id FROM bulk_preview WHERE id = ${stale}`;
    expect(beforeSweep).toHaveLength(1);
    await withTenant(app, ctx(wsA), (tx) => store.put(tx, randomUUID(), "bulk-edit", "{}", 60));
    const afterSweep = await owner.$queryRaw<Array<{ id: string }>>`SELECT id FROM bulk_preview WHERE id = ${stale}`;
    expect(afterSweep).toHaveLength(0);
  });
});
