import { randomUUID } from "node:crypto";
import { goldenPlan } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../../seed/golden.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../../test-support/harness.js";
import { parseCsv, toCsv } from "./csv.js";

/**
 * T-013 over a seeded golden workspace: bulk preview/commit for every operation, paste, CSV
 * round trip, the bulk approval request (one request for all rows), conflicts, caps, auto-approve.
 * The 10k-rows < 10 s done-when is bulk.perf.test.ts.
 */

const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `bulk-${randomUUID().slice(0, 8)}`;
const plan = goldenPlan();
const byKey = new Map(plan.map((e) => [e.key, e]));
type Json = Record<string, unknown>;

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, requestId?: string) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId, ...(requestId ? { "x-request-id": requestId } : {}) }, ...(body === undefined ? {} : { body }) });
}
const id = (key: string) => golden.envelopeIds.get(key) as string;
const leafKeys = (prefix: string) => plan.filter((e) => e.level === 4 && e.key.startsWith(prefix)).map((e) => e.key);
const round3 = (key: string) => new Decimal(byKey.get(key)?.versions[2]?.amount ?? 0);
const preview = (ids: string[], operation: Json, persona = "planner") =>
  as(persona, "POST", "/api/v1/envelopes/bulk", { workspaceId: golden.workspaceId, selection: { envelopeIds: ids }, operation, rationale: "bulk test" });
const commit = (previewId: string, persona = "planner", requestId?: string) => as(persona, "POST", `/api/v1/envelopes/bulk/${previewId}/commit`, undefined, requestId);
const approve = (requestId: string, persona: string, decision = "approve", comment?: string) =>
  as(persona, "POST", `/api/v1/approvals/${requestId}/decisions`, { decision, ...(comment ? { comment } : {}) });
async function current(envelopeId: string) {
  const e = (await as("planner", "GET", `/api/v1/envelopes/${envelopeId}`)).body as { current: { amount: string } | null; draftVersionId: string | null; status: string; currentVersionId: string | null };
  return e;
}

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) {
    const ws = golden.workspaceId;
    const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
    for (const sql of [
      `DELETE FROM comment WHERE thread_id IN (SELECT id FROM thread WHERE workspace_id = $1::uuid)`,
      `DELETE FROM thread WHERE workspace_id = $1::uuid`,
      `DELETE FROM approval_decision WHERE request_id IN (SELECT id FROM approval_request WHERE workspace_id = $1::uuid)`,
      `DELETE FROM approval_request WHERE workspace_id = $1::uuid`,
      `DELETE FROM bulk_change WHERE workspace_id = $1::uuid`,
      `DELETE FROM approval_policy WHERE workspace_id = $1::uuid`,
      `UPDATE envelope SET current_version_id = NULL, draft_version_id = NULL, parent_id = NULL WHERE workspace_id = $1::uuid`,
      `DELETE FROM envelope_phasing WHERE version_id IN (SELECT id FROM envelope_version WHERE envelope_id IN ${envs})`,
      `DELETE FROM envelope_version WHERE envelope_id IN ${envs}`,
      `DELETE FROM envelope_dimension WHERE envelope_id IN ${envs}`,
      `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
      `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
      `DELETE FROM hierarchy_template WHERE workspace_id = $1::uuid`,
      `DELETE FROM role_assignment WHERE workspace_id = $1::uuid`,
    ]) {
      await owner.$executeRawUnsafe(sql, ws);
    }
    await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, golden.orgId);
    await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, golden.orgId);
    await owner.$executeRawUnsafe(`DELETE FROM role_assignment WHERE principal_id IN (SELECT id FROM app_user WHERE org_id = $1::uuid)`, golden.orgId);
    await owner.$executeRawUnsafe(`DELETE FROM app_user WHERE org_id = $1::uuid`, golden.orgId);
    await owner.$executeRawUnsafe(`DELETE FROM workspace WHERE id = $1::uuid`, ws);
    await owner.$executeRawUnsafe(`DELETE FROM organization WHERE id = $1::uuid`, golden.orgId);
  }
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("preview → commit → one approval request for all rows", () => {
  it("preview writes nothing; commit writes a draft per row, one bulk_change, one request, one audit per row + summary, one outbox row", async () => {
    const keys = leafKeys("LATAM/BR/meta/awareness").concat(leafKeys("LATAM/BR/meta/consideration"));
    const ids = keys.map(id);
    const versionsBefore = await owner.envelopeVersion.count({ where: { envelopeId: { in: ids } } });
    const p = await preview(ids, { op: "pct", pct: 3 }); // within the parents' 5% headroom: no cap violation
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const rows = p.body["rows"] as Array<{ envelopeId: string; before: string; after: string; delta: string; path: string[] }>;
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      const key = keys[ids.indexOf(r.envelopeId)] as string;
      expect(r.before).toBe(round3(key).toFixed(2));
      expect(r.after).toBe(round3(key).mul(1.03).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));
      expect(r.path.slice(0, 2)).toEqual(["LATAM", "LATAM BR"]);
    }
    const sumAfter = rows.reduce((s, r) => s.plus(r.after), new Decimal(0));
    expect(p.body["totalsAfter"]).toBe(sumAfter.toFixed(2));
    expect(p.body["capViolations"]).toEqual([]);
    expect(p.body["policyPreview"]).toEqual({ name: "Standard", chain: ["BUDGET_OWNER", "APPROVER"] });
    expect(await owner.envelopeVersion.count({ where: { envelopeId: { in: ids } } })).toBe(versionsBefore);

    const maxOutbox = Number((await owner.$queryRawUnsafe<Array<{ m: bigint | null }>>(`SELECT max(id) AS m FROM outbox`))[0]?.m ?? 0);
    const requestHeader = `bulk-commit-${randomUUID()}`;
    const c = await commit(String(p.body["previewId"]), "planner", requestHeader);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({ autoApproved: false, versions: 4, policy: { name: "Standard" } });
    const drafts = await owner.envelopeVersion.findMany({ where: { envelopeId: { in: ids }, status: "PENDING" }, include: { phasing: true } });
    expect(drafts).toHaveLength(4);
    for (const d of drafts) {
      expect(d.phasing).toHaveLength(12); // the head's monthly shape, re-scaled
      expect(d.phasing.reduce((s, x) => s.plus(x.amount.toString()), new Decimal(0)).toFixed(2)).toBe(d.amount.toFixed(2));
    }
    const audits = await owner.$queryRawUnsafe<Array<{ action: string; n: bigint }>>(`SELECT action, count(*) AS n FROM audit_event WHERE request_id = $1 GROUP BY action`, requestHeader);
    expect(Object.fromEntries(audits.map((a) => [a.action, Number(a.n)]))).toEqual({ "envelope.version.created": 4, "bulk.committed": 1 });
    const outbox = await owner.$queryRawUnsafe<Array<{ topic: string; payload: { bulk: boolean; versionIds: string[] } }>>(`SELECT topic, payload FROM outbox WHERE workspace_id = $1::uuid AND id > $2`, golden.workspaceId, maxOutbox);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ topic: "budget.changed", payload: { bulk: true } });
    expect(outbox[0]?.payload.versionIds).toHaveLength(4);

    // The single request routes through its chain; the last approval approves every row.
    const requestId = String(c.body["requestId"]);
    const inbox = (await as("budgetOwner", "GET", "/api/v1/approvals?assignee=me")).body["rows"] as Array<{ id: string; entityType: string; rows: number }>;
    expect(inbox.find((r) => r.id === requestId)).toMatchObject({ entityType: "bulk_change", rows: 4 });
    expect((await approve(requestId, "planner")).status).toBe(403); // the author cannot approve
    expect((await approve(requestId, "budgetOwner")).status).toBe(201);
    expect((await approve(requestId, "approver")).status).toBe(201);
    for (const r of rows) expect((await current(r.envelopeId)).current?.amount).toBe(r.after);
    const detail = (await as("planner", "GET", `/api/v1/approvals/${requestId}`)).body as { status: string; rows: Array<{ status: string }> };
    expect(detail.status).toBe("APPROVED");
    expect(detail.rows.every((r) => r.status === "APPROVED")).toBe(true);
  });

  it("a below-threshold bulk edit auto-approves per policy", async () => {
    const key = leafKeys("LATAM/MX/tiktok/awareness")[0] as string;
    const p = await preview([id(key)], { op: "pct", pct: 1 });
    const c = await commit(String(p.body["previewId"]));
    expect(c.body).toMatchObject({ autoApproved: true, requestId: null, policy: { name: "Auto-approve minor" } });
    expect((await current(id(key))).current?.amount).toBe(round3(key).mul(1.01).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));
  });

  it("a row edited after the preview makes the commit a 409 and nothing is written", async () => {
    const keys = leafKeys("LATAM/MX/meta/conversion");
    const p = await preview(keys.map(id), { op: "add", amount: "100" });
    const env = await current(id(keys[0] as string));
    expect((await as("planner", "PATCH", `/api/v1/envelopes/${id(keys[0] as string)}/draft`, { amount: "1.00", basedOnVersionId: env.currentVersionId })).status).toBe(200);
    const bulkBefore = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM bulk_change WHERE workspace_id = $1::uuid`, golden.workspaceId);
    const c = await commit(String(p.body["previewId"]));
    expect(c.status).toBe(409);
    expect((c.body["details"] as { changed: string[] }).changed).toEqual([id(keys[0] as string)]);
    const bulkAfter = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM bulk_change WHERE workspace_id = $1::uuid`, golden.workspaceId);
    expect(bulkAfter[0]?.n).toBe(bulkBefore[0]?.n);
  });
});

describe("operations", () => {
  it("cap violations show in the preview and route to Major", async () => {
    const parentKey = "LATAM/CO/meta/awareness";
    const parentAmount = new Decimal(byKey.get(parentKey)?.versions[0]?.amount ?? 0);
    const p = await preview(leafKeys(parentKey).map(id), { op: "set", amount: parentAmount.toFixed(2) });
    expect(p.body["capViolations"]).toEqual([{ parentId: id(parentKey), parentAmount: parentAmount.toFixed(2), childrenAfter: parentAmount.mul(2).toFixed(2) }]);
    expect((p.body["policyPreview"] as { name: string }).name).toBe("Major / over-allocation");
  });

  it("redistribute proportionally from the parent's approved amount, to the cent", async () => {
    const parentKey = "LATAM/CO/google_ads/consideration";
    const parentAmount = new Decimal(byKey.get(parentKey)?.versions[0]?.amount ?? 0);
    const p = await preview(leafKeys(parentKey).map(id), { op: "redistribute", parentId: id(parentKey), method: "proportional" });
    const rows = p.body["rows"] as Array<{ after: string }>;
    expect(rows.reduce((s, r) => s.plus(r.after), new Decimal(0)).toFixed(2)).toBe(parentAmount.toFixed(2));
    expect(p.body["capViolations"]).toEqual([]);
    const notChildren = await preview([id(leafKeys("LATAM/AR/meta/awareness")[0] as string)], { op: "redistribute", parentId: id(parentKey), method: "even" });
    expect(notChildren.status).toBe(422);
  });

  it("scale_to_total hits the total exactly", async () => {
    const keys = leafKeys("EMEA/DE/tiktok");
    const p = await preview(keys.map(id), { op: "scale_to_total", total: "100000.01" });
    expect(p.body["totalsAfter"]).toBe("100000.01");
  });

  it("copy_previous_period skips everything when there is no previous period, and a preview with no rows cannot be committed", async () => {
    const p = await preview(leafKeys("EMEA/DE/meta").map(id), { op: "copy_previous_period", factor: 1 });
    expect(p.body["rows"]).toEqual([]);
    expect((p.body["skipped"] as Array<{ reason: string }>).every((s) => s.reason.startsWith("no approved previous period"))).toBe(true);
    expect((await commit(String(p.body["previewId"]))).status).toBe(404);
  });

  it("a filter selection resolves through the planner; rows awaiting approval are skipped, not changed", async () => {
    const filter = (platform: string) => ({
      logic: "and",
      children: [
        { field: { kind: "dimension", key: "region" }, op: "eq", value: "EMEA" },
        { field: { kind: "dimension", key: "platform" }, op: "eq", value: platform },
        { field: { kind: "dimension", key: "audience" }, op: "not_empty" },
      ],
    });
    const body = (platform: string) => ({ workspaceId: golden.workspaceId, selection: { filter: filter(platform) }, operation: { op: "pct", pct: 3 }, rationale: "filter test" });
    const google = await as("planner", "POST", "/api/v1/envelopes/bulk", body("google_ads"));
    expect((google.body["rows"] as unknown[]).length).toBe(24);
    const amazon = await as("planner", "POST", "/api/v1/envelopes/bulk", body("amazon")); // pending bulk from the golden seed
    expect(amazon.body["rows"]).toEqual([]);
    expect((amazon.body["skipped"] as Array<{ reason: string }>).filter((s) => s.reason === "a version is awaiting approval")).toHaveLength(24);
  });

  it("paste applies explicit amounts, only inside the selection", async () => {
    const [a, b] = leafKeys("EMEA/FR/tiktok/awareness").map(id) as [string, string];
    const ok = await preview([a, b], { op: "paste", rows: [{ envelopeId: a, amount: "1234.56" }] });
    expect(ok.body["rows"]).toMatchObject([{ envelopeId: a, after: "1234.56" }]);
    const outside = await preview([a], { op: "paste", rows: [{ envelopeId: b, amount: "1" }] });
    expect(outside.status).toBe(422);
  });

  it("guards: row limit, workspace, author-only commit, unknown preview", async () => {
    const tooMany = await preview(Array.from({ length: 10_001 }, () => randomUUID()), { op: "set", amount: "1" });
    expect([400, 422]).toContain(tooMany.status);
    const mismatch = await as("planner", "POST", "/api/v1/envelopes/bulk", { workspaceId: randomUUID(), selection: { envelopeIds: [id(leafKeys("EMEA/ES")[0] as string)] }, operation: { op: "set", amount: "1" }, rationale: "x-ws" });
    expect(mismatch.status).toBe(422);
    const p = await preview([id(leafKeys("EMEA/ES/meta")[0] as string)], { op: "add", amount: "5" });
    expect((await commit(String(p.body["previewId"]), "admin")).status).toBe(403);
    expect((await commit(randomUUID())).status).toBe(404);
  });
});

describe("CSV round trip and the end of a bulk request", () => {
  it("export → edit → import gives a validated diff; commit; reject restores the approved amounts", async () => {
    const keys = leafKeys("LATAM/AR/tiktok");
    const exported = await as("planner", "POST", `/api/v1/workspaces/${golden.workspaceId}/envelopes/csv-export`, { selection: { envelopeIds: keys.map(id) } });
    expect(exported.status).toBe(201);
    const table = parseCsv(exported.text);
    expect(table[0]).toEqual(["envelope_id", "path", "currency", "approved_amount", "amount"]);
    expect(table).toHaveLength(keys.length + 1);
    const edited = table.slice(1).map((r, i) => (i < 2 ? [r[0] as string, r[1] as string, r[2] as string, r[3] as string, `${Number(r[4]) + 100}`] : r));
    const csv = toCsv(table[0] as string[], [...edited, [randomUUID(), "unknown", "USD", "", "5"], [id(keys[3] as string), "bad", "USD", "", "12.345"], ["not-a-uuid", "x", "USD", "", "1"]]);
    const imported = await as("planner", "POST", `/api/v1/workspaces/${golden.workspaceId}/envelopes/csv-import`, { csv, rationale: "edited in Sheets" });
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    const report = imported.body as { rowsRead: number; errors: Array<{ line: number; message: string }>; preview: { previewId: string; rows: unknown[]; skipped: Array<{ reason: string }> } };
    expect(report.rowsRead).toBe(keys.length + 3);
    expect(report.errors.map((e) => e.line)).toEqual([keys.length + 2, keys.length + 3, keys.length + 4]);
    expect(report.preview.rows).toHaveLength(2); // the other rows are unchanged
    const c = await commit(report.preview.previewId);
    expect(c.status).toBe(201);
    const requestId = String(c.body["requestId"]);
    expect((await approve(requestId, "budgetOwner", "reject", "not this month")).status).toBe(201);
    for (const k of keys.slice(0, 2)) {
      const e = await current(id(k));
      expect(e.current?.amount).toBe(round3(k).toFixed(2));
      expect(e.draftVersionId).toBeNull();
      expect(e.status).toBe("APPROVED");
    }
    const rejected = await owner.envelopeVersion.count({ where: { envelopeId: { in: keys.slice(0, 2).map(id) }, status: "REJECTED" } });
    expect(rejected).toBe(2);
  });

  it("request changes on a bulk request opens a blocking thread on the request and reopens the drafts", async () => {
    const keys = leafKeys("LATAM/BR/tiktok/conversion");
    const p = await preview(keys.map(id), { op: "pct", pct: 20 });
    const c = await commit(String(p.body["previewId"]));
    const requestId = String(c.body["requestId"]);
    expect((await approve(requestId, "budgetOwner", "request_changes", "split by retailer")).status).toBe(201);
    const thread = await owner.thread.findFirstOrThrow({ where: { anchorType: "approval_request", anchorId: requestId } });
    expect(thread.isBlocking).toBe(true);
    const drafts = await owner.envelopeVersion.findMany({ where: { envelopeId: { in: keys.map(id) } }, orderBy: { versionNo: "desc" }, distinct: ["envelopeId"] });
    expect(drafts.every((d) => d.status === "DRAFT")).toBe(true);
  });
});
