import { randomUUID } from "node:crypto";
import { asOrgAdmin, goldenPlan, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";
import { respread } from "./commands/change-dates.js";

/**
 * R9-002 done-when (ADR-060): a budget's dates are editable. An approved budget's new dates go
 * through its approval policy and apply on approval, with each budget's phasing re-spread into
 * them; children that fall outside are listed first and trimmed only when asked; a rejection
 * changes nothing; a budget never approved changes at once; a child never leaves its parent.
 */
const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `dates-${randomUUID().slice(0, 8)}`;
const plan = goldenPlan();

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, requestId?: string) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId, ...(requestId ? { "x-request-id": requestId } : {}) }, ...(body === undefined ? {} : { body }) });
}
const id = (key: string) => golden.envelopeIds.get(key) as string;
// W0-6: the owner has no BYPASSRLS; every owner.* call below needs the same org-admin tenant
// context real reads/writes get from withTenant, scoped to the golden workspace's org.
const admin = <T>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, golden.orgId);
const kids = (key: string) => plan.filter((e) => e.parentKey === key).map((e) => id(e.key));
interface EnvView {
  status: string;
  startDate: string;
  endDate: string;
  rowVersion: number;
  currentVersionId: string | null;
  draftVersionId: string | null;
  current: { amount: string } | null;
  pendingKind: string | null;
}
const env = async (envelopeId: string) => (await as("admin", "GET", `/api/v1/envelopes/${envelopeId}`)).body as unknown as EnvView;
const phasing = async (versionId: string) =>
  (await admin((tx) => tx.$queryRawUnsafe<Array<{ month: string; amount: string }>>(`SELECT month::text AS month, amount::text AS amount FROM envelope_phasing WHERE version_id = $1::uuid ORDER BY month`, versionId)));
/** Two months off the end: 31 Dec becomes 31 Oct. */
const twoMonthsEarlier = (d: string) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 2, 0)).toISOString().slice(0, 10);

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("respread", () => {
  it("keeps the shape of months still inside, else spreads by days; always the same total", () => {
    const shape = [
      { month: "2026-01-01", amount: new Decimal("100.00") },
      { month: "2026-02-01", amount: new Decimal("200.00") },
      { month: "2026-03-01", amount: new Decimal("300.00") },
    ];
    expect(respread(shape, new Decimal(600), { startDate: "2026-01-01", endDate: "2026-02-28" })).toEqual([
      { month: "2026-01-01", amount: "200.00" },
      { month: "2026-02-01", amount: "400.00" },
    ]);
    // Moved wholly into Q2: 30, 31 and 30 days.
    const moved = respread(shape, new Decimal(600), { startDate: "2026-04-01", endDate: "2026-06-30" });
    expect(moved?.map((p) => p.month)).toEqual(["2026-04-01", "2026-05-01", "2026-06-01"]);
    expect(moved?.reduce((s, p) => s.plus(p.amount), new Decimal(0)).toFixed(2)).toBe("600.00");
    expect(moved?.[1]?.amount).toBe("204.40");
    expect(respread([], new Decimal(600), { startDate: "2026-04-01", endDate: "2026-06-30" })).toBeUndefined();
  });
});

describe("change a budget's dates (R9-002)", () => {
  const parentKey = "EMEA/DE/meta/awareness";

  it("the preview lists the children the new dates trim, and says it needs approval", async () => {
    const parent = await env(id(parentKey));
    const endDate = twoMonthsEarlier(parent.endDate);
    const res = await as("planner", "POST", `/api/v1/envelopes/${id(parentKey)}/dates/preview`, { startDate: parent.startDate, endDate, basedOnVersionId: parent.draftVersionId ?? parent.currentVersionId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const lines = res.body["lines"] as Array<{ envelopeId: string; to: { endDate: string } }>;
    expect(lines[0]?.envelopeId).toBe(id(parentKey));
    expect(new Set(lines.slice(1).map((l) => l.envelopeId))).toEqual(new Set(kids(parentKey)));
    expect(lines.every((l) => l.to.endDate === endDate)).toBe(true);
    expect(res.body).toMatchObject({ childrenOutside: kids(parentKey).length, needsApproval: true });
    expect(Number(res.body["movedShare"])).toBeGreaterThan(0.1);
    // Nothing changed.
    expect((await env(id(parentKey))).endDate).toBe(parent.endDate);
  });

  it("refuses to trim children unless asked; then waits for approval and applies on approval", async () => {
    const parent = await env(id(parentKey));
    const body = { startDate: parent.startDate, endDate: twoMonthsEarlier(parent.endDate), basedOnVersionId: parent.draftVersionId ?? parent.currentVersionId, rationale: "campaign moved" };
    const refused = await as("planner", "POST", `/api/v1/envelopes/${id(parentKey)}/dates`, body);
    expect(refused.status).toBe(409);
    expect((refused.body["details"] as { children: unknown[] }).children).toHaveLength(kids(parentKey).length);

    const requestId = `dates-${randomUUID()}`;
    const res = await as("planner", "POST", `/api/v1/envelopes/${id(parentKey)}/dates`, { ...body, trimChildren: true }, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ applied: false, autoApproved: false });
    const waiting = await env(id(parentKey));
    expect(waiting).toMatchObject({ status: "PENDING", endDate: parent.endDate, pendingKind: "dates" });
    const audits = await admin((tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1`, requestId));
    // The date change, and (S-003) the request it waits in, announced like every other request.
    expect(audits.map((a) => a.action).sort()).toEqual(["approval.requested", "envelope.dates_requested"]);
    const out = await admin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND payload->>'kind' = 'dates' AND payload->>'requestId' = $2`, golden.workspaceId, String(res.body["requestId"])));
    expect(Number(out[0]?.n)).toBe(1);

    // The admin's approval is final (ADR-048): every budget gets its dates and a re-phased version with the same amount.
    expect((await as("admin", "POST", `/api/v1/approvals/${String(res.body["requestId"])}/decisions`, { decision: "approve" })).status).toBe(201);
    for (const envelopeId of [id(parentKey), ...kids(parentKey)]) {
      const before = golden.envelopeIds.get(parentKey) === envelopeId ? parent : null;
      const done = await env(envelopeId);
      expect(done).toMatchObject({ status: "APPROVED", endDate: body.endDate, draftVersionId: null });
      if (before) expect(done.current?.amount).toBe(before.current?.amount);
      const months = await phasing(done.currentVersionId as string);
      if (months.length) {
        expect(months.every((m) => m.month <= body.endDate)).toBe(true);
        expect(months.reduce((s, m) => s.plus(m.amount), new Decimal(0)).toFixed(2)).toBe(done.current?.amount);
      }
    }
  });

  it("a rejected change leaves every budget as it was", async () => {
    const key = "EMEA/DE/meta/consideration";
    const parent = await env(id(key));
    const res = await as("planner", "POST", `/api/v1/envelopes/${id(key)}/dates`, { startDate: parent.startDate, endDate: twoMonthsEarlier(parent.endDate), basedOnVersionId: parent.draftVersionId ?? parent.currentVersionId, trimChildren: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await as("budgetOwner", "POST", `/api/v1/approvals/${String(res.body["requestId"])}/decisions`, { decision: "reject", comment: "keep the dates" })).status).toBe(201);
    expect(await env(id(key))).toMatchObject({ status: "APPROVED", endDate: parent.endDate, currentVersionId: parent.currentVersionId, draftVersionId: null });
    for (const k of kids(key)) expect((await env(k)).status).toBe("APPROVED");
  });

  it("a child never leaves its parent's dates", async () => {
    const leaf = kids("EMEA/DE/meta/conversion")[0] as string;
    const e = await env(leaf);
    const res = await as("admin", "POST", `/api/v1/envelopes/${leaf}/dates`, { startDate: e.startDate, endDate: `${Number(e.endDate.slice(0, 4)) + 1}-06-30`, basedOnVersionId: e.draftVersionId ?? e.currentVersionId });
    expect(res.status).toBe(422);
    expect(String(res.body["message"])).toContain("change its dates first");
  });

  it("a budget never approved changes at once, its draft re-phased; PATCH cannot move an approved budget's dates", async () => {
    const parentId = id("EMEA/DE/meta/conversion");
    const parent = await env(parentId);
    const created = await as("admin", "POST", `/api/v1/workspaces/${golden.workspaceId}/envelopes`, {
      name: "Dates draft",
      parentId,
      dimensionValues: { ...((plan.find((p) => p.key === "EMEA/DE/meta/conversion")?.dimensionValues ?? {}) as Record<string, string>) },
      startDate: parent.startDate,
      endDate: parent.endDate,
      currency: "USD",
      amount: "1200.00",
      phasing: [{ month: `${parent.endDate.slice(0, 7)}-01`, amount: "1200.00" }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const draftId = String(created.body["id"]);
    const d = await env(draftId);
    const endDate = twoMonthsEarlier(parent.endDate);
    const requestId = `dates-${randomUUID()}`;
    const res = await as("planner", "POST", `/api/v1/envelopes/${draftId}/dates`, { startDate: d.startDate, endDate, basedOnVersionId: d.draftVersionId }, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ applied: true, requestId: null });
    const after = await env(draftId);
    expect(after).toMatchObject({ status: "DRAFT", endDate });
    const months = await phasing(after.draftVersionId as string);
    expect(months.every((m) => m.month <= endDate)).toBe(true);
    expect(months.reduce((s, m) => s.plus(m.amount), new Decimal(0)).toFixed(2)).toBe("1200.00");
    const audits = await admin((tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1`, requestId));
    expect(audits.map((a) => a.action)).toContain("envelope.dates_changed");

    const approved = await env(parentId);
    const patch = await as("admin", "PATCH", `/api/v1/envelopes/${parentId}`, { rowVersion: approved.rowVersion, endDate });
    expect(patch.status).toBe(422);
  });
});

/**
 * W3-5 (audit I-17): the approval re-checks what the request checked. A budget moved, re-dated or
 * ended while its dates wait, or a child that would fall outside them, sends the request back
 * (CHANGES_REQUESTED, with the reason) instead of writing dates that break the tree. Every line of
 * the request is held while it is open.
 */
describe("a dates approval re-validates the tree (W3-5)", () => {
  const dims = (key: string) => ({ ...((plan.find((p) => p.key === key)?.dimensionValues ?? {}) as Record<string, string>) });
  const request = async (envelopeId: string, endDate: string, trimChildren = false) => {
    const e = await env(envelopeId);
    const res = await as("planner", "POST", `/api/v1/envelopes/${envelopeId}/dates`, { startDate: e.startDate, endDate, basedOnVersionId: e.draftVersionId ?? e.currentVersionId, trimChildren, rationale: "W3-5" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ applied: false, autoApproved: false });
    return String(res.body["requestId"]);
  };
  const approve = (requestId: string, xRequestId?: string) => as("admin", "POST", `/api/v1/approvals/${requestId}/decisions`, { decision: "approve" }, xRequestId);
  const draftChild = async (parentKey: string, name: string) => {
    const parent = await env(id(parentKey));
    const res = await as("admin", "POST", `/api/v1/workspaces/${golden.workspaceId}/envelopes`, { name, parentId: id(parentKey), dimensionValues: dims(parentKey), startDate: parent.startDate, endDate: parent.endDate, currency: "USD", amount: "900.00" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return String(res.body["id"]);
  };
  /** The request went back with the reason: status, blocking thread, one audit row and one outbox row. */
  async function expectSentBack(requestId: string, reason: string) {
    expect((await admin((tx) => tx.approvalRequest.findUniqueOrThrow({ where: { id: requestId } }))).status).toBe("CHANGES_REQUESTED");
    const audits = await admin((tx) => tx.$queryRawUnsafe<Array<{ after: { stale?: { reason?: string } } }>>(`SELECT after FROM audit_event WHERE entity_id = $1::uuid AND action = 'approval.request_changes'`, requestId));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after.stale?.reason).toBe(reason);
    const [out] = await admin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE topic = 'approval.changed' AND payload->>'requestId' = $1 AND payload->>'action' = 'approval.request_changes'`, requestId));
    expect(Number(out?.n)).toBe(1);
    const thread = await admin((tx) => tx.thread.findFirstOrThrow({ where: { anchorType: "approval_request", anchorId: requestId, isBlocking: true }, include: { comments: true } }));
    expect(thread.comments[0]?.bodyMd).toContain("re-request the dates");
  }

  it("(a) a budget moved under a shorter parent while it waits: the approval sends the request back and writes no dates", async () => {
    const leaf = kids("EMEA/FR/meta/awareness")[0] as string;
    const before = await env(leaf);
    const requestId = await request(leaf, twoMonthsEarlier(before.endDate));
    expect((await env(leaf)).status).toBe("PENDING");
    // The interleaving of audit I-17: a move that went through while the dates waited (the hold now
    // refuses it, so it is written directly) put the budget under a parent that runs Q1 only.
    const shortParent = id("EMEA/FR/google_ads/awareness");
    await admin(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE envelope SET end_date = '2026-03-31' WHERE id = $1::uuid`, shortParent);
      await tx.$executeRawUnsafe(`UPDATE envelope SET parent_id = $2::uuid WHERE id = $1::uuid`, leaf, shortParent);
    });

    const res = await approve(requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body["details"]).toMatchObject({ envelopeId: leaf, reason: "moved" });
    expect(String(res.body["message"])).toContain("re-request the dates");
    await expectSentBack(requestId, "moved");
    expect(await env(leaf)).toMatchObject({ status: "APPROVED", startDate: before.startDate, endDate: before.endDate, currentVersionId: before.currentVersionId });
  }, 120_000);

  it("(b) a never-approved child the request trims is held; a re-date that slipped through is not reverted", async () => {
    const parentKey = "EMEA/FR/meta/consideration";
    const parent = await env(id(parentKey));
    const childId = await draftChild(parentKey, "W3-5 held draft");
    const requestId = await request(id(parentKey), twoMonthsEarlier(parent.endDate), true);
    const held = await env(childId);
    expect(held.status).toBe("PENDING");

    // Held: not re-dated (either route), moved or ended while the request is open.
    const waiting = `Waiting for approval: request ${requestId}`;
    const redate = await as("admin", "POST", `/api/v1/envelopes/${childId}/dates`, { startDate: held.startDate, endDate: "2026-09-30", basedOnVersionId: held.draftVersionId });
    expect(redate.status, JSON.stringify(redate.body)).toBe(409);
    expect(redate.body["message"]).toBe(waiting);
    const patch = await as("admin", "PATCH", `/api/v1/envelopes/${childId}`, { rowVersion: held.rowVersion, endDate: "2026-09-30" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(409);
    expect(patch.body["message"]).toBe(waiting);
    const moved = await as("admin", "POST", `/api/v1/envelopes/${childId}/move`, { parentId: id("EMEA/FR/meta/conversion"), rowVersion: held.rowVersion });
    expect(moved.status, JSON.stringify(moved.body)).toBe(409);
    expect(moved.body["message"]).toBe(waiting);

    // The interleaving of audit I-17: the child was re-dated at once (it has no approved amount).
    await admin((tx) => tx.$executeRawUnsafe(`UPDATE envelope SET end_date = '2026-09-30', row_version = row_version + 1 WHERE id = $1::uuid`, childId));
    const res = await approve(requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body["details"]).toMatchObject({ envelopeId: childId, reason: "redated" });
    await expectSentBack(requestId, "redated");
    expect(await env(childId)).toMatchObject({ status: "DRAFT", endDate: "2026-09-30" });
    expect(await env(id(parentKey))).toMatchObject({ status: "APPROVED", endDate: parent.endDate, currentVersionId: parent.currentVersionId });
    for (const k of kids(parentKey)) expect((await env(k)).status).toBe("APPROVED");
  }, 120_000);

  it("a budget moved under it meanwhile that falls outside the new dates sends the request back", async () => {
    const parentKey = "EMEA/FR/tiktok/awareness";
    const parent = await env(id(parentKey));
    const requestId = await request(id(parentKey), twoMonthsEarlier(parent.endDate), true);
    // The new parent is not held: a budget can still move under it, here one that runs the whole year.
    await admin((tx) => tx.envelope.update({ where: { id: id(parentKey) }, data: { allowOverAllocation: true } }));
    const stray = kids("EMEA/FR/tiktok/consideration")[0] as string;
    const moved = await as("planner", "POST", `/api/v1/envelopes/${stray}/move`, { parentId: id(parentKey), rowVersion: (await env(stray)).rowVersion });
    expect(moved.status, JSON.stringify(moved.body)).toBe(201);

    const res = await approve(requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body["details"]).toMatchObject({ envelopeId: id(parentKey), reason: "child_outside", childId: stray });
    await expectSentBack(requestId, "child_outside");
    expect((await env(id(parentKey))).endDate).toBe(parent.endDate);
  }, 120_000);

  it("the happy path still applies every line's dates, with one audit row and one outbox row per line", async () => {
    const parentKey = "EMEA/GB/meta/awareness";
    const parent = await env(id(parentKey));
    const childId = await draftChild(parentKey, "W3-5 trimmed draft");
    const endDate = twoMonthsEarlier(parent.endDate);
    const requestId = await request(id(parentKey), endDate, true);
    const lines = [id(parentKey), ...kids(parentKey), childId];
    for (const l of lines) expect((await env(l)).status).toBe("PENDING");

    // A rename and a draft amount edit while the dates wait change nothing the dates rule reads:
    // the request is not sent back, and the edited budget stays held.
    const renamed = await as("admin", "PATCH", `/api/v1/envelopes/${id(parentKey)}`, { rowVersion: (await env(id(parentKey))).rowVersion, name: "GB meta awareness (renamed while waiting)" });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const draft = await env(childId);
    const edited = await as("admin", "PATCH", `/api/v1/envelopes/${childId}/draft`, { amount: "950.00", basedOnVersionId: draft.draftVersionId });
    expect(edited.status, JSON.stringify(edited.body)).toBeLessThan(300);
    expect((await env(childId)).status).toBe("PENDING");

    const [mark] = await admin((tx) => tx.$queryRawUnsafe<Array<{ id: bigint }>>(`SELECT coalesce(max(id), 0) AS id FROM outbox`));
    const xRequestId = `dates-approve-${randomUUID()}`;
    const res = await approve(requestId, xRequestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body["status"]).toBe("APPROVED");
    for (const l of lines) {
      expect(await env(l)).toMatchObject({ status: l === childId ? "DRAFT" : "APPROVED", endDate });
      const [a] = await admin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE request_id = $1 AND entity_type = 'envelope' AND entity_id = $2::uuid`, xRequestId, l));
      expect(Number(a?.n), `audit for ${l}`).toBe(1);
      const [o] = await admin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE id > $1 AND topic = 'budget.changed' AND payload->>'envelopeId' = $2`, mark?.id ?? 0n, l));
      expect(Number(o?.n), `outbox for ${l}`).toBe(1);
    }
  }, 120_000);
});
