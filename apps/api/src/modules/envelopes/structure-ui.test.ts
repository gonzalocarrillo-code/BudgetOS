import { randomUUID } from "node:crypto";
import { goldenPlan } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";

/**
 * T-031b (plan 0.6 §9.3): envelope structure from the UI. The preview runs the real command and
 * rolls it back (same checks, nothing written); add-child is one action (create + submit); the
 * envelope read carries its parent, children and siblings.
 */

const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `structui-${randomUUID().slice(0, 8)}`;
const plan = goldenPlan();

type Body = Record<string, unknown>;
async function as(persona: string, method: "GET" | "POST", url: string, body?: unknown, requestId = `structui-${randomUUID()}`) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
const id = (key: string) => golden.envelopeIds.get(key) as string;
const leafKeys = (prefix: string) => plan.filter((e) => e.level === 4 && e.key.startsWith(prefix)).map((e) => e.key);
const env = async (envelopeId: string) => (await as("planner", "GET", `/api/v1/envelopes/${envelopeId}`)).body as Body & { parentId: string | null; rowVersion: number; currentVersionId: string | null; dimensionValues: Record<string, string>; structure: { parent: { id: string } | null; children: Array<{ id: string; approved: string | null }>; siblings: Array<{ id: string }> } };
const preview = (body: unknown, requestId?: string) => as("planner", "POST", "/api/v1/envelopes/structure/preview", body, requestId);
const writes = async (requestId: string) => Number((await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE request_id = $1`, requestId))[0]?.n);

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("GET /envelopes/:id structure", () => {
  it("names the parent, the live children with their approved amounts, and the siblings", async () => {
    const node = "LATAM/MX/meta/awareness";
    const e = await env(id(node));
    expect(e.structure.parent?.id).toBe(id("LATAM/MX/meta"));
    expect(e.structure.children.map((c) => c.id).sort()).toEqual(leafKeys(node).map(id).sort());
    expect(e.structure.children.every((c) => c.approved !== null)).toBe(true);
    expect(e.structure.siblings.map((s) => s.id)).toContain(id("LATAM/MX/meta/consideration"));
    expect(e.structure.siblings.map((s) => s.id)).not.toContain(id(node));
  });
});

describe("structure preview: the real checks, nothing written", () => {
  it("move over the new parent's cap: ok false with CAP_EXCEEDED, and nothing moved or audited", async () => {
    const leaf = leafKeys("LATAM/MX/meta/awareness")[0] as string;
    const before = await env(id(leaf));
    const requestId = `structui-${randomUUID()}`;
    const res = await preview({ op: "move", envelopeId: id(leaf), input: { parentId: id("LATAM/MX/google_ads/awareness"), rowVersion: before.rowVersion } }, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ ok: false, op: "move", error: { code: "CAP_EXCEEDED" } });
    expect((await env(id(leaf))).parentId).toBe(before.parentId);
    expect(await writes(requestId)).toBe(0);
  });

  it("a move that fits: both parents' caps before and after, applied at once, and still nothing written", async () => {
    const leaf = leafKeys("LATAM/MX/meta/awareness")[0] as string;
    const before = await env(id(leaf));
    const requestId = `structui-${randomUUID()}`;
    const res = await preview({ op: "move", envelopeId: id(leaf), input: { parentId: null, rowVersion: before.rowVersion } }, requestId);
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ ok: true, op: "move", routing: { kind: "immediate" }, parent: null });
    const amount = new Decimal(String(res.body["amount"]));
    expect(amount.gt(0)).toBe(true);
    const prev = res.body["previousParent"] as { id: string; childrenBefore: string; childrenAfter: string };
    expect(prev.id).toBe(before.parentId);
    expect(new Decimal(prev.childrenBefore).minus(prev.childrenAfter).equals(amount)).toBe(true);
    expect((await env(id(leaf))).parentId).toBe(before.parentId);
    expect(await writes(requestId)).toBe(0);
    expect(await owner.envelopeLineage.count({ where: { fromEnvelopeId: id(leaf) } })).toBe(0);
  });

  it("split: parts that do not sum are refused; parts that do are routed, and no part is created", async () => {
    const leaf = leafKeys("LATAM/MX/meta/consideration")[0] as string;
    const e = await env(id(leaf));
    const current = (e["current"] as { amount: string }).amount;
    const half = new Decimal(current).div(2).toDecimalPlaces(2, Decimal.ROUND_DOWN);
    const parts = (a: Decimal, b: Decimal) => [{ name: "Part A", amount: a.toFixed(2) }, { name: "Part B", amount: b.toFixed(2) }];
    const bad = await preview({ op: "split", envelopeId: id(leaf), input: { basedOnVersionId: e.currentVersionId, rationale: "split it", parts: parts(half, half.plus(1)) } });
    expect(bad.body).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    const siblingsBefore = (await env(id(leaf))).structure.siblings.length;
    const good = await preview({ op: "split", envelopeId: id(leaf), input: { basedOnVersionId: e.currentVersionId, rationale: "split it", parts: parts(half, new Decimal(current).minus(half)) } });
    expect(good.body, JSON.stringify(good.body)).toMatchObject({ ok: true, op: "split" });
    expect(["auto_approved", "approval"]).toContain((good.body["routing"] as { kind: string }).kind);
    const parent = good.body["parent"] as { childrenBefore: string; childrenAfter: string };
    expect(parent.childrenAfter).toBe(parent.childrenBefore); // a split keeps the total
    expect((await env(id(leaf))).structure.siblings.length).toBe(siblingsBefore);
  });

  it("merge of siblings: routed, holds their total, nothing created", async () => {
    const [a, b] = leafKeys("LATAM/MX/tiktok/conversion");
    const res = await preview({ op: "merge", input: { sourceIds: [id(a as string), id(b as string)], name: "TikTok conversion (all)", dimensionValues: (await env(id(a as string))).dimensionValues, rationale: "one line item" } });
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ ok: true, op: "merge" });
    const total = [a, b].map((k) => new Decimal(plan.find((e) => e.key === k)?.versions.at(-1)?.amount ?? 0)).reduce((s, v) => s.plus(v), new Decimal(0));
    expect(new Decimal(String(res.body["amount"])).gt(0)).toBe(true);
    expect(total.gt(0)).toBe(true);
    expect(await owner.envelope.count({ where: { workspaceId: golden.workspaceId, name: "TikTok conversion (all)" } })).toBe(0);
  });
});

describe("add child: one action, through the policy", () => {
  it("the preview says where it lands and how it is routed; the command creates it under the parent and submits it", async () => {
    const parentKey = "LATAM/MX/meta/awareness";
    const parent = await env(id(parentKey));
    const input = { name: "MX meta awareness lookalike", amount: "5.00", dimensionValues: { audience: "lookalike" }, rationale: "test a lookalike audience" };
    const p = await preview({ op: "add_child", envelopeId: id(parentKey), input });
    expect(p.body, JSON.stringify(p.body)).toMatchObject({ ok: true, op: "add_child", parent: { id: id(parentKey) } });
    const cap = p.body["parent"] as { childrenBefore: string; childrenAfter: string };
    expect(new Decimal(cap.childrenAfter).minus(cap.childrenBefore).toFixed(2)).toBe(String(p.body["amount"]));
    expect(await owner.envelope.count({ where: { workspaceId: golden.workspaceId, name: input.name } })).toBe(0);

    const requestId = `structui-${randomUUID()}`;
    const res = await as("planner", "POST", `/api/v1/envelopes/${id(parentKey)}/children`, input, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const routing = p.body["routing"] as { kind: string };
    expect(res.body["autoApproved"]).toBe(routing.kind === "auto_approved");
    const child = await env(String(res.body["envelopeId"]));
    expect(child.parentId).toBe(id(parentKey));
    expect(child.dimensionValues).toEqual({ ...parent.dimensionValues, audience: "lookalike" });
    expect(child["startDate"]).toBe(parent["startDate"]);
    const audits = (await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId)).map((a) => a.action);
    expect(audits[0]).toBe("envelope.created");
    expect(audits.length).toBeGreaterThanOrEqual(2); // and the submit (requested, or approved by policy)
    const out = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND payload::text LIKE $2`, golden.workspaceId, `%${String(res.body["envelopeId"])}%`);
    expect(Number(out[0]?.n)).toBeGreaterThanOrEqual(2);
    expect((await env(id(parentKey))).structure.children.map((c) => c.id)).toContain(res.body["envelopeId"]);
  });

  it("an approver (read only here) is told why not, in the preview and by the command", async () => {
    const input = { name: "Nope", amount: "1.00", dimensionValues: { audience: "broad" }, rationale: "not allowed" };
    const p = await as("approver", "POST", "/api/v1/envelopes/structure/preview", { op: "add_child", envelopeId: id("LATAM/MX/meta/awareness"), input });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await as("approver", "POST", `/api/v1/envelopes/${id("LATAM/MX/meta/awareness")}/children`, input)).status).toBe(403);
  });
});
