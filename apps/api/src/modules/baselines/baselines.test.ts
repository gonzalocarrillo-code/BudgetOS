import { randomUUID } from "node:crypto";
import { asOrgAdmin, goldenPlan } from "@budget/db";
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
    // W0-6: the owner has no BYPASSRLS; envelope/audit_event need the org-admin tenant context.
    expect(snap.rowCount).toBe(await asOrgAdmin(owner, (tx) => tx.envelope.count({ where: { workspaceId: ws, status: { not: "ARCHIVED" } } }), golden.orgId));
    // One audit row for this save (the golden seed saves its own plan snapshot, GOLDEN_HISTORY).
    expect(
      Number(
        (
          await asOrgAdmin(owner, (tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE workspace_id = $1::uuid AND action = 'baseline.saved' AND entity_id = $2::uuid`, ws, snap.id), golden.orgId)
        )[0]?.n,
      ),
    ).toBe(1);

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

    const row = await asOrgAdmin(owner, (tx) => tx.budgetBaselineRow.findUniqueOrThrow({ where: { baselineId_envelopeId: { baselineId: snap.id, envelopeId: leaf } } }), golden.orgId);
    expect(row.amount.toFixed(2)).toBe(new Decimal(before.current.amount).toFixed(2));
    expect(row.versionId).toBe(before.currentVersionId);

    // An approved move and rename (structure is not versioned): the snapshot keeps where and what it was.
    const other = plan.find((e) => e.level === 4 && e.key.split("/")[0] === leafKey.split("/")[0] && e.key.split("/").slice(0, 3).join("/") !== leafKey.split("/").slice(0, 3).join("/"));
    expect(other).toBeDefined();
    const was = await asOrgAdmin(owner, (tx) => tx.envelope.findUniqueOrThrow({ where: { id: leaf } }), golden.orgId);
    const newParent = (await asOrgAdmin(owner, (tx) => tx.envelope.findUniqueOrThrow({ where: { id: id(other?.key as string) } }), golden.orgId)).parentId;
    await asOrgAdmin(owner, (tx) => tx.envelope.update({ where: { id: leaf }, data: { parentId: newParent, name: `${was.name} (moved)` } }), golden.orgId);
    const frozen = await asOrgAdmin(owner, (tx) => tx.budgetBaselineRow.findUniqueOrThrow({ where: { baselineId_envelopeId: { baselineId: snap.id, envelopeId: leaf } } }), golden.orgId);
    expect(frozen.parentId).toBe(was.parentId);
    expect(frozen.name).toBe(was.name);

    const report = (await as("finance1", "GET", `/api/v1/baselines/${snap.id}/report`)).body as { baseline: { total: string }; against: { total: string }; change: { abs: string }; counts: Record<string, number>; topMovers: Array<{ envelopeId: string; abs: string }> };
    expect(new Decimal(report.against.total).minus(report.baseline.total).toFixed(2)).toBe(report.change.abs);
    expect(report.topMovers.find((m) => m.envelopeId === leaf)?.abs).toBe("-100.00");
    expect(Object.values(report.counts).reduce((a, b) => a + b, 0)).toBe(snap.rowCount);

    // H-004: /query compares with the snapshot: the leaf's change, and 404 for an unknown snapshot.
    const query = (compareTo: unknown) =>
      as("planner", "POST", `/api/v1/workspaces/${ws}/query`, { workspaceId: ws, period: { kind: "range", start: "2026-01-01", end: "2026-12-31" }, measures: ["budget", "budget_baseline", "budget_change_abs"], compareTo, limit: 1000 });
    const compared = await query({ baselineId: snap.id });
    expect(compared.status, JSON.stringify(compared.body)).toBeLessThan(300);
    const leafRow = (compared.body["rows"] as Array<{ envelopeId: string; measures: Record<string, string | null> }>).find((r) => r.envelopeId === leaf);
    expect(leafRow?.measures).toMatchObject({ budget_baseline: row.amountReporting.toFixed(2), budget_change_abs: "-100.00" });
    expect((await query({ baselineId: randomUUID() })).status).toBe(404);

    // Listed for one budget, each snapshot says what it holds for it (the drawer, Phase E4).
    const forLeaf = (await as("planner", "GET", `/api/v1/workspaces/${ws}/baselines?envelopeId=${leaf}`)).body as unknown as { baselines: Array<{ id: string; row: { amount: string; versionId: string | null } | null }> };
    expect(forLeaf.baselines.find((b) => b.id === snap.id)?.row).toMatchObject({ amount: new Decimal(before.current.amount).toFixed(2), versionId: before.currentVersionId });

    // The Snapshots page: the header alone, the rows as the tree they were saved in, and a CSV.
    expect((await as("planner", "GET", `/api/v1/baselines/${snap.id}`)).body).toMatchObject({ id: snap.id, name: "Q4 plan", rowCount: snap.rowCount });
    const tree = (await as("planner", "GET", `/api/v1/baselines/${snap.id}/rows?limit=20000`)).body as unknown as { rows: Array<{ envelopeId: string; parentId: string | null; depth: number; amountReporting: string; now: string | null; change: string }>; truncated: boolean };
    expect(tree.rows).toHaveLength(snap.rowCount);
    expect(tree.truncated).toBe(false);
    expect(tree.rows.filter((r) => r.depth === 0).every((r) => r.parentId === null)).toBe(true);
    const seen = new Set<string>();
    for (const r of tree.rows) {
      if (r.parentId !== null) expect(seen.has(r.parentId), "a parent comes before its children").toBe(true);
      seen.add(r.envelopeId);
    }
    const frozenLeaf = tree.rows.find((r) => r.envelopeId === leaf);
    expect(frozenLeaf).toMatchObject({ amountReporting: row.amountReporting.toFixed(2), change: "-100.00" });
    expect(frozenLeaf?.parentId).toBe(was.parentId); // the tree as saved, not as moved since
    const first = (await as("planner", "GET", `/api/v1/baselines/${snap.id}/rows?limit=3`)).body as unknown as { rows: unknown[]; truncated: boolean };
    expect(first).toMatchObject({ truncated: true });
    expect(first.rows).toHaveLength(3);
    const csv = await as("planner", "GET", `/api/v1/baselines/${snap.id}/export.csv`);
    expect(csv.status).toBe(200);
    const lines = csv.text.trim().split("\r\n");
    expect(lines).toHaveLength(snap.rowCount + 1);
    expect(lines[0]).toMatch(/^envelope_id,parent_id,depth,name,is_leaf,.*,currency,amount,amount_reporting,start_date,end_date,version_id,snapshot,as_of$/);
    expect((await as("planner", "GET", `/api/v1/baselines/${randomUUID()}/rows`)).status).toBe(404);

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
    expect(await asOrgAdmin(owner, (tx) => tx.budgetBaselineRow.count({ where: { baselineId: snap.id } }), golden.orgId)).toBe(snap.rowCount);
    const listRes = await as("budgetOwner", "GET", `/api/v1/workspaces/${ws}/baselines`);
    expect(listRes.status, JSON.stringify(listRes.body)).toBe(200);
    const listed = listRes.body as { baselines: Array<{ id: string }> };
    expect(listed.baselines.map((b) => b.id)).not.toContain(snap.id);
  });
});
