import { randomUUID } from "node:crypto";
import { goldenPlan } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

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
      `DELETE FROM envelope_lineage WHERE workspace_id = $1::uuid`,
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
    expect(await owner.envelopeLineage.count({ where: { fromEnvelopeId: id(leaf), kind: "move" } })).toBe(0);
  });

  it("allows it when the new parent allows over-allocation; lineage, audit and outbox are written", async () => {
    const leaf = leafKeys("LATAM/MX/meta/awareness")[1] as string;
    const target = "LATAM/MX/tiktok/awareness";
    await owner.envelope.update({ where: { id: id(target) }, data: { allowOverAllocation: true } });
    const requestId = `move-${randomUUID()}`;
    const res = await as("planner", "POST", `/api/v1/envelopes/${id(leaf)}/move`, { parentId: id(target), rowVersion: (await env(id(leaf))).rowVersion, rationale: "re-org" }, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await env(id(leaf))).parentId).toBe(id(target));
    const lineage = await owner.envelopeLineage.findFirstOrThrow({ where: { fromEnvelopeId: id(leaf), kind: "move" } });
    expect(lineage.toEnvelopeId).toBe(id(target));
    const audits = await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1`, requestId);
    expect(audits.map((a) => a.action)).toEqual(["envelope.moved"]);
    const out = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND payload->>'kind' = 'moved' AND payload->>'envelopeId' = $2`, golden.workspaceId, id(leaf));
    expect(Number(out[0]?.n)).toBe(1);
  });

  it("to the root and back: the original parent still has room for it", async () => {
    const leaf = leafKeys("LATAM/MX/meta/consideration")[0] as string;
    const parent = (await env(id(leaf))).parentId as string;
    expect((await move(id(leaf), null)).status).toBe(201);
    expect((await env(id(leaf))).parentId).toBeNull();
    expect((await move(id(leaf), parent)).status).toBe(201);
    expect((await env(id(leaf))).parentId).toBe(parent);
    expect(await owner.envelopeLineage.count({ where: { fromEnvelopeId: id(leaf), kind: "move" } })).toBe(2);
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
    const r = await owner.approvalRequest.findUniqueOrThrow({ where: { id: String(submitted.body["requestId"]) } });
    expect(r.status).toBe("CHANGES_REQUESTED");
    const comment = await owner.comment.findFirstOrThrow({ where: { thread: { anchorId: id(leaf), isBlocking: true } } });
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
      const phasing = await owner.envelopePhasing.findMany({ where: { versionId: p.currentVersionId as string } });
      expect(phasing).toHaveLength(12);
      expect(phasing.reduce((s, x) => s.plus(x.amount.toString()), new Decimal(0)).toFixed(2)).toBe(p.current?.amount);
    }
    expect(await owner.envelopeLineage.count({ where: { fromEnvelopeId: id(leaf), kind: "split" } })).toBe(2);
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
    expect(await owner.envelopeLineage.count({ where: { toEnvelopeId: String(res.body["targetId"]), kind: "merge" } })).toBe(2);
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
