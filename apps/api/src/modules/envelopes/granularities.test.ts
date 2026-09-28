import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/** Product feedback 2026-09-28 ("I'm not free to do anything"): a budget's granularities change after it is created. */

const owner = ownerDb();
const app = appDb();
let h: Harness;
let golden: GoldenResult;
const slug = `gran-${randomUUID().slice(0, 8)}`;

async function as(persona: string, method: "GET" | "PATCH", url: string, body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, `/api/v1${url}`, token, { headers: { "x-workspace-id": golden.workspaceId }, ...(body === undefined ? {} : { body }) });
}

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("edit a budget's granularities", () => {
  it("replaces the tuple (registry-checked), keeps envelope_dimension in step, audits it and rebuilds the roll-ups", async () => {
    const [env] = await owner.$queryRawUnsafe<Array<{ id: string; dims: Record<string, string> }>>(
      `SELECT id::text, dimension_values AS dims FROM envelope WHERE workspace_id = $1::uuid AND status = 'APPROVED' AND dimension_values ? 'platform' AND dimension_values ? 'objective' LIMIT 1`,
      golden.workspaceId,
    );
    expect(env).toBeDefined();
    const before = (await as("admin", "GET", `/envelopes/${env!.id}`)).body as { rowVersion: number };
    const { objective: _dropped, ...rest } = env!.dims;
    void _dropped;

    expect((await as("admin", "PATCH", `/envelopes/${env!.id}`, { rowVersion: before.rowVersion, dimensionValues: { ...rest, platform: "no_such_platform" } })).status).toBe(422);
    const res = await as("admin", "PATCH", `/envelopes/${env!.id}`, { rowVersion: before.rowVersion, dimensionValues: rest });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = (await as("admin", "GET", `/envelopes/${env!.id}`)).body as { dimensionValues: Record<string, string>; rowVersion: number };
    expect(after.dimensionValues).toEqual(rest);
    expect(after.rowVersion).toBe(before.rowVersion + 1);
    const rows = await owner.$queryRawUnsafe<Array<{ key: string }>>(`SELECT d.key FROM envelope_dimension ed JOIN dimension d ON d.id = ed.dimension_id WHERE ed.envelope_id = $1::uuid ORDER BY 1`, env!.id);
    expect(rows.map((r) => r.key)).toEqual(Object.keys(rest).sort());

    const [a] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'envelope.updated' AND after ? 'dimensionValues'`, env!.id);
    expect(Number(a?.n)).toBe(1);
    const [o] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'budget.changed' AND payload->>'envelopeId' = $2 AND payload->>'kind' = 'granularities'`, golden.workspaceId, env!.id);
    expect(Number(o?.n)).toBe(1);
  });
});
