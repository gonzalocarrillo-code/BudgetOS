import { randomUUID } from "node:crypto";
import { asOrgAdmin, goldenPlan, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../../seed/golden.js";
import { cleanupGolden } from "../../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../../test-support/harness.js";

/**
 * ADR-039 (product feedback 5): edit a budget family top-down. A child follows its parent by % or
 * keeps its own amount; the family says when its children do not add up; saving stores how the
 * children follow (audited) and opens the amounts as one bulk change for approval.
 */

const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `family-${randomUUID().slice(0, 8)}`;
const plan = goldenPlan();

type Member = { envelopeId: string; mode: string | null; pct: string | null; before: string | null; after: string | null; changed: boolean; level: number };
type Plan = { parent: Member; members: Member[]; sums: Array<{ parentId: string; parentAmount: string; childrenTotal: string; unallocated: string; status: string }> };

async function as(method: "GET" | "POST", url: string, body?: unknown, requestId = `family-${randomUUID()}`) {
  const token = await h.mint({ sub: "ip-planner", email: `planner@${slug}.golden.test` }, { googleSub: `golden-${slug}-planner` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
// W0-6: the owner has no BYPASSRLS; every owner.* call below needs the same org-admin tenant
// context real reads/writes get from withTenant, scoped to the golden workspace's org.
const admin = <T>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, golden.orgId);
const count = async (sql: string, ...args: unknown[]) => Number((await admin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(sql, ...args)))[0]?.n);

let parentId = "";
let children: string[] = [];

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
  // A parent whose children have no open draft (the golden data has some drafts and pending requests).
  for (const e of plan.filter((p) => p.level === 3)) {
    const id = golden.envelopeIds.get(e.key) as string;
    const { kids, self } = await admin(async (tx) => ({
      kids: await tx.envelope.findMany({ where: { parentId: id, status: { not: "ARCHIVED" } }, select: { id: true, draftVersionId: true } }),
      self: await tx.envelope.findUniqueOrThrow({ where: { id }, select: { draftVersionId: true } }),
    }));
    if (kids.length >= 2 && self.draftVersionId === null && kids.every((k) => k.draftVersionId === null)) {
      parentId = id;
      children = kids.map((k) => k.id);
      break;
    }
  }
  expect(parentId, "a golden parent with two children and no drafts").not.toBe("");
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("family editing", () => {
  it("GET: the parent's children, each as it follows the parent, and how they add up", async () => {
    const res = await as("GET", `/api/v1/envelopes/${parentId}/family`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const f = res.body as unknown as Plan;
    expect(f.parent.envelopeId).toBe(parentId);
    expect(f.members.map((m) => m.envelopeId).sort()).toEqual([...children].sort());
    expect(f.members.every((m) => m.mode === null && m.level === 1 && !m.changed)).toBe(true);
    const total = f.members.reduce((s, m) => s.plus(m.before ?? 0), new Decimal(0));
    expect(f.sums[0]).toMatchObject({ parentId, parentAmount: f.parent.before, childrenTotal: total.toFixed(2) });
    expect(["balanced", "under"]).toContain(f.sums[0]?.status);
  });

  it("the parent +10 %: a child set to its share follows; the others keep their amount; preview writes nothing", async () => {
    const f = (await as("GET", `/api/v1/envelopes/${parentId}/family`)).body as unknown as Plan;
    const parent = new Decimal(f.parent.before as string);
    const first = f.members[0] as Member;
    const share = new Decimal(first.before as string).div(parent).times(100).toDecimalPlaces(6);
    const input = { parentAmount: parent.times(1.1).toFixed(2), children: [{ envelopeId: first.envelopeId, mode: "percent", pct: share.toString() }], rationale: "Q4 top-down" };

    const requestId = `family-${randomUUID()}`;
    const preview = await as("POST", `/api/v1/envelopes/${parentId}/family/preview`, input, requestId);
    expect(preview.status, JSON.stringify(preview.body)).toBe(201);
    const p = preview.body as unknown as Plan;
    expect(p.parent.after).toBe(parent.times(1.1).toFixed(2));
    const followed = p.members.find((m) => m.envelopeId === first.envelopeId);
    expect(followed).toMatchObject({ mode: "percent", changed: true });
    expect(new Decimal(followed?.after as string).minus(parent.times(1.1).times(share).div(100)).abs().lte("0.01")).toBe(true);
    expect(p.members.filter((m) => m.envelopeId !== first.envelopeId && m.level === 1).every((m) => !m.changed)).toBe(true);
    expect(p.sums[0]?.status).toBe("under");
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE request_id = $1`, requestId)).toBe(0);

    // Save: the rule is stored once (audit + outbox), and the amounts come back as a bulk preview.
    const saveId = `family-${randomUUID()}`;
    const saved = await as("POST", `/api/v1/envelopes/${parentId}/family`, input, saveId);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const rules = await admin((tx) => tx.envelopeAllocation.findMany({ where: { childEnvelopeId: first.envelopeId, supersededAt: null } }));
    expect(rules.map((r) => [r.parentEnvelopeId, r.mode, r.pct?.toString()])).toEqual([[parentId, "percent", share.toString()]]);
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE request_id = $1 AND action = 'allocation.changed'`, saveId)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'allocation.changed' AND payload->>'envelopeId' = $2`, golden.workspaceId, parentId)).toBe(1);
    const bulk = (saved.body as { preview: { previewId: string; rows: Array<{ envelopeId: string; after: string }> } | null }).preview;
    expect(bulk?.rows.map((r) => r.envelopeId).sort()).toEqual([parentId, first.envelopeId].sort());

    // Commit: drafts for the parent and the child, in one bulk change.
    const commit = await as("POST", `/api/v1/envelopes/bulk/${bulk?.previewId}/commit`);
    expect(commit.status, JSON.stringify(commit.body)).toBeLessThan(300);
    const drafts = await admin((tx) => tx.envelope.findMany({ where: { id: { in: [parentId, first.envelopeId] } }, select: { draftVersionId: true } }));
    expect(drafts.every((d) => d.draftVersionId !== null)).toBe(true);

    // Saving the same rules again stores nothing new.
    await as("POST", `/api/v1/envelopes/${parentId}/family/preview`, input);
    expect(await count(`SELECT count(*) AS n FROM envelope_allocation WHERE child_envelope_id = $1::uuid`, first.envelopeId)).toBe(1);
  });

  it("refuses a budget that is not the parent's child", async () => {
    const res = await as("POST", `/api/v1/envelopes/${parentId}/family/preview`, { parentAmount: "1.00", children: [{ envelopeId: parentId, mode: "manual", amount: "1.00" }] });
    expect(res.status).toBe(422);
  });
});
