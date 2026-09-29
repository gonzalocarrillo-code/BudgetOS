import { randomUUID } from "node:crypto";
import { GOLDEN_HISTORY, withTenant } from "@budget/db";
import { checkSnapshotIntegrity } from "@budget/workers";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/**
 * D-013 done-when (docs/DATA_PLAN.md §8.2): snapshots never cross tenants. Two workspaces in one org,
 * a snapshot in each. From workspace B, every read of A's snapshot is 404 — list, header, rows, CSV,
 * report, report against it, rename, and a query comparing with it — for B's admin and for a
 * superadmin acting in B. Postgres refuses a row whose workspace is not its snapshot's or its
 * budget's, and the read-only MCP role reads nothing of A from B's session.
 */
const owner = ownerDb();
const app = appDbClient();
const mcp = new PrismaClient({ datasources: { db: { url: process.env["MCP_DATABASE_URL"] ?? "" } } });
let h: Harness;
let golden: GoldenResult;
const slug = `iso-${randomUUID().slice(0, 8)}`;
const wsB = randomUUID();
let snapA: string;
let snapB: string;
let envB: string;

async function as(persona: string, workspaceId: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": workspaceId }, ...(body === undefined ? {} : { body }) });
}

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
  snapA = (await owner.budgetBaseline.findFirstOrThrow({ where: { workspaceId: golden.workspaceId, name: GOLDEN_HISTORY.plan.name } })).id;
  // Workspace B in the same org: the golden admin is its admin too.
  await owner.workspace.create({ data: { id: wsB, orgId: golden.orgId, slug: `${slug}-b`, name: "Isolation B", reportingCurrency: "USD" } });
  await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: wsB, principalType: "user", principalId: golden.users.admin, role: "WORKSPACE_ADMIN", createdBy: golden.users.orgAdmin } });
  const env = await as("admin", wsB, "POST", `/api/v1/workspaces/${wsB}/envelopes`, { name: "B budget", parentId: null, dimensionValues: { region: "EMEA" }, startDate: "2026-01-01", endDate: "2026-12-31", currency: "USD", amount: "100.00" });
  expect(env.status, JSON.stringify(env.body)).toBe(201);
  envB = String(env.body["id"]);
  const snap = await as("admin", wsB, "POST", `/api/v1/workspaces/${wsB}/baselines`, { name: "B plan", kind: "plan" });
  expect(snap.status, JSON.stringify(snap.body)).toBe(201);
  snapB = String(snap.body["id"]);
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect(), mcp.$disconnect()]);
});

describe("snapshots never cross tenants (D-013)", () => {
  for (const persona of ["admin", "orgAdmin"]) {
    it(`from workspace B, every read of workspace A's snapshot is 404 (${persona === "admin" ? "B's admin" : "a superadmin acting in B"})`, async () => {
      const listed = (await as(persona, wsB, "GET", `/api/v1/workspaces/${wsB}/baselines?includeArchived=true`)).body as unknown as { baselines: Array<{ id: string }> };
      expect(listed.baselines.map((b) => b.id)).toEqual([snapB]);
      for (const url of [`/api/v1/baselines/${snapA}`, `/api/v1/baselines/${snapA}/rows`, `/api/v1/baselines/${snapA}/export.csv`, `/api/v1/baselines/${snapA}/report`, `/api/v1/baselines/${snapB}/report?against=${snapA}`]) {
        expect((await as(persona, wsB, "GET", url)).status, url).toBe(404);
      }
      expect((await as(persona, wsB, "PATCH", `/api/v1/baselines/${snapA}`, { name: "taken" })).status).toBe(404);
      const compared = await as(persona, wsB, "POST", `/api/v1/workspaces/${wsB}/query`, { workspaceId: wsB, period: { kind: "range", start: "2026-01-01", end: "2026-12-31" }, measures: ["budget", "budget_baseline"], compareTo: { baselineId: snapA } });
      expect(compared.status, JSON.stringify(compared.body)).toBe(404);
      // Its own snapshot works as usual.
      expect((await as(persona, wsB, "GET", `/api/v1/baselines/${snapB}/rows`)).status).toBe(200);
    });
  }

  it("Postgres refuses a snapshot row whose workspace is not its snapshot's or its budget's", async () => {
    const row = (baselineId: string, workspaceId: string, envelopeId: string) =>
      owner.$executeRawUnsafe(
        `INSERT INTO budget_baseline_row (baseline_id, workspace_id, envelope_id, version_id, amount, amount_reporting, currency, parent_id, name, dimension_values, start_date, end_date, is_leaf)
         VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, 1, 1, 'USD', NULL, 'x', '{}', '2026-01-01', '2026-12-31', true)`,
        baselineId, workspaceId, envelopeId,
      );
    const envA = golden.envelopeIds.values().next().value as string;
    await expect(row(snapA, wsB, envB)).rejects.toThrow(/budget_baseline_row_baseline_tenant_fkey/); // A's snapshot, B's row
    await expect(row(snapB, wsB, envA)).rejects.toThrow(/budget_baseline_row_envelope_tenant_fkey/); // B's snapshot, A's budget
  });

  it("D-015: the weekly integrity check finds nothing on the golden org (both workspaces)", async () => {
    expect(await checkSnapshotIntegrity(app, [golden.orgId])).toEqual([]);
  });

  it("the read-only MCP role, in workspace B's session, reads nothing of A", async () => {
    const ctx = { workspaceId: wsB, orgId: golden.orgId, userId: golden.users.admin, isOrgAdmin: false, actorType: "mcp" as const, requestId: `iso-${randomUUID()}` };
    const seen = await withTenant(mcp, ctx, async (tx) => ({
      headers: await tx.budgetBaseline.count({ where: { id: snapA } }),
      rows: await tx.budgetBaselineRow.count({ where: { baselineId: snapA } }),
      own: await tx.budgetBaseline.count({ where: { id: snapB } }),
    }));
    expect(seen).toEqual({ headers: 0, rows: 0, own: 1 });
  });
});
