import { randomUUID } from "node:crypto";
import { LIVE_LEAVES, TimelineResponse, effectiveTargetAt, type TimelineBar } from "@budget/domain";
import { Decimal } from "decimal.js";
import LZString from "lz-string";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/**
 * T-037 done-when (spec §23, §22): GET /workspaces/:ws/timeline on the golden workspace. Group bars
 * add up to /query; the as-of redraw matches /query?asOf envelope by envelope; targets are lanes
 * under their envelope with the effective target per date (an annual, inherited CPA target and a Q4
 * override: the override in Q4, the annual before); markers and closures are there.
 */

const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `timeline-${randomUUID().slice(0, 8)}`;
const FY = "from=2026-01-01&to=2026-12-31";
const AS_OF = "2026-05-01T00:00:00.000Z";

async function as(persona: string, method: "GET" | "POST", url: string, body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId }, ...(body === undefined ? {} : { body }) });
}
async function timeline(qs: string): Promise<TimelineResponse & { headers: Record<string, unknown> }> {
  const res = await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/timeline?${FY}&limit=5000&${qs}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(200);
  return { ...TimelineResponse.parse(res.body), headers: res.headers };
}
async function query(body: Record<string, unknown>) {
  const all: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  let totals: Record<string, string | null> | undefined;
  do {
    const res = await as("planner", "POST", `/api/v1/workspaces/${golden.workspaceId}/query`, { workspaceId: golden.workspaceId, period: { kind: "range", start: "2026-01-01", end: "2026-12-31" }, filter: { logic: "and", children: LIVE_LEAVES }, measures: ["budget"], limit: 1000, ...body, ...(cursor ? { cursor } : {}) });
    expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(201);
    all.push(...(res.body["rows"] as Array<Record<string, unknown>>));
    totals = res.body["totals"] as Record<string, string | null>;
    cursor = res.body["nextCursor"] as string | null;
  } while (cursor);
  return { rows: all, totals: totals ?? {} };
}
const envelopes = (r: TimelineResponse) => r.bars.filter((b) => b.kind === "envelope");
const sum = (bars: TimelineBar[]) => bars.reduce((s, b) => s.plus(b.budget ?? 0), new Decimal(0)).toFixed(2);

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("GET /workspaces/:ws/timeline (T-037)", () => {
  it("groups by the hierarchy template; group bars add up to /query; one envelope bar per live leaf; X-Data-Version", async () => {
    const t = await timeline("groupBy=region,country");
    expect(t.headers["x-data-version"]).toBe(t.dataVersion);
    const q = await query({});
    expect(envelopes(t)).toHaveLength(q.rows.length);
    const regions = t.bars.filter((b) => b.kind === "group" && b.level === 0);
    expect(regions.map((b) => b.key).sort()).toEqual(expect.arrayContaining(["EMEA", "LATAM"]));
    expect(sum(regions)).toBe(new Decimal(q.totals["budget"] ?? 0).toFixed(2));
    // Every country sits under its region; every envelope under its country; dates span the children.
    const byKey = new Map(t.bars.map((b) => [b.key, b]));
    for (const b of t.bars.filter((x) => x.kind === "group" && x.level === 1)) expect(byKey.get(b.parentKey ?? "")?.level).toBe(0);
    for (const e of envelopes(t)) {
      const parent = byKey.get(e.parentKey ?? "");
      expect(parent?.kind).toBe("group");
      expect(parent && parent.start <= e.start && parent.end >= e.end).toBe(true);
    }
    expect(t.calendar.periods.filter((p) => p.kind === "quarter").map((p) => p.id)).toEqual(["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"]);
    // The default template when no groupBy: its path.
    const def = await timeline("");
    const template = await owner.hierarchyTemplate.findFirstOrThrow({ where: { workspaceId: golden.workspaceId, isDefault: true } });
    expect(Math.max(...envelopes(def).map((b) => b.level))).toBe(template.path.length);
  });

  it("as-of redraw matches /query?asOf: every envelope's budget and every group's total", async () => {
    const now = await timeline("groupBy=country");
    const then = await timeline(`groupBy=country&asOf=${encodeURIComponent(AS_OF)}`);
    expect(then.asOf).toBe(AS_OF);
    const q = await query({ asOf: AS_OF });
    const expected = new Map(q.rows.map((r) => [String(r["envelopeId"]), (r["measures"] as Record<string, string | null>)["budget"] ?? undefined]));
    expect(envelopes(then).map((b) => [b.envelopeId, b.budget])).toEqual(envelopes(then).map((b) => [b.envelopeId, expected.get(b.envelopeId ?? "")]));
    const groups = await query({ asOf: AS_OF, groupBy: ["country"] });
    const byCountry = new Map(groups.rows.map((r) => [(r["dimensions"] as Record<string, string>)["country"], (r["measures"] as Record<string, string>)["budget"]]));
    for (const g of then.bars.filter((b) => b.kind === "group")) expect(g.budget).toBe(byCountry.get(g.key));
    expect(sum(then.bars.filter((b) => b.kind === "group"))).not.toBe(sum(now.bars.filter((b) => b.kind === "group")));
  });

  it("targets are lanes under their envelope with the effective target per date; an asOf before a target's approval leaves it out", async () => {
    // A live leaf without its own CPA target inherits the country's (annual). Give it a Q4 override.
    const [leaf] = await owner.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT e.id::text FROM envelope e
       WHERE e.workspace_id = $1::uuid AND e.status <> 'ARCHIVED' AND NOT EXISTS (SELECT 1 FROM envelope c WHERE c.parent_id = e.id)
         AND NOT EXISTS (SELECT 1 FROM target t WHERE t.envelope_id = e.id) AND e.dimension_values ? 'audience'
       ORDER BY e.name LIMIT 1`,
      golden.workspaceId,
    );
    expect(leaf).toBeDefined();
    const targetId = randomUUID();
    const versionId = randomUUID();
    await owner.target.create({ data: { id: targetId, workspaceId: golden.workspaceId, scopeType: "envelope", envelopeId: leaf?.id as string, metricKey: "cpa", startDate: new Date("2026-10-01"), endDate: new Date("2026-12-31") } });
    await owner.targetVersion.create({ data: { id: versionId, targetId, versionNo: 1, value: "9.5", comparator: "lte", status: "APPROVED", createdBy: golden.users.planner, approvedAt: new Date() } });
    await owner.target.update({ where: { id: targetId }, data: { currentVersionId: versionId } });

    const t = await timeline("groupBy=country");
    const env = t.bars.find((b) => b.kind === "envelope" && b.envelopeId === leaf?.id);
    expect(env?.hasChildren).toBe(true);
    const lanes = t.bars.filter((b) => b.kind === "target" && b.parentKey === env?.key);
    const q4 = lanes.find((b) => b.targetId === targetId);
    const annual = lanes.find((b) => b.metric === "cpa" && b.inheritedFrom !== undefined);
    expect(q4).toMatchObject({ value: "9.5000", comparator: "lte", start: "2026-10-01", end: "2026-12-31", effective: [{ start: "2026-10-01", end: "2026-12-31" }] });
    // Inherited from an ancestor (the country envelope), not set on the leaf.
    const ancestors = await owner.$queryRawUnsafe<Array<{ id: string }>>(
      `WITH RECURSIVE up AS (SELECT id, parent_id FROM envelope WHERE id = $1::uuid UNION ALL SELECT p.id, p.parent_id FROM envelope p JOIN up ON p.id = up.parent_id) SELECT id::text FROM up WHERE id <> $1::uuid`,
      leaf?.id,
    );
    expect(ancestors.map((a) => a.id)).toContain(annual?.inheritedFrom);
    expect(annual?.effective).toEqual([{ start: annual?.start, end: "2026-09-30" }]);
    expect(new Set([q4?.lane, annual?.lane])).toEqual(new Set([0, 1]));
    // Per date, the effective one is the one whose `effective` range holds the date.
    const asLane = lanes.map((b) => ({ id: b.targetId as string, metric: b.metric as string, start: b.start, end: b.end, depth: b.inheritedFrom ? 1 : 0 }));
    for (const date of ["2026-03-15", "2026-09-30", "2026-10-01", "2026-12-31"]) {
      const winner = effectiveTargetAt(asLane, "cpa", date);
      const holder = lanes.find((b) => b.effective?.some((s) => s.start <= date && s.end >= date));
      expect(holder?.targetId).toBe(winner?.id);
    }
    expect(effectiveTargetAt(asLane, "cpa", "2026-11-15")?.id).toBe(targetId);
    // A leaf with its own annual override: the country's target is inherited but never effective.
    const overridden = t.bars.filter((b) => b.kind === "target" && b.inheritedFrom === undefined && b.targetId !== targetId);
    expect(overridden.length).toBeGreaterThan(0);
    const sibling = t.bars.find((b) => b.kind === "target" && b.parentKey === overridden[0]?.parentKey && b.inheritedFrom !== undefined);
    expect(sibling?.effective).toEqual([]);

    const before = await timeline(`groupBy=country&asOf=${encodeURIComponent(AS_OF)}`);
    expect(before.bars.some((b) => b.targetId === targetId)).toBe(false);
  });

  it("markers on envelope rows; closures as key dates; the filter travels as lz-string", async () => {
    const t = await timeline("groupBy=country");
    const kinds = new Set(envelopes(t).flatMap((b) => b.markers.map((m) => m.kind)));
    expect(kinds.has("alert") || kinds.has("comment") || kinds.has("approval") || kinds.has("version")).toBe(true);
    for (const m of envelopes(t).flatMap((b) => b.markers)) expect(m.at >= "2026-01-01" && m.at <= "2026-12-31").toBe(true);
    const closures = await owner.$queryRawUnsafe<Array<{ key: string; at: string }>>(
      `SELECT fp.key, (c.closed_at AT TIME ZONE 'UTC')::date::text AS at FROM period_closure c JOIN fiscal_period fp ON fp.id = c.period_id WHERE c.workspace_id = $1::uuid AND c.closed_at < '2027-01-01' ORDER BY c.closed_at`,
      golden.workspaceId,
    );
    expect(t.calendar.keyDates).toEqual(closures.map((c) => ({ at: c.at, label: c.key, kind: "closure" })));

    const br = { logic: "and", children: [{ field: { kind: "dimension", key: "country" }, op: "eq", value: "BR" }] };
    const filtered = await timeline(`groupBy=country&filter=${LZString.compressToEncodedURIComponent(JSON.stringify(br))}`);
    expect(filtered.bars.filter((b) => b.kind === "group").map((b) => b.key)).toEqual(["BR"]);
    const q = await query({ filter: { logic: "and", children: [...LIVE_LEAVES, br] } });
    expect(envelopes(filtered)).toHaveLength(q.rows.length);
    const json = await timeline(`groupBy=country&filter=${encodeURIComponent(JSON.stringify(br))}`);
    expect(envelopes(json)).toHaveLength(q.rows.length);
    const bad = await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/timeline?filter=nonsense`);
    expect(bad.status).toBe(422);
  });

  it("pages envelopes by cursor; groups come with the first page only", async () => {
    const first = await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/timeline?${FY}&groupBy=country&limit=5`);
    const p1 = TimelineResponse.parse(first.body);
    expect(envelopes(p1)).toHaveLength(5);
    expect(p1.nextCursor).not.toBeNull();
    const second = TimelineResponse.parse((await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/timeline?${FY}&groupBy=country&limit=5&cursor=${p1.nextCursor ?? ""}`)).body);
    expect(second.bars.some((b) => b.kind === "group")).toBe(false);
    expect(envelopes(second)[0]?.name.localeCompare(envelopes(p1).at(-1)?.name ?? "")).toBeGreaterThanOrEqual(0);
  });
});
