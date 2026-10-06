import { randomUUID } from "node:crypto";
import { asOrgAdmin, type Tx } from "@budget/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/**
 * R9-003 (ADR-060): a target's dates are editable in place, audited, with one outbox row; its
 * values keep their versions; an envelope's target stays inside the envelope's dates.
 */
const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `tdates-${randomUUID().slice(0, 8)}`;

async function as(persona: string, method: "GET" | "PATCH", url: string, body?: unknown, requestId?: string) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId, ...(requestId ? { "x-request-id": requestId } : {}) }, ...(body === undefined ? {} : { body }) });
}
// W0-6: the owner has no BYPASSRLS; every owner.* read below needs the same org-admin tenant
// context real reads get from withTenant, scoped to the golden workspace's org.
const admin = <T>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, golden.orgId);

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("target dates (R9-003)", () => {
  it("change in place inside the envelope's dates; outside or unchanged is refused", async () => {
    const [target] = await admin((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string; start: string; end: string; env_start: string; env_end: string; version: string | null }>>(
        `SELECT t.id::text, t.start_date::text AS start, t.end_date::text AS end, e.start_date::text AS env_start, e.end_date::text AS env_end, t.current_version_id::text AS version
         FROM target t JOIN envelope e ON e.id = t.envelope_id WHERE t.workspace_id = $1::uuid AND t.scope_type = 'envelope' AND t.status = 'active' LIMIT 1`,
        golden.workspaceId,
      ),
    );
    expect(target).toBeDefined();
    const t = target as NonNullable<typeof target>;
    const endDate = `${t.env_end.slice(0, 8)}01`; // the first of the envelope's last month
    const requestId = `tdates-${randomUUID()}`;
    const res = await as("planner", "PATCH", `/api/v1/targets/${t.id}/dates`, { startDate: t.env_start, endDate }, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ startDate: t.env_start, endDate });
    const audits = await admin((tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1`, requestId));
    expect(audits.map((a) => a.action)).toEqual(["target.dates_changed"]);
    const out = await admin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'target.changed' AND payload->>'targetId' = $2 AND payload->>'kind' = 'dates'`, golden.workspaceId, t.id));
    expect(Number(out[0]?.n)).toBe(1);
    const [after] = await admin((tx) => tx.$queryRawUnsafe<Array<{ version: string | null }>>(`SELECT current_version_id::text AS version FROM target WHERE id = $1::uuid`, t.id));
    expect(after?.version).toBe(t.version);

    const outside = await as("planner", "PATCH", `/api/v1/targets/${t.id}/dates`, { startDate: t.env_start, endDate: `${Number(t.env_end.slice(0, 4)) + 1}-12-31` });
    expect(outside.status).toBe(422);
    expect((await as("planner", "PATCH", `/api/v1/targets/${t.id}/dates`, { startDate: t.env_start, endDate })).status).toBe(422);
  });
});
