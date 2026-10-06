import { randomUUID } from "node:crypto";
import { asOrgAdmin, recomputeNames, withTenant, type Tx } from "@budget/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/** Product feedback 2026-09-28: "can we rename budgets?" — a rename wins over the display naming template. */

const owner = ownerDb();
const app = appDb();
let h: Harness;
let golden: GoldenResult;
const slug = `rename-${randomUUID().slice(0, 8)}`;

async function as(persona: string, method: "GET" | "PATCH" | "POST", url: string, body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, `/api/v1${url}`, token, { headers: { "x-workspace-id": golden.workspaceId }, ...(body === undefined ? {} : { body }) });
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

describe("rename a budget", () => {
  it("the new name shows even with a display naming template; 'use the template name' brings it back", async () => {
    const template = await as("admin", "POST", `/workspaces/${golden.workspaceId}/naming-templates`, { kind: "display", chips: [{ type: "dimension", key: "country" }, { type: "separator", value: " " }, { type: "dimension", key: "platform" }] });
    expect(template.status, JSON.stringify(template.body)).toBe(201);
    // W0-7: the golden seed's own split (T-014) archives its source envelope, which still gets a
    // display_name from the template below (recomputeNames does not filter by status). Without
    // `status <> 'ARCHIVED'` and a deterministic ORDER BY, this unordered LIMIT 1 can intermittently
    // pick that archived row depending on the shared `envelope` table's physical layout at the time
    // (CI with VITEST_MAX_WORKERS=1 hits this because many other suites' rows have passed through the
    // same relation beforehand) and the PATCH below then fails with 409 "Envelope is archived".
    // W0-6: the owner has no BYPASSRLS, so this read needs the same org-admin tenant context real
    // reads get from withTenant, scoped to the golden workspace's org.
    const [env] = await admin((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string; name: string; display_name: string | null }>>(
        `SELECT e.id::text, e.name, e.display_name FROM envelope e WHERE e.workspace_id = $1::uuid AND e.status <> 'ARCHIVED' AND e.display_name IS NOT NULL AND e.display_name <> e.name ORDER BY e.id LIMIT 1`,
        golden.workspaceId,
      ),
    );
    expect(env, "the display template named the budgets").toBeDefined();
    const before = (await as("planner", "GET", `/envelopes/${env!.id}`)).body as { rowVersion: number };
    const renamed = await as("planner", "PATCH", `/envelopes/${env!.id}`, { rowVersion: before.rowVersion, name: "Brand always-on" });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const detail = (await as("planner", "GET", `/envelopes/${env!.id}`)).body as { name: string; displayName: string | null; nameCustom: boolean; rowVersion: number };
    expect(detail).toMatchObject({ name: "Brand always-on", displayName: null, nameCustom: true });

    // A workspace-wide re-render (a naming template saved) leaves it alone.
    await withTenant(app, { workspaceId: golden.workspaceId, orgId: golden.orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `rename-${randomUUID()}` }, (tx) => recomputeNames(tx, golden.workspaceId));
    expect(((await as("planner", "GET", `/envelopes/${env!.id}`)).body as { displayName: string | null }).displayName).toBeNull();

    const back = await as("planner", "PATCH", `/envelopes/${env!.id}`, { rowVersion: detail.rowVersion, useTemplateName: true });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const restored = (await as("planner", "GET", `/envelopes/${env!.id}`)).body as { displayName: string | null; nameCustom: boolean };
    expect(restored).toMatchObject({ displayName: env!.display_name, nameCustom: false });

    expect((await as("planner", "PATCH", `/envelopes/${env!.id}`, { rowVersion: 1, name: "Stale" })).status).toBe(409);
    const [audit] = await admin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'envelope.updated'`, env!.id));
    expect(Number(audit?.n)).toBe(2);
  });
});
