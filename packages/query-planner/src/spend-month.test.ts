import { randomUUID } from "node:crypto";
import { QueryRequest } from "@budget/domain";
import { Decimal } from "decimal.js";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileQuery, monthSplit } from "./index.js";
import { closePools, owner, runAsApp } from "./test-support/db.js";
import { cleanupOrg, createOrg, createWorkspace, insertEnvelope, type FixtureOrg } from "./test-support/fixtures.js";

/**
 * ADR-037: `actual` sums whole months from spend_month and the partial months at a period's edges
 * from spend_fact. The triggers keep spend_month equal to the facts through every write, and the
 * planner's actual equals a direct sum of spend_fact for any period.
 */

describe("monthSplit", () => {
  it("splits a period into whole months and partial edges", () => {
    expect(monthSplit("2026-01-01", "2026-12-31")).toEqual({ full: ["2026-01-01", "2027-01-01"], edges: [] });
    expect(monthSplit("2026-04-01", "2026-06-30")).toEqual({ full: ["2026-04-01", "2026-07-01"], edges: [] });
    expect(monthSplit("2026-01-15", "2026-03-10")).toEqual({ full: ["2026-02-01", "2026-03-01"], edges: [["2026-01-15", "2026-01-31"], ["2026-03-01", "2026-03-10"]] });
    expect(monthSplit("2026-02-03", "2026-02-20")).toEqual({ full: null, edges: [["2026-02-03", "2026-02-20"]] });
    expect(monthSplit("2026-01-31", "2026-03-01")).toEqual({ full: ["2026-02-01", "2026-03-01"], edges: [["2026-01-31", "2026-01-31"], ["2026-03-01", "2026-03-01"]] });
    expect(monthSplit("2024-02-01", "2024-02-29")).toEqual({ full: ["2024-02-01", "2024-03-01"], edges: [] }); // leap year
    expect(monthSplit("2026-11-15", "2027-01-31")).toEqual({ full: ["2026-12-01", "2027-02-01"], edges: [["2026-11-15", "2026-11-30"]] });
  });
});

let org: FixtureOrg;
let ws: string;
let env: string;

const monthsFromTable = async () =>
  (await owner.query<{ month: string; amount: string; n: string }>(`SELECT month::text, amount_reporting::text AS amount, fact_count::text AS n FROM spend_month WHERE workspace_id = $1::uuid AND envelope_id = $2::uuid ORDER BY month`, [ws, env])).rows;
const monthsFromFacts = async () =>
  (await owner.query<{ month: string; amount: string; n: string }>(`SELECT date_trunc('month', period_date)::date::text AS month, sum(amount_reporting)::text AS amount, count(*)::text AS n FROM spend_fact WHERE workspace_id = $1::uuid AND envelope_id = $2::uuid GROUP BY 1 ORDER BY 1`, [ws, env])).rows;
const insertFact = (date: string, amount: string, envelopeId: string | null = env) =>
  owner.query(
    `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash)
     VALUES ($1::uuid, $2::uuid, '{}'::jsonb, $3::date, 'USD', $4::numeric, $4::numeric, 'csv', $5::uuid, $6) RETURNING id::text`,
    [ws, envelopeId, date, amount, randomUUID(), randomUUID()],
  );

beforeAll(async () => {
  org = await createOrg();
  ws = await createWorkspace(org);
  env = (await insertEnvelope(org, ws, { name: "spend-month", status: "APPROVED", start: "2026-01-01", end: "2026-12-31", versions: [{ amount: "1000.00", status: "APPROVED", approvedAt: "2026-01-01T00:00:00Z" }] })).id;
});

afterAll(async () => {
  if (org) await cleanupOrg(org);
  await closePools();
});

describe("spend_month", () => {
  it("follows inserts, re-matching, date moves and deletes", async () => {
    await insertFact("2026-01-05", "10.00");
    await insertFact("2026-01-20", "5.50");
    await insertFact("2026-02-02", "7.25");
    const unmatched = (await insertFact("2026-03-03", "4.00", null)).rows[0]?.id as string;
    expect(await monthsFromTable()).toEqual(await monthsFromFacts());
    expect((await monthsFromTable()).map((r) => r.month)).toEqual(["2026-01-01", "2026-02-01"]); // the unmatched fact is not counted

    await owner.query(`UPDATE spend_fact SET envelope_id = $2::uuid, match_method = 'manual' WHERE id = $1::uuid`, [unmatched, env]); // re-matched
    await owner.query(`UPDATE spend_fact SET period_date = '2026-04-10' WHERE workspace_id = $1::uuid AND period_date = '2026-02-02'`, [ws]); // across partitions
    await owner.query(`DELETE FROM spend_fact WHERE workspace_id = $1::uuid AND period_date = '2026-01-20'`, [ws]);
    expect(await monthsFromTable()).toEqual(await monthsFromFacts());
    expect((await monthsFromTable()).map((r) => r.month)).toEqual(["2026-01-01", "2026-03-01", "2026-04-01"]); // February emptied and removed
  });

  it("the planner's actual equals the facts' sum for any period (property)", async () => {
    await owner.query(`DELETE FROM spend_fact WHERE workspace_id = $1::uuid`, [ws]);
    // ~300 facts over the year, then random periods, month-aligned or not.
    for (let i = 0; i < 300; i += 1) {
      const day = new Date(Date.UTC(2026, 0, 1) + ((i * 37) % 365) * 86_400_000).toISOString().slice(0, 10);
      await insertFact(day, (((i * 7919) % 10_000) / 100).toFixed(2));
    }
    const day = fc.integer({ min: 0, max: 364 }).map((n) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10));
    await fc.assert(
      fc.asyncProperty(fc.tuple(day, day), async ([a, b]) => {
        const [start, end] = a <= b ? [a, b] : [b, a];
        const q = QueryRequest.parse({ workspaceId: ws, measures: ["actual"], period: { kind: "range", start, end }, limit: 10 });
        const c = compileQuery(q, { start, end }, "2026-06-15", { hasProjections: false });
        const [row] = await runAsApp(c, { workspaceId: ws, userId: null });
        const expected = (await owner.query<{ s: string }>(`SELECT coalesce(sum(amount_reporting),0)::text AS s FROM spend_fact WHERE workspace_id = $1::uuid AND envelope_id = $2::uuid AND period_date BETWEEN $3::date AND $4::date`, [ws, env, start, end])).rows[0]?.s;
        expect(new Decimal(String(row?.["actual"])).equals(new Decimal(expected ?? "0"))).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});
