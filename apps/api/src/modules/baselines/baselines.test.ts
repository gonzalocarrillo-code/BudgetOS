import { randomUUID } from "node:crypto";
import { goldenPlan } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/**
 * H-002 / H-005 done-when (Phase E, ADR-053): a snapshot keeps the amounts and the structure it was
 * saved with, whatever happens after; one budget's subtree can be saved by whoever edits it; the
 * change report's change equals the difference of the two totals and its counts add up.
 */
const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `snap-${randomUUID().slice(0, 8)}`;
const plan = goldenPlan();

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId }, ...(body === undefined ? {} : { body }) });
}
const id = (key: string) => golden.envelopeIds.get(key) as string;

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("snapshots (Phase E)", () => {
  it("a workspace snapshot keeps its amounts and structure after the budgets change; the report sees the change", async () => {
    const ws = golden.workspaceId;
    expect((await as("planner", "POST", `/api/v1/workspaces/${ws}/baselines`, { name: "Q4 plan", kind: "plan" })).status).toBe(403); // finance and admins only
    const saved = await as("admin", "POST", `/api/v1/workspaces/${ws}/baselines`, { name: "Q4 plan", kind: "plan", periodKey: "2026-Q4" });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const snap = saved.body as { id: string; rowCount: number; total: string };
    expect(snap.rowCount).toBe(await owner.envelope.count({ where: { workspaceId: ws, status: { not: "ARCHIVED" } } }));
    expect(Number((await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE workspace_id = $1::uuid AND action = 'baseline.saved'`, ws))[0]?.n)).toBe(1);

    // Change a leaf's amount (an admin's change applies directly) and move another budget.
    const leafKey = plan.find((e) => e.level === 4)?.key as string;
    const leaf = id(leafKey);
    const before = (await as("admin", "GET", `/api/v1/envelopes/${leaf}`)).body as { currentVersionId: string; current: { amount: string } };
    const bumped = new Decimal(before.current.amount).minus(100).toFixed(2);
    const draft = await as("admin", "PATCH", `/api/v1/envelopes/${leaf}/draft`, { amount: bumped, basedOnVersionId: before.currentVersionId, rationale: "snapshot test" });
    expect(draft.status, JSON.stringify(draft.body)).toBeLessThan(300);
    const draftId = (draft.body as { versionId?: string; id?: string }).versionId ?? (draft.body as { id: string }).id;
    const submit = await as("admin", "POST", `/api/v1/envelopes/${leaf}/submit`, { versionId: draftId, rationale: "snapshot test" });
    expect(submit.status, JSON.stringify(submit.body)).toBeLessThan(300);

    const row = await owner.budgetBaselineRow.findUniqueOrThrow({ where: { baselineId_envelopeId: { baselineId: snap.id, envelopeId: leaf } } });
    expect(row.amount.toFixed(2)).toBe(new Decimal(before.current.amount).toFixed(2));
    expect(row.versionId).toBe(before.currentVersionId);

    // An approved move and rename (structure is not versioned): the snapshot keeps where and what it was.
    const other = plan.find((e) => e.level === 4 && e.key.split("/")[0] === leafKey.split("/")[0] && e.key.split("/").slice(0, 3).join("/") !== leafKey.split("/").slice(0, 3).join("/"));
    expect(other).toBeDefined();
    const was = await owner.envelope.findUniqueOrThrow({ where: { id: leaf } });
    const newParent = (await owner.envelope.findUniqueOrThrow({ where: { id: id(other?.key as string) } })).parentId;
    await owner.envelope.update({ where: { id: leaf }, data: { parentId: newParent, name: `${was.name} (moved)` } });
    const frozen = await owner.budgetBaselineRow.findUniqueOrThrow({ where: { baselineId_envelopeId: { baselineId: snap.id, envelopeId: leaf } } });
    expect(frozen.parentId).toBe(was.parentId);
    expect(frozen.name).toBe(was.name);

    const report = (await as("finance1", "GET", `/api/v1/baselines/${snap.id}/report`)).body as { baseline: { total: string }; against: { total: string }; change: { abs: string }; counts: Record<string, number>; topMovers: Array<{ envelopeId: string; abs: string }> };
    expect(new Decimal(report.against.total).minus(report.baseline.total).toFixed(2)).toBe(report.change.abs);
    expect(report.topMovers.find((m) => m.envelopeId === leaf)?.abs).toBe("-100.00");
    expect(Object.values(report.counts).reduce((a, b) => a + b, 0)).toBe(snap.rowCount);

    // The version History shows which snapshot saved it.
    const versions = (await as("planner", "GET", `/api/v1/envelopes/${leaf}/versions`)).body as unknown as Array<{ id: string; snapshots: Array<{ name: string }> }>;
    expect(versions.find((v) => v.id === before.currentVersionId)?.snapshots.map((x) => x.name)).toEqual(["Q4 plan"]);
  });

  it("a budget's subtree is saved by whoever edits it; rename and archive keep the rows", async () => {
    const ws = golden.workspaceId;
    const root = plan.find((e) => e.level === 1)?.key as string;
    const res = await as("planner", "POST", `/api/v1/workspaces/${ws}/baselines`, { name: "EMEA before the re-plan", scope: { envelopeId: id(root) } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const snap = res.body as { id: string; rowCount: number; scopeLabel: string };
    expect(snap.rowCount).toBe(plan.filter((e) => e.key === root || e.key.startsWith(`${root}/`)).length);
    const renamed = await as("planner", "PATCH", `/api/v1/baselines/${snap.id}`, { name: "EMEA as agreed", archived: true });
    expect(renamed.body).toMatchObject({ name: "EMEA as agreed" });
    expect((renamed.body as { archivedAt: string | null }).archivedAt).not.toBeNull();
    expect(await owner.budgetBaselineRow.count({ where: { baselineId: snap.id } })).toBe(snap.rowCount);
    const listRes = await as("budgetOwner", "GET", `/api/v1/workspaces/${ws}/baselines`);
    expect(listRes.status, JSON.stringify(listRes.body)).toBe(200);
    const listed = listRes.body as { baselines: Array<{ id: string }> };
    expect(listed.baselines.map((b) => b.id)).not.toContain(snap.id);
  });
});
