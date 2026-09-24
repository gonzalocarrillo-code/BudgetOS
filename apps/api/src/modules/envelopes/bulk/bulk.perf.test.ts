import { randomUUID } from "node:crypto";
import type { TenantContext } from "@budget/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { appDb as appDbClient, ownerDb, startHarness, testUser, type Harness } from "../../../test-support/harness.js";
import { seedDefaultPolicies } from "../../approvals/commands/policies.js";

/**
 * T-013 done-when: a 10k-row bulk commit completes in under 10 s (plan Epic 1.1b). Fixture rows are
 * SQL (10,000 envelopes, each with an approved version and 12 months of phasing); the commit goes
 * through the HTTP API exactly as the grid would call it.
 */

const ROWS = 10_000;
const owner = ownerDb();
const app = appDbClient();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const planner = testUser("perf-planner", randomUUID());
let ids: string[] = [];

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "bulk-perf" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `bulk-perf-${ws}`, name: "Bulk perf", reportingCurrency: "USD" } });
  await owner.user.create({ data: { id: planner.id, orgId, email: planner.email, name: planner.email, googleSub: `g-${planner.sub}` } });
  await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: planner.id } });
  await owner.$executeRawUnsafe(
    `WITH e AS (
       INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
       SELECT gen_random_uuid(), $1::uuid, 'P' || lpad(i::text, 5, '0'), '{}'::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $2::uuid, now()
       FROM generate_series(1, $3::int) i RETURNING id
     ), v AS (
       INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at)
       SELECT gen_random_uuid(), e.id, 1, 1200.00, 1200.00, 'APPROVED', $2::uuid, '2026-01-05' FROM e RETURNING id, envelope_id
     ), p AS (
       INSERT INTO envelope_phasing (version_id, month, amount)
       SELECT v.id, make_date(2026, m, 1), 100.00 FROM v CROSS JOIN generate_series(1, 12) m RETURNING version_id
     )
     SELECT count(*) FROM p`,
    ws,
    planner.id,
    ROWS,
  );
  // Separate statement: a WITH's main query cannot see rows its own CTEs inserted.
  await owner.$executeRawUnsafe(
    `UPDATE envelope e SET current_version_id = v.id FROM envelope_version v WHERE v.envelope_id = e.id AND e.workspace_id = $1::uuid`,
    ws,
  );
  ids = (await owner.envelope.findMany({ where: { workspaceId: ws }, select: { id: true } })).map((e) => e.id);
  const ctx: TenantContext = { workspaceId: ws, orgId, userId: planner.id, isOrgAdmin: false, actorType: "user", requestId: `perf-seed-${ws}` };
  await seedDefaultPolicies(app, ctx);
  h = await startHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
  const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
  for (const sql of [
    `DELETE FROM approval_request WHERE workspace_id = $1::uuid`,
    `DELETE FROM bulk_change WHERE workspace_id = $1::uuid`,
    `DELETE FROM approval_policy WHERE workspace_id = $1::uuid`,
    `UPDATE envelope SET current_version_id = NULL, draft_version_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_phasing WHERE version_id IN (SELECT id FROM envelope_version WHERE envelope_id IN ${envs})`,
    `DELETE FROM envelope_version WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
    `DELETE FROM role_assignment WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.delete({ where: { id: ws } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
}, 120_000);

it(`commits a ${ROWS}-row bulk edit in under 10 seconds`, async () => {
  expect(ids).toHaveLength(ROWS);
  expect(await owner.envelope.count({ where: { workspaceId: ws, currentVersionId: null } })).toBe(0);
  const token = await h.mint(planner);
  const headers = { "x-workspace-id": ws, "x-request-id": `perf-${ws}` };
  const t0 = performance.now();
  const preview = await h.call("POST", "/api/v1/envelopes/bulk", token, { headers, body: { workspaceId: ws, selection: { envelopeIds: ids }, operation: { op: "pct", pct: 3 }, rationale: "10k perf" } });
  const previewMs = performance.now() - t0;
  expect(preview.status, JSON.stringify(preview.body).slice(0, 500)).toBe(201);
  const rows = preview.body["rows"] as Array<{ before: string; after: string }>;
  expect(rows.length).toBe(ROWS);
  expect(rows[0]).toMatchObject({ before: "1200.00", after: "1236.00" });

  const t1 = performance.now();
  const commit = await h.call("POST", `/api/v1/envelopes/bulk/${String(preview.body["previewId"])}/commit`, token, { headers });
  const commitMs = performance.now() - t1;
  expect(commit.status, JSON.stringify(commit.body)).toBe(201);
  expect(commit.body["versions"]).toBe(ROWS);
  process.stdout.write(`bulk perf: preview ${previewMs.toFixed(0)} ms, commit ${commitMs.toFixed(0)} ms for ${ROWS} rows\n`);
  expect(commitMs).toBeLessThan(10_000);

  const [counts] = await owner.$queryRawUnsafe<Array<{ drafts: bigint; phasing: bigint; audits: bigint; outbox: bigint }>>(
    `SELECT (SELECT count(*) FROM envelope_version v JOIN envelope e ON e.id = v.envelope_id WHERE e.workspace_id = $1::uuid AND v.version_no = 2 AND v.status = 'PENDING') AS drafts,
            (SELECT count(*) FROM envelope_phasing p JOIN envelope_version v ON v.id = p.version_id JOIN envelope e ON e.id = v.envelope_id WHERE e.workspace_id = $1::uuid AND v.version_no = 2) AS phasing,
            (SELECT count(*) FROM audit_event WHERE request_id = $2 AND action = 'envelope.version.created') AS audits,
            (SELECT count(*) FROM outbox WHERE workspace_id = $1::uuid AND topic = 'budget.changed') AS outbox`,
    ws,
    `perf-${ws}`,
  );
  expect(Number(counts?.drafts)).toBe(ROWS);
  expect(Number(counts?.phasing)).toBe(ROWS * 12);
  expect(Number(counts?.audits)).toBe(ROWS);
  expect(Number(counts?.outbox)).toBe(1);
}, 120_000);
