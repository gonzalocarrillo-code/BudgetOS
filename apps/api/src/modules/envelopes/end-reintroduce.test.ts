import { randomUUID } from "node:crypto";
import { asOrgAdmin, goldenPlan, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/**
 * H-011 / H-012 done-when (docs/BUDGET_HISTORY_PLAN.md §2.8, ADR-053): ending a budget goes through
 * the approval policy (an admin's end applies at once, a planner's waits); the final amount and the
 * end date apply on approval; an ended budget refuses edits; a parent with running children cannot
 * end alone; reintroducing creates a successor with lineage `continues`, alone or inside the end.
 */
const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `end-${randomUUID().slice(0, 8)}`;
const plan = goldenPlan();

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, requestId?: string) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId, ...(requestId ? { "x-request-id": requestId } : {}) }, ...(body === undefined ? {} : { body }) });
}
const id = (key: string) => golden.envelopeIds.get(key) as string;
// W0-6: the owner has no BYPASSRLS; every owner.* read below needs the same org-admin tenant
// context real reads get from withTenant, scoped to the golden workspace's org.
const admin = <T>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, golden.orgId);
const leafKeys = (prefix: string) => plan.filter((e) => e.level === 4 && e.key.startsWith(prefix)).map((e) => e.key);
interface EnvView {
  status: string;
  parentId: string | null;
  endDate: string;
  startDate: string;
  currentVersionId: string | null;
  draftVersionId: string | null;
  current: { amount: string } | null;
  ended: { at: string; reason: string | null } | null;
  pendingKind: string | null;
  openRequest: { id: string } | null;
  lineage: { continues: { id: string; name: string } | null; continuedBy: Array<{ id: string; name: string; ended: boolean }> };
}
const env = async (envelopeId: string) => (await as("admin", "GET", `/api/v1/envelopes/${envelopeId}`)).body as unknown as EnvView;
/** Ends a month before the budget's own end, keeping half of its approved amount. */
async function endBody(envelopeId: string, extra: Record<string, unknown> = {}) {
  const e = await env(envelopeId);
  const endDate = `${e.endDate.slice(0, 5)}${String(Number(e.endDate.slice(5, 7)) - 1).padStart(2, "0")}-15`;
  return { e, body: { endDate, finalAmount: new Decimal(e.current?.amount ?? 0).div(2).toDecimalPlaces(2).toFixed(2), rationale: "campaign stopped", basedOnVersionId: e.currentVersionId, ...extra } };
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

describe("end a budget (H-011)", () => {
  it("an admin's end applies at once: final amount, end date, read-only; audit and outbox", async () => {
    const leaf = id(leafKeys("EMEA/DE/meta/awareness")[0] as string);
    const { e, body } = await endBody(leaf);
    const requestId = `end-${randomUUID()}`;
    const res = await as("admin", "POST", `/api/v1/envelopes/${leaf}/end`, body, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ ended: true, autoApproved: true, requestId: null, successorId: null });
    const after = await env(leaf);
    expect(after).toMatchObject({ status: "APPROVED", endDate: body.endDate, draftVersionId: null });
    expect(after.current?.amount).toBe(body.finalAmount);
    expect(after.ended?.reason).toBe("campaign stopped");
    expect(after.currentVersionId).not.toBe(e.currentVersionId);

    const audits = await admin((tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1 AND entity_id = $2::uuid`, requestId, leaf));
    expect(audits.map((a) => a.action)).toContain("envelope.ended");
    const out = await admin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND payload->>'kind' = 'end' AND payload->>'envelopeId' = $2`, golden.workspaceId, leaf));
    expect(Number(out[0]?.n)).toBe(1);

    // Read-only from now on: a new draft, a move and a second end are refused.
    const draft = await as("admin", "PATCH", `/api/v1/envelopes/${leaf}/draft`, { amount: "1.00", basedOnVersionId: after.currentVersionId });
    expect(draft.status).toBe(423);
    expect(String(draft.body["message"])).toContain("reintroduce");
    expect((await as("admin", "POST", `/api/v1/envelopes/${leaf}/end`, { ...body, basedOnVersionId: after.currentVersionId })).status).toBe(423);
  });

  it("a planner's end waits for approval; nothing applies until it is approved", async () => {
    const policies = (await as("admin", "GET", `/api/v1/workspaces/${golden.workspaceId}/policies`)).body as unknown as Array<{ id: string; name: string; version: number }>;
    const auto = policies.find((p) => p.name === "Auto-approve minor")!;
    expect((await as("admin", "PATCH", `/api/v1/policies/${auto.id}`, { version: auto.version, isActive: false })).status).toBe(200);
    try {
      const leaf = id(leafKeys("EMEA/DE/meta/consideration")[0] as string);
      const { e, body } = await endBody(leaf);
      const res = await as("planner", "POST", `/api/v1/envelopes/${leaf}/end`, body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ ended: false, autoApproved: false });
      const waiting = await env(leaf);
      expect(waiting).toMatchObject({ status: "PENDING", endDate: e.endDate, ended: null, pendingKind: "end" });
      expect(waiting.openRequest?.id).toBe(res.body["requestId"]);
      expect(waiting.current?.amount).toBe(e.current?.amount);

      // The first step's approval moves it on; the admin's approval is final (ADR-048).
      expect((await as("budgetOwner", "POST", `/api/v1/approvals/${String(res.body["requestId"])}/decisions`, { decision: "approve" })).status).toBe(201);
      expect((await env(leaf)).ended).toBeNull();
      expect((await as("admin", "POST", `/api/v1/approvals/${String(res.body["requestId"])}/decisions`, { decision: "approve" })).status).toBe(201);
      const done = await env(leaf);
      expect(done).toMatchObject({ status: "APPROVED", endDate: body.endDate });
      expect(done.ended).not.toBeNull();
      expect(done.current?.amount).toBe(body.finalAmount);

      // A rejected end leaves the budget as it was.
      const other = id(leafKeys("EMEA/DE/meta/consideration")[1] as string);
      const second = await endBody(other);
      const rejected = await as("planner", "POST", `/api/v1/envelopes/${other}/end`, second.body);
      expect((await as("budgetOwner", "POST", `/api/v1/approvals/${String(rejected.body["requestId"])}/decisions`, { decision: "reject", comment: "keep it running" })).status).toBe(201);
      expect(await env(other)).toMatchObject({ status: "APPROVED", endDate: second.e.endDate, ended: null, currentVersionId: second.e.currentVersionId });
    } finally {
      const now = ((await as("admin", "GET", `/api/v1/workspaces/${golden.workspaceId}/policies`)).body as unknown as Array<{ id: string; version: number }>).find((p) => p.id === auto.id)!;
      await as("admin", "PATCH", `/api/v1/policies/${auto.id}`, { version: now.version, isActive: true });
    }
  });

  it("refuses a parent with running children, a date outside the budget, and a stale version", async () => {
    const parentKey = "EMEA/FR/meta/awareness";
    const parent = await endBody(id(parentKey));
    const res = await as("admin", "POST", `/api/v1/envelopes/${id(parentKey)}/end`, parent.body);
    expect(res.status).toBe(409);
    expect(res.body["details"]).toMatchObject({ liveChildren: expect.any(Number) });
    const leaf = id(leafKeys("EMEA/FR/meta/awareness")[0] as string);
    const { body } = await endBody(leaf);
    expect((await as("admin", "POST", `/api/v1/envelopes/${leaf}/end`, { ...body, endDate: "1999-01-01" })).status).toBe(422);
    expect((await as("admin", "POST", `/api/v1/envelopes/${leaf}/end`, { ...body, basedOnVersionId: randomUUID() })).status).toBe(409);
    expect((await as("admin", "POST", `/api/v1/envelopes/${leaf}/end`, { ...body, finalAmount: "-1.00" })).status).toBe(422);
  });
});

describe("the dialog's helpers", () => {
  it("previews an end without writing it, and reports spend to a date in the budget's currency", async () => {
    const leaf = id(leafKeys("EMEA/FR/meta/conversion")[0] as string);
    const { e, body } = await endBody(leaf);
    const preview = await as("planner", "POST", "/api/v1/envelopes/structure/preview", { op: "end", envelopeId: leaf, input: body });
    expect(preview.status, JSON.stringify(preview.body)).toBeLessThan(300);
    expect(preview.body).toMatchObject({ ok: true, op: "end" });
    expect(await env(leaf)).toMatchObject({ endDate: e.endDate, ended: null, currentVersionId: e.currentVersionId });
    const spend = await as("planner", "GET", `/api/v1/envelopes/${leaf}/spend?through=${body.endDate}`);
    expect(spend.status).toBe(200);
    expect(spend.body).toMatchObject({ through: body.endDate, currency: expect.any(String), spend: expect.stringMatching(/^\d+\.\d{2}$/) });
    expect((await as("planner", "GET", `/api/v1/envelopes/${leaf}/spend?through=soon`)).status).toBe(422);
  });
});

describe("reintroduce a budget (H-012)", () => {
  it("after the end: a successor under the same parent, lineage `continues` both ways", async () => {
    const leafKey = leafKeys("EMEA/FR/meta/consideration")[0] as string;
    const leaf = id(leafKey);
    expect((await as("admin", "POST", `/api/v1/envelopes/${leaf}/reintroduce`, { startDate: "2027-01-01", endDate: "2027-03-31", amount: "10.00" })).status).toBe(409); // not ended
    const { e, body } = await endBody(leaf);
    expect((await as("admin", "POST", `/api/v1/envelopes/${leaf}/end`, body)).status).toBe(201);
    const released = new Decimal(e.current?.amount ?? 0).minus(body.finalAmount);
    const tooEarly = await as("admin", "POST", `/api/v1/envelopes/${leaf}/reintroduce`, { startDate: body.endDate, endDate: e.endDate, amount: "1.00" });
    expect(tooEarly.status).toBe(422);
    const start = new Date(`${body.endDate}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() + 1);
    const res = await as("admin", "POST", `/api/v1/envelopes/${leaf}/reintroduce`, { startDate: start.toISOString().slice(0, 10), endDate: e.endDate, amount: released.toFixed(2), rationale: "relaunch" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const successorId = String(res.body["successorId"]);
    const successor = await env(successorId);
    expect(successor).toMatchObject({ status: "APPROVED", parentId: e.parentId, startDate: start.toISOString().slice(0, 10), endDate: e.endDate, ended: null });
    expect(successor.current?.amount).toBe(released.toFixed(2));
    expect(successor.lineage.continues?.id).toBe(leaf);
    expect((await env(leaf)).lineage.continuedBy.map((c) => c.id)).toEqual([successorId]);
    const [src, created] = await admin((tx) => Promise.all([tx.envelope.findUniqueOrThrow({ where: { id: leaf } }), tx.envelope.findUniqueOrThrow({ where: { id: successorId } })]));
    expect(created.dimensionValues).toEqual(src.dimensionValues);
    expect(created.currency).toBe(src.currency);
    expect(created.ownerId).toBe(src.ownerId);
  });

  it("inside the end: one request ends the budget and starts its successor", async () => {
    const leaf = id(leafKeys("EMEA/FR/meta/consideration")[1] as string);
    const { e, body } = await endBody(leaf);
    const start = new Date(`${body.endDate}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() + 1);
    const amount = new Decimal(e.current?.amount ?? 0).minus(body.finalAmount).toFixed(2);
    const res = await as("admin", "POST", `/api/v1/envelopes/${leaf}/end`, { ...body, successor: { name: "FR meta consideration · relaunch", startDate: start.toISOString().slice(0, 10), endDate: e.endDate, amount } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const successorId = String(res.body["successorId"]);
    expect((await env(leaf)).ended).not.toBeNull();
    const successor = await env(successorId);
    expect(successor).toMatchObject({ status: "APPROVED", parentId: e.parentId });
    expect(successor.current?.amount).toBe(amount);
    expect(await admin((tx) => tx.envelopeLineage.count({ where: { fromEnvelopeId: leaf, toEnvelopeId: successorId, kind: "continues" } }))).toBe(1);
  });

  // W3-3 (audit I-28): reintroduceIn() read the source with no lock, so two concurrent reintroduces
  // of the same ended budget both passed the `endedAt !== null` check and both created a successor.
  // It now locks the source row (lockEnvelope, FOR UPDATE) before checking, and
  // envelope_lineage_continues_source (20261015010000_partial_unique_constraints) is the database
  // backstop: exactly one `continues` row per source, ever.
  it("W3-3 (audit I-28): two concurrent reintroduces of the same ended budget make exactly one successor", async () => {
    const leaf = id(leafKeys("EMEA/FR/meta/conversion")[0] as string);
    const { e, body } = await endBody(leaf);
    expect((await as("admin", "POST", `/api/v1/envelopes/${leaf}/end`, body)).status).toBe(201);
    const released = new Decimal(e.current?.amount ?? 0).minus(body.finalAmount);
    const start = new Date(`${body.endDate}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() + 1);
    const reintroduceBody = { startDate: start.toISOString().slice(0, 10), endDate: e.endDate, amount: released.toFixed(2), rationale: "race" };
    const [a, b] = await Promise.all([
      as("admin", "POST", `/api/v1/envelopes/${leaf}/reintroduce`, reintroduceBody),
      as("admin", "POST", `/api/v1/envelopes/${leaf}/reintroduce`, reintroduceBody),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await owner.envelopeLineage.count({ where: { fromEnvelopeId: leaf, kind: "continues" } })).toBe(1);
  });
});
