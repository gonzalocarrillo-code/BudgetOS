import { randomUUID } from "node:crypto";
import { GOLDEN_ASSERTIONS, GOLDEN_ROUNDS, GOLDEN_SPLIT, goldenPlan } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";

/**
 * Epic 1.4 acceptance (T-012 done-when: replay over the golden history matches the assertions).
 * Goal: "Any envelope or roll-up shows a full timeline from audit data alone; GET /budgets?as_of=
 * YYYY-MM-DD returns exactly the approved amounts at that instant; a reconstruction test replays
 * 12 months of synthetic history and matches expected totals."
 */

const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `e14-${randomUUID().slice(0, 8)}`;
const A = GOLDEN_ASSERTIONS;
const plan = goldenPlan();
const leaves = plan.filter((e) => e.level === 4);

type Row = { at: string; id: string; source: string; kind: string; title: string; actor: { id: string | null; name: string | null } | null; detail: { after: Record<string, unknown> | null; body: string | null }; refs: { entityType: string; entityId: string } };

async function as(persona: string, url: string, method: "GET" | "POST" | "PATCH" = "GET", body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId }, ...(body === undefined ? {} : { body }) });
}
async function timeline(envelopeId: string, query = ""): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | null = null;
  do {
    const res = await as("planner", `/api/v1/envelopes/${envelopeId}/timeline?limit=200${query}${cursor ? `&cursor=${cursor}` : ""}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    out.push(...(res.body["rows"] as Row[]));
    cursor = res.body["nextCursor"] as string | null;
  } while (cursor);
  return out;
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

describe("a reconstruction test replays 12 months of synthetic history and matches expected totals", () => {
  it("folding each leaf's timeline (audit rows only) reproduces golden.assertions.ts at every instant", async () => {
    const instants = { "2026-02-01": "2026-02-01T00:00:00.000Z", "2026-05-01": "2026-05-01T00:00:00.000Z", "2026-08-01": "2026-08-01T00:00:00.000Z", current: "9999-12-31T00:00:00.000Z" } as const;
    const sums = Object.fromEntries(Object.keys(instants).map((k) => [k, { total: new Decimal(0), byRegion: new Map<string, Decimal>() }]));
    // Every leaf envelope in the workspace: the planned leaves plus the split's parts (T-014).
    const splitParts = A.split.parts.map((p) => ({ key: `${GOLDEN_SPLIT.sourceKey}#${p.retailer}`, region: "LATAM" }));
    const all = [...leaves.map((l) => ({ key: l.key, region: l.dimensionValues["region"] as string })), ...splitParts];
    for (const leaf of all) {
      const approvals = (await timeline(id(leaf.key)))
        .filter((r) => r.kind === "envelope.version.approved")
        .map((r) => ({ at: String(r.detail.after?.["approvedAt"]), amount: new Decimal(String(r.detail.after?.["amountReporting"])) }))
        .sort((a, b) => a.at.localeCompare(b.at));
      if (leaf.key === GOLDEN_SPLIT.sourceKey) {
        // Three planned rounds, then the zero version the split approved.
        expect(approvals.map((a) => a.at)).toEqual([...GOLDEN_ROUNDS.map((r) => r.approvedAt), GOLDEN_SPLIT.at]);
        expect(approvals.at(-1)?.amount.toFixed(2)).toBe("0.00");
      } else if (leaf.key.includes("#")) {
        expect(approvals.map((a) => a.at)).toEqual([GOLDEN_SPLIT.at]);
      } else {
        expect(approvals.map((a) => a.at)).toEqual(GOLDEN_ROUNDS.map((r) => r.approvedAt));
      }
      for (const [label, instant] of Object.entries(instants)) {
        const last = approvals.filter((a) => a.at <= instant).at(-1);
        const s = sums[label]!;
        const amount = last?.amount ?? new Decimal(0);
        s.total = s.total.plus(amount);
        s.byRegion.set(leaf.region, (s.byRegion.get(leaf.region) ?? new Decimal(0)).plus(amount));
      }
    }
    for (const label of Object.keys(instants) as Array<keyof typeof instants>) {
      const s = sums[label]!;
      expect(s.total.toFixed(2)).toBe(A.leafBudget[label].total);
      expect(Object.fromEntries([...s.byRegion].map(([k, v]) => [k, v.toFixed(2)]))).toEqual(A.leafBudget[label].byRegion);
    }
  }, 120_000);
});

describe("GET /budgets?as_of=YYYY-MM-DD returns exactly the approved amounts at that instant", () => {
  it.each(["2026-02-01", "2026-05-01", "2026-08-01"] as const)("GET /envelopes/:id?as_of=%s summed over the leaves matches the assertions", async (date) => {
    let total = new Decimal(0);
    const byRegion = new Map<string, Decimal>();
    for (const leaf of leaves) {
      const res = await as("planner", `/api/v1/envelopes/${id(leaf.key)}?as_of=${date}`);
      expect(res.status).toBe(200);
      const approved = (res.body["asOf"] as { approved: { amountReporting: string } | null }).approved;
      const amount = new Decimal(approved?.amountReporting ?? 0);
      total = total.plus(amount);
      const region = leaf.dimensionValues["region"] as string;
      byRegion.set(region, (byRegion.get(region) ?? new Decimal(0)).plus(amount));
    }
    expect(total.toFixed(2)).toBe(A.leafBudget[date].total);
    expect(Object.fromEntries([...byRegion].map(([k, v]) => [k, v.toFixed(2)]))).toEqual(A.leafBudget[date].byRegion);
  }, 60_000);

  it("is exact at the instant: an approval counts from its approved_at, not a millisecond earlier", async () => {
    const leaf = leaves[0]!;
    const round2 = GOLDEN_ROUNDS[1].approvedAt;
    const justBefore = new Date(Date.parse(round2) - 1).toISOString();
    const at = async (asOf: string) => ((await as("planner", `/api/v1/envelopes/${id(leaf.key)}?as_of=${encodeURIComponent(asOf)}`)).body["asOf"] as { approved: { amount: string; versionNo: number } | null }).approved;
    expect((await at(round2))?.amount).toBe(leaf.versions[1]?.amount);
    expect((await at(justBefore))?.amount).toBe(leaf.versions[0]?.amount);
    expect(await at("2026-01-04")).toBeNull();
    expect((await at("2026-01-05"))?.amount).toBe(leaf.versions[0]?.amount); // a bare date is the end of that day
    const bad = await as("planner", `/api/v1/envelopes/${id(leaf.key)}?as_of=last-tuesday`);
    expect(bad.status).toBe(422);
  });
});

describe("Any envelope or roll-up shows a full timeline from audit data alone", () => {
  it("a leaf's timeline tells its whole story, newest first", async () => {
    const leaf = leaves.find((l) => l.versions.some((v, i) => i > 0 && v.amount !== l.versions[i - 1]?.amount))!;
    const rows = await timeline(id(leaf.key));
    expect([...rows].sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)))).toEqual(rows);
    const kinds = rows.map((r) => r.kind);
    expect(kinds.at(-1)).toBe("envelope.created");
    expect(kinds.filter((k) => k === "envelope.version.approved")).toHaveLength(3);
    expect(kinds.filter((k) => k === "envelope.version.created")).toHaveLength(2); // rounds 2 and 3 re-plans
    const created = rows.find((r) => r.kind === "envelope.created")!;
    expect(created.actor?.name).toBe("Golden planner");
    expect(created.title).toBe("Envelope created");
    // Every approval request of this leaf is on it, with its decisions.
    const requests = new Set(rows.filter((r) => r.refs.entityType === "approval_request").map((r) => r.refs.entityId));
    const dbRequests = await owner.approvalRequest.count({ where: { entityId: { in: (await owner.envelopeVersion.findMany({ where: { envelopeId: id(leaf.key) }, select: { id: true } })).map((v) => v.id) } } });
    expect(requests.size).toBe(dbRequests);
  });

  it("a roll-up shows its subtree; without descendants only its own rows; pages never repeat", async () => {
    const region = plan.find((e) => e.level === 0 && e.dimensionValues["region"] === "LATAM")!;
    const own = await timeline(id(region.key));
    expect(own.every((r) => r.refs.entityType !== "envelope" || r.refs.entityId === id(region.key))).toBe(true);
    const subtree = plan.filter((e) => e.key === region.key || e.key.startsWith(`${region.key}/`));
    // The split (T-014) is in LATAM: +1 zero version on the source, +1 approved version per part.
    const split = GOLDEN_SPLIT.sourceKey.startsWith(`${region.key}/`) ? A.split.parts.length : 0;
    const all = await timeline(id(region.key), "&descendants=true");
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    const approvals = all.filter((r) => r.kind === "envelope.version.approved").length;
    expect(approvals).toBe(subtree.reduce((n, e) => n + e.versions.length, 0) + (split ? 1 + split : 0));
    expect(all.filter((r) => r.kind === "envelope.created")).toHaveLength(subtree.length + split);
  }, 60_000);

  it("comments, alerts, ingest runs and closures appear alongside audit rows", async () => {
    const leaf = leaves[1]!;
    const envelopeId = id(leaf.key);
    // A comment through the product: request changes on a new draft opens a thread with the comment.
    const env = (await as("planner", `/api/v1/envelopes/${envelopeId}`)).body;
    const draft = await as("planner", `/api/v1/envelopes/${envelopeId}/draft`, "PATCH", { amount: "12345.00", basedOnVersionId: env["currentVersionId"] });
    expect(draft.status).toBe(200);
    const submitted = await as("planner", `/api/v1/envelopes/${envelopeId}/submit`, "POST", { versionId: draft.body["id"] });
    expect(submitted.status).toBe(201);
    const decided = await as("budgetOwner", `/api/v1/approvals/${String(submitted.body["requestId"])}/decisions`, "POST", { decision: "request_changes", comment: "Please split by retailer" });
    expect(decided.status).toBe(201);
    // Alerts, ingest and closures have no commands yet (T-018, T-017, T-024): fixture rows.
    const ws = golden.workspaceId;
    await owner.$executeRawUnsafe(
      `INSERT INTO alert (id, workspace_id, rule_id, envelope_id, severity, status, metric_value, threshold, context, opened_at, resolved_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'high', 'RESOLVED', 1.4, 1.2, '{}'::jsonb, '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z')`,
      randomUUID(), ws, randomUUID(), envelopeId,
    );
    const source = randomUUID();
    const run = randomUUID();
    await owner.$executeRawUnsafe(`INSERT INTO data_source (id, workspace_id, kind, name, config, mapping) VALUES ($1::uuid, $2::uuid, 'csv', 'fixture', '{}'::jsonb, '{}'::jsonb)`, source, ws);
    await owner.$executeRawUnsafe(`INSERT INTO ingest_run (id, source_id, started_at, finished_at, status, rows_accepted) VALUES ($1::uuid, $2::uuid, '2026-03-03T00:00:00Z', '2026-03-03T00:05:00Z', 'succeeded', 1)`, run, source);
    await owner.$executeRawUnsafe(
      `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash)
       VALUES ($1::uuid, $2::uuid, '{}'::jsonb, '2026-03-01', 'USD', 10, 10, 'csv', $3::uuid, $4)`,
      ws, envelopeId, run, randomUUID(),
    );
    const period = randomUUID();
    await owner.$executeRawUnsafe(`INSERT INTO fiscal_period (id, workspace_id, key, kind, start_date, end_date) VALUES ($1::uuid, $2::uuid, 'FY26', 'year', '2026-01-01', '2026-12-31')`, period, ws);
    await owner.$executeRawUnsafe(`UPDATE envelope SET period_id = $1::uuid WHERE id = $2::uuid`, period, envelopeId);
    await owner.$executeRawUnsafe(
      `INSERT INTO period_closure (id, workspace_id, period_id, status, closed_by, closed_at, registry_version, bq_table, variance_summary)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'closed', $4::uuid, '2026-03-04T00:00:00Z', '{}'::jsonb, 'fixture', '{}'::jsonb)`,
      randomUUID(), ws, period, golden.users.admin,
    );

    const rows = await timeline(envelopeId);
    const kinds = new Set(rows.map((r) => r.kind));
    for (const k of ["comment.created", "approval.request_changes", "alert.opened", "alert.resolved", "ingest.completed", "closure.closed"]) expect(kinds).toContain(k);
    expect(rows.find((r) => r.kind === "comment.created")?.detail.body).toBe("Please split by retailer");
    expect(rows.find((r) => r.kind === "comment.created")?.actor?.name).toBe("Golden budgetOwner");
  }, 60_000);

  it("rejects bad parameters", async () => {
    const leaf = id(leaves[2]!.key);
    expect((await as("planner", `/api/v1/envelopes/${leaf}/timeline?limit=0`)).status).toBe(422);
    expect((await as("planner", `/api/v1/envelopes/${leaf}/timeline?cursor=nope`)).status).toBe(422);
    expect((await as("planner", `/api/v1/envelopes/${leaf}/timeline?descendants=maybe`)).status).toBe(422);
    expect((await as("planner", `/api/v1/envelopes/${randomUUID()}/timeline`)).status).toBe(404);
  });
});
