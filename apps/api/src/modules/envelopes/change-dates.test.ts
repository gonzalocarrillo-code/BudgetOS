import { randomUUID } from "node:crypto";
import { goldenPlan } from "@budget/db";
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
  (await owner.$queryRawUnsafe<Array<{ month: string; amount: string }>>(`SELECT month::text AS month, amount::text AS amount FROM envelope_phasing WHERE version_id = $1::uuid ORDER BY month`, versionId));
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
    const audits = await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1`, requestId);
    expect(audits.map((a) => a.action)).toEqual(["envelope.dates_requested"]);
    const out = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND payload->>'kind' = 'dates' AND payload->>'requestId' = $2`, golden.workspaceId, String(res.body["requestId"]));
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
    const audits = await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1`, requestId);
    expect(audits.map((a) => a.action)).toContain("envelope.dates_changed");

    const approved = await env(parentId);
    const patch = await as("admin", "PATCH", `/api/v1/envelopes/${parentId}`, { rowVersion: approved.rowVersion, endDate });
    expect(patch.status).toBe(422);
  });
});
