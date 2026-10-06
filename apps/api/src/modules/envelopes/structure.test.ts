import { randomUUID } from "node:crypto";
import { asOrgAdmin, goldenPlan, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";

/**
 * T-014 (spec §7.5): move / split / merge with lineage. Done-when: cap re-validation.
 * Runs on its own seeded golden workspace.
 */

const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `struct-${randomUUID().slice(0, 8)}`;
const plan = goldenPlan();
const byKey = new Map(plan.map((e) => [e.key, e]));

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, requestId?: string) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId, ...(requestId ? { "x-request-id": requestId } : {}) }, ...(body === undefined ? {} : { body }) });
}
const id = (key: string) => golden.envelopeIds.get(key) as string;
// W0-6: the owner has no BYPASSRLS; every owner.* call below needs the same org-admin tenant
// context real reads/writes get from withTenant, scoped to the golden workspace's org.
const admin = <T>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, golden.orgId);
const leafKeys = (prefix: string) => plan.filter((e) => e.level === 4 && e.key.startsWith(prefix)).map((e) => e.key);
const approved = (key: string) => new Decimal(byKey.get(key)?.versions.at(-1)?.amount ?? 0);
async function env(envelopeId: string) {
  return (await as("planner", "GET", `/api/v1/envelopes/${envelopeId}`)).body as { status: string; parentId: string | null; rowVersion: number; currentVersionId: string | null; draftVersionId: string | null; current: { amount: string } | null };
}
const move = async (envelopeId: string, parentId: string | null, rowVersion?: number) =>
  as("planner", "POST", `/api/v1/envelopes/${envelopeId}/move`, { parentId, rowVersion: rowVersion ?? (await env(envelopeId)).rowVersion });

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("move: cap re-validation (T-014 done-when)", () => {
  it("refuses a move that would put the new parent's children above its budget, and writes nothing", async () => {
    const leaf = leafKeys("LATAM/MX/meta/awareness")[0] as string;
    const target = "LATAM/MX/google_ads/awareness"; // full: its own two children already use ~95% of it
    const before = await env(id(leaf));
    const res = await move(id(leaf), id(target));
    expect(res.status).toBe(422);
    expect(res.body["code"]).toBe("CAP_EXCEEDED");
    const details = res.body["details"] as { parent: string; children: string };
    expect(new Decimal(details.children).gt(details.parent)).toBe(true);
    expect(details.parent).toBe(approved(target).toFixed(2));
    const after = await env(id(leaf));
    expect(after.parentId).toBe(before.parentId);
    expect(after.rowVersion).toBe(before.rowVersion);
    expect(await admin((tx) => tx.envelopeLineage.count({ where: { fromEnvelopeId: id(leaf), kind: "move" } }))).toBe(0);
  });

  it("allows it when the new parent allows over-allocation; lineage, audit and outbox are written", async () => {
    const leaf = leafKeys("LATAM/MX/meta/awareness")[1] as string;
    const target = "LATAM/MX/tiktok/awareness";
    await admin((tx) => tx.envelope.update({ where: { id: id(target) }, data: { allowOverAllocation: true } }));
    const requestId = `move-${randomUUID()}`;
    const res = await as("planner", "POST", `/api/v1/envelopes/${id(leaf)}/move`, { parentId: id(target), rowVersion: (await env(id(leaf))).rowVersion, rationale: "re-org" }, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await env(id(leaf))).parentId).toBe(id(target));
    const lineage = await admin((tx) => tx.envelopeLineage.findFirstOrThrow({ where: { fromEnvelopeId: id(leaf), kind: "move" } }));
    expect(lineage.toEnvelopeId).toBe(id(target));
    const audits = await admin((tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1`, requestId));
    expect(audits.map((a) => a.action)).toEqual(["envelope.moved"]);
    const out = await admin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND payload->>'kind' = 'moved' AND payload->>'envelopeId' = $2`, golden.workspaceId, id(leaf)));
    expect(Number(out[0]?.n)).toBe(1);
  });

  it("refuses to move a real envelope under a demo one, and writes nothing (HF-1)", async () => {
    const demoParentId = randomUUID();
    await admin((tx) =>
      tx.envelope.create({
        data: { id: demoParentId, workspaceId: golden.workspaceId, name: "Demo parent", dimensionValues: {}, startDate: new Date("2026-01-01T00:00:00Z"), endDate: new Date("2026-12-31T00:00:00Z"), currency: "USD", createdBy: golden.users.planner, demo: true },
      }),
    );
    const leaf = leafKeys("LATAM/AR/google_ads/conversion")[0] as string;
    const before = await env(id(leaf));
    const res = await move(id(leaf), demoParentId);
    expect(res.status).toBe(422);
    expect(res.body["code"]).toBe("VALIDATION");
    const after = await env(id(leaf));
    expect(after.parentId).toBe(before.parentId);
    expect(after.rowVersion).toBe(before.rowVersion);
    expect(await admin((tx) => tx.envelopeLineage.count({ where: { fromEnvelopeId: id(leaf), toEnvelopeId: demoParentId } }))).toBe(0);
    await admin((tx) => tx.envelope.delete({ where: { id: demoParentId } }));
  });

  it("to the root and back: the original parent still has room for it", async () => {
    const leaf = leafKeys("LATAM/MX/meta/consideration")[0] as string;
    const parent = (await env(id(leaf))).parentId as string;
    expect((await move(id(leaf), null)).status).toBe(201);
    expect((await env(id(leaf))).parentId).toBeNull();
    expect((await move(id(leaf), parent)).status).toBe(201);
    expect((await env(id(leaf))).parentId).toBe(parent);
    expect(await admin((tx) => tx.envelopeLineage.count({ where: { fromEnvelopeId: id(leaf), kind: "move" } }))).toBe(2);
  });

  it("refuses cycles, stale rowVersion, and moving under the same parent", async () => {
    const country = "LATAM/CO";
    const descendant = "LATAM/CO/meta";
    expect((await move(id(country), id(descendant))).status).toBe(422);
    expect((await move(id(country), id(country))).status).toBe(422);
    const leaf = leafKeys("LATAM/CO/tiktok/awareness")[0] as string;
    expect((await move(id(leaf), null, 1)).status).toBe(409);
    expect((await move(id(leaf), (await env(id(leaf))).parentId)).status).toBe(422);
  });

  it("re-routes an open request whose policy changes because of the move", async () => {
    const leaf = leafKeys("LATAM/CO/amazon/awareness")[0] as string;
    const e = await env(id(leaf));
    // Double it: over the parent's cap, so the request routes to Major / over-allocation.
    const draft = await as("planner", "PATCH", `/api/v1/envelopes/${id(leaf)}/draft`, { amount: approved(leaf).mul(2).toFixed(2), basedOnVersionId: e.currentVersionId });
    const submitted = await as("planner", "POST", `/api/v1/envelopes/${id(leaf)}/submit`, { versionId: draft.body["id"] });
    expect((submitted.body["policy"] as { name: string }).name).toBe("Major / over-allocation");
    const moved = await move(id(leaf), null); // at the root there is no parent to over-allocate
    expect(moved.status).toBe(201);
    expect(moved.body["reroutedRequestId"]).toBe(submitted.body["requestId"]);
    const r = await admin((tx) => tx.approvalRequest.findUniqueOrThrow({ where: { id: String(submitted.body["requestId"]) } }));
    expect(r.status).toBe("CHANGES_REQUESTED");
    const comment = await admin((tx) => tx.comment.findFirstOrThrow({ where: { thread: { anchorId: id(leaf), isBlocking: true } } }));
    expect(comment.bodyMd).toMatch(/^\[system\] .* was moved; the change now matches policy "Standard"/);
  });
});

describe("split", () => {
  it("parts must sum to the approved amount and be based on the head", async () => {
    const leaf = leafKeys("EMEA/DE/meta/awareness")[0] as string;
    const e = await env(id(leaf));
    const bad = await as("planner", "POST", `/api/v1/envelopes/${id(leaf)}/split`, { basedOnVersionId: e.currentVersionId, rationale: "by retailer", parts: [{ name: "a", amount: "1.00" }, { name: "b", amount: "2.00" }] });
    expect(bad.status).toBe(422);
    const stale = await as("planner", "POST", `/api/v1/envelopes/${id(leaf)}/split`, { basedOnVersionId: randomUUID(), rationale: "by retailer", parts: [{ name: "a", amount: "1" }, { name: "b", amount: "2" }] });
    expect(stale.status).toBe(409);
  });

  it("auto-approves (structural, total unchanged): parts are approved siblings, the source is archived at zero", async () => {
    const leaf = leafKeys("EMEA/DE/meta/awareness")[0] as string;
    const e = await env(id(leaf));
    const total = approved(leaf);
    const a = total.mul(0.3).toDecimalPlaces(2);
    const res = await as("planner", "POST", `/api/v1/envelopes/${id(leaf)}/split`, {
      basedOnVersionId: e.currentVersionId,
      rationale: "by retailer",
      parts: [
        { name: "DE meta awareness · Walmart", amount: a.toFixed(2), dimensionValues: { retailer: "walmart" } },
        { name: "DE meta awareness · Carrefour", amount: total.minus(a).toFixed(2), dimensionValues: { retailer: "carrefour" } },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ autoApproved: true, requestId: null, policy: { name: "Auto-approve minor" } });
    const source = await env(id(leaf));
    expect(source.status).toBe("ARCHIVED");
    expect(source.current?.amount).toBe("0.00");
    const parts = res.body["partIds"] as string[];
    for (const [i, pid] of parts.entries()) {
      const p = await env(pid);
      expect(p).toMatchObject({ status: "APPROVED", parentId: e.parentId });
      expect(p.current?.amount).toBe(i === 0 ? a.toFixed(2) : total.minus(a).toFixed(2));
      const phasing = await admin((tx) => tx.envelopePhasing.findMany({ where: { versionId: p.currentVersionId as string } }));
      expect(phasing).toHaveLength(12);
      expect(phasing.reduce((s, x) => s.plus(x.amount.toString()), new Decimal(0)).toFixed(2)).toBe(p.current?.amount);
    }
    expect(await admin((tx) => tx.envelopeLineage.count({ where: { fromEnvelopeId: id(leaf), kind: "split" } }))).toBe(2);
    // Archived envelopes are closed for edits.
    expect((await move(id(leaf), null)).status).toBe(409);
  });

  it("with an approval chain: one request for the whole split; approve archives the source, reject archives the parts", async () => {
    const policies = (await as("admin", "GET", `/api/v1/workspaces/${golden.workspaceId}/policies`)).body as unknown as Array<{ id: string; name: string; version: number }>;
    const auto = policies.find((p) => p.name === "Auto-approve minor")!;
    expect((await as("admin", "PATCH", `/api/v1/policies/${auto.id}`, { version: auto.version, isActive: false })).status).toBe(200);
    try {
      const split = async (leaf: string) => {
        const e = await env(id(leaf));
        const total = approved(leaf);
        return as("planner", "POST", `/api/v1/envelopes/${id(leaf)}/split`, {
          basedOnVersionId: e.currentVersionId,
          rationale: "needs sign-off",
          parts: [
            { name: `${leaf} A`, amount: "100.00", dimensionValues: { retailer: "walmart" } },
            { name: `${leaf} B`, amount: total.minus(100).toFixed(2), dimensionValues: { retailer: "carrefour" } },
          ],
        });
      };
      const [first, second] = leafKeys("EMEA/DE/meta/consideration") as [string, string];
      const approvedSplit = await split(first);
      expect(approvedSplit.body).toMatchObject({ autoApproved: false, policy: { name: "Minor adjustment" } });
      // S-003: the request has its own audit row and approval.changed row, as a single change's does.
      const splitRequest = String(approvedSplit.body["requestId"]);
      const [announced] = await admin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE topic = 'approval.changed' AND payload->>'requestId' = $1 AND payload->>'action' = 'approval.requested'`, splitRequest));
      expect(Number(announced?.n)).toBe(1);
      const [audited] = await admin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'approval.requested'`, splitRequest));
      expect(Number(audited?.n)).toBe(1);
      expect((await env(id(first))).status).toBe("PENDING");
      expect((await as("budgetOwner", "POST", `/api/v1/approvals/${String(approvedSplit.body["requestId"])}/decisions`, { decision: "approve" })).status).toBe(201);
      expect((await env(id(first))).status).toBe("ARCHIVED");
      for (const pid of approvedSplit.body["partIds"] as string[]) expect((await env(pid)).status).toBe("APPROVED");

      const rejectedSplit = await split(second);
      expect((await as("budgetOwner", "POST", `/api/v1/approvals/${String(rejectedSplit.body["requestId"])}/decisions`, { decision: "reject", comment: "keep it whole" })).status).toBe(201);
      const kept = await env(id(second));
      expect(kept).toMatchObject({ status: "APPROVED", draftVersionId: null });
      expect(kept.current?.amount).toBe(approved(second).toFixed(2));
      for (const pid of rejectedSplit.body["partIds"] as string[]) expect((await env(pid)).status).toBe("ARCHIVED");
    } finally {
      const now = ((await as("admin", "GET", `/api/v1/workspaces/${golden.workspaceId}/policies`)).body as unknown as Array<{ id: string; version: number }>).find((p) => p.id === auto.id)!;
      await as("admin", "PATCH", `/api/v1/policies/${auto.id}`, { version: now.version, isActive: true });
    }
  });
});

describe("merge", () => {
  it("siblings become one new sibling holding their approved total; sources archived with lineage", async () => {
    const [a, b] = leafKeys("EMEA/FR/meta/conversion") as [string, string];
    const parent = (await env(id(a))).parentId;
    const res = await as("planner", "POST", "/api/v1/envelopes/merge", {
      sourceIds: [id(a), id(b)],
      name: "FR meta conversion (all audiences)",
      dimensionValues: { region: "EMEA", country: "FR", platform: "meta", objective: "conversion" },
      rationale: "one line item",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body["autoApproved"]).toBe(true);
    const target = await env(String(res.body["targetId"]));
    expect(target).toMatchObject({ status: "APPROVED", parentId: parent });
    expect(target.current?.amount).toBe(approved(a).plus(approved(b)).toFixed(2));
    for (const s of [a, b]) expect((await env(id(s))).status).toBe("ARCHIVED");
    expect(await admin((tx) => tx.envelopeLineage.count({ where: { toEnvelopeId: String(res.body["targetId"]), kind: "merge" } }))).toBe(2);
  });

  it("refuses envelopes with different parents, and fewer than two", async () => {
    const x = leafKeys("EMEA/FR/tiktok/awareness")[0] as string;
    const y = leafKeys("EMEA/FR/tiktok/consideration")[0] as string;
    const body = (ids: string[]) => ({ sourceIds: ids, name: "m", dimensionValues: { region: "EMEA" }, rationale: "nope" });
    expect((await as("planner", "POST", "/api/v1/envelopes/merge", body([id(x), id(y)]))).status).toBe(422);
    expect([400, 422]).toContain((await as("planner", "POST", "/api/v1/envelopes/merge", body([id(x)]))).status);
    expect((await as("planner", "POST", "/api/v1/envelopes/merge", body([id(x), id(x)]))).status).toBe(422);
  });
});

/**
 * W3-5 (audit I-15): one lock order for every structural write — the tree lock (moves only), then
 * the approval request, then envelopes by id. A move and a decision on the same budget, or two
 * moves that would make a cycle, wait for each other instead of deadlocking (40P01 → 500).
 */
describe("lock order (W3-5)", () => {
  const noServerError = (statuses: number[]) => expect(statuses.filter((s) => s >= 500), `statuses ${statuses.join(",")}`).toEqual([]);
  /** Whether walking up from this envelope comes back to it. */
  async function inCycle(envelopeId: string): Promise<boolean> {
    let p: string | null = envelopeId;
    for (let i = 0; i < 64 && p !== null; i += 1) {
      const pid: string = p; // TS does not narrow a `let` captured by the closure below
      p = (await admin((tx) => tx.envelope.findUniqueOrThrow({ where: { id: pid }, select: { parentId: true } }))).parentId;
      if (p === envelopeId) return true;
    }
    return false;
  }

  it("a move and a decision on the same budget, ten times at once: never a 500", async () => {
    const leaves = [...leafKeys("LATAM/BR/meta"), ...leafKeys("LATAM/BR/google_ads")].slice(0, 10);
    expect(leaves).toHaveLength(10);
    for (const leaf of leaves) {
      const e = await env(id(leaf));
      // Over the parent's cap (allowed there), so the request routes to Major / over-allocation and
      // the move to the root re-routes it: the move takes the request lock, the decision the envelope's.
      await admin((tx) => tx.envelope.update({ where: { id: e.parentId as string }, data: { allowOverAllocation: true } }));
      const draft = await as("planner", "PATCH", `/api/v1/envelopes/${id(leaf)}/draft`, { amount: approved(leaf).mul(2).toFixed(2), basedOnVersionId: e.currentVersionId });
      expect(draft.status, JSON.stringify(draft.body)).toBeLessThan(300);
      const submitted = await as("planner", "POST", `/api/v1/envelopes/${id(leaf)}/submit`, { versionId: draft.body["id"] });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
      const rowVersion = (await env(id(leaf))).rowVersion;
      const [moved, decided] = await Promise.all([
        as("planner", "POST", `/api/v1/envelopes/${id(leaf)}/move`, { parentId: null, rowVersion }),
        as("admin", "POST", `/api/v1/approvals/${String(submitted.body["requestId"])}/decisions`, { decision: "approve" }),
      ]);
      noServerError([moved.status, decided.status]);
      // Either both went through one after the other, or the later one was refused as stale.
      expect([201, 409]).toContain(moved.status);
      expect([201, 409]).toContain(decided.status);
    }
  }, 180_000);

  it("cross-moves (A under B, B under A) at once: one wins, the other is refused, never a 500 or a cycle", async () => {
    const pairs = [
      ["LATAM/BR/tiktok/awareness", "LATAM/BR/tiktok/consideration"],
      ["LATAM/BR/amazon/awareness", "LATAM/BR/amazon/consideration"],
      ["LATAM/AR/meta/awareness", "LATAM/AR/meta/consideration"],
    ] as const;
    for (const [a, b] of pairs) {
      await admin((tx) => tx.envelope.updateMany({ where: { id: { in: [id(a), id(b)] } }, data: { allowOverAllocation: true } }));
      const [ra, rb] = await Promise.all([move(id(a), id(b)), move(id(b), id(a))]);
      noServerError([ra.status, rb.status]);
      expect([ra.status, rb.status].sort()).toEqual([201, 422]);
      const loser = ra.status === 201 ? rb : ra;
      expect(String(loser.body["message"])).toContain("own descendant");
      expect(await inCycle(id(a))).toBe(false);
    }
  }, 180_000);

  it("two moves under each other's descendants with different old parents never close a cycle", async () => {
    for (const country of ["EMEA/GB", "EMEA/FR"]) {
      const x = `${country}/google_ads/awareness`;
      const z = `${country}/tiktok/awareness`;
      const w = leafKeys(x)[0] as string; // under x
      const y = leafKeys(z)[0] as string; // under z
      await admin((tx) => tx.envelope.updateMany({ where: { id: { in: [id(w), id(y)] } }, data: { allowOverAllocation: true } }));
      const [m1, m2] = await Promise.all([move(id(x), id(y)), move(id(z), id(w))]);
      noServerError([m1.status, m2.status]);
      expect([m1.status, m2.status].sort()).toEqual([201, 422]);
      expect(await inCycle(id(x))).toBe(false);
    }
  }, 180_000);
});
