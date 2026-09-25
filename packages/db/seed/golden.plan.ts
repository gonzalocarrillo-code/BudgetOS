import { rephase } from "@budget/domain";
import { Decimal } from "decimal.js";
import { DEFAULT_DIMENSIONS, DEFAULT_HIERARCHY } from "./defaults.registry.js";

/**
 * The golden dataset as a pure, deterministic plan (spec §21). `apps/api/src/seed/golden.ts` turns
 * it into rows by calling the real registry, envelope and approval commands; `golden.assertions.ts`
 * holds the totals this plan implies. Same seed → same plan, byte for byte.
 *
 * Scope (LOCAL_BUILD_PHASES phase 9): registry, envelope tree, approved versions, phasing. Facts,
 * threads, tags, pacing rules and closures are added by the tasks that build their commands;
 * targets arrived with T-015 (goldenTargets), facts with T-017 (goldenFactsCsv), pacing alerts with
 * T-018 (GOLDEN_PACING), threads and tags with T-019 (GOLDEN_COLLAB), search documents with T-020,
 * roll-up trees with T-022.
 */

export const GOLDEN_SEED = 20260101;
export const GOLDEN_FY = { start: "2026-01-01", end: "2026-12-31" };

/** Approval rounds: every leaf gets one approved version per round; parents are approved in round 1. */
export const GOLDEN_ROUNDS = [
  { round: 1, approvedAt: "2026-01-05T12:00:00.000Z" },
  { round: 2, approvedAt: "2026-04-01T12:00:00.000Z" },
  { round: 3, approvedAt: "2026-07-01T12:00:00.000Z" },
] as const;

export const GOLDEN_TREE = {
  regions: [
    { code: "LATAM", countries: ["BR", "MX", "AR", "CO"] },
    { code: "EMEA", countries: ["DE", "FR", "ES", "GB"] },
  ],
  platforms: ["meta", "google_ads", "tiktok", "amazon"],
  objectives: ["awareness", "consideration", "conversion"],
  audiences: ["prospecting", "retargeting"],
} as const;

/** Custom dimensions on top of the default registry (spec §21). `market_tier` uses an asset: icon. */
export const GOLDEN_CUSTOM_DIMENSIONS = [
  { key: "retailer", label: "Retailer", icon: "lucide:store", values: [["walmart", "Walmart"], ["carrefour", "Carrefour"], ["mercado_libre", "Mercado Libre"]] },
  { key: "promo_wave", label: "Promo wave", icon: "lucide:waves", values: [["w1", "Wave 1"], ["w2", "Wave 2"], ["w3", "Wave 3"]] },
  { key: "market_tier", label: "Market tier", icon: "asset", values: [["tier1", "Tier 1"], ["tier2", "Tier 2"], ["tier3", "Tier 3"]] },
] as const;

export const GOLDEN_TEMPLATES = [
  { name: "Region first", path: ["region", "country", "platform", "objective", "audience"] },
  { name: "Channel first", path: ["channel", "platform", "objective", "audience"] },
] as const;

/**
 * T-013's rows: after round 3, a bulk +5% on every EMEA × amazon leaf, committed and left pending
 * approval. Pending drafts never count as budget, so every approved total above is unchanged.
 */
export const GOLDEN_PENDING_BULK = { region: "EMEA", platform: "amazon", pct: 5, rationale: "Q4 retail push (bulk, pending approval)" } as const;

/**
 * T-014's rows: on 2026-09-01 (after every as-of date) one leaf is split 60/40 by retailer. The
 * source gets a zero version and is archived; the parts sum to its approved amount, so every
 * budget total is unchanged. Adds 2 envelopes and 3 approved versions.
 */
export const GOLDEN_SPLIT = {
  sourceKey: "LATAM/AR/amazon/conversion/retargeting",
  at: "2026-09-01T12:00:00.000Z",
  parts: [
    { name: "AR amazon conversion retargeting · Walmart", retailer: "walmart", share: 0.6 },
    { name: "AR amazon conversion retargeting · Mercado Libre", retailer: "mercado_libre", share: null },
  ],
  rationale: "Split by retailer (T-014 seed)",
} as const;

/** Part amounts: the first shares are rounded to the cent, the last takes the rest. */
export function splitAmounts(plan: PlannedEnvelope[]): Array<{ name: string; retailer: string; amount: string }> {
  const src = plan.find((e) => e.key === GOLDEN_SPLIT.sourceKey);
  const total = new Decimal(src?.versions.at(-1)?.amount ?? 0);
  let used = new Decimal(0);
  return GOLDEN_SPLIT.parts.map((p) => {
    const amount = p.share === null ? total.minus(used) : total.mul(p.share).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    used = used.plus(amount);
    return { name: p.name, retailer: p.retailer, amount: amount.toFixed(2) };
  });
}

/**
 * T-015's rows: a CPA target on every country envelope (leaves inherit it), an override on every
 * other leaf in plan order (never the split source), and one filter-scoped ROAS target on EMEA. A
 * workspace policy auto-approves target versions, so every target is current after the seed.
 */
export const GOLDEN_TARGET_POLICY = { name: "Targets auto-approve (golden)", priority: 0 } as const;
export const GOLDEN_FILTER_TARGET = { metricKey: "roas", region: "EMEA", value: "3.5", comparator: "gte" } as const;

export interface PlannedTarget {
  envelopeKey: string;
  metricKey: "cpa";
  value: string; // NUMERIC(18,4) as a decimal string, USD
}

export function goldenTargets(plan: PlannedEnvelope[], seed = GOLDEN_SEED): PlannedTarget[] {
  const rand = prng(seed + 15);
  const cpa = () => new Decimal(Math.floor(rand() * 57) + 24).div(2).toFixed(2); // 12.00 … 40.00 in 0.50 steps
  const countries = plan.filter((e) => e.level === 1).map((e) => ({ envelopeKey: e.key, metricKey: "cpa" as const, value: cpa() }));
  const leaves = plan.filter((e) => e.level === 4 && e.key !== GOLDEN_SPLIT.sourceKey);
  const overrides = leaves.filter((_, i) => i % 2 === 0).map((e) => ({ envelopeKey: e.key, metricKey: "cpa" as const, value: cpa() }));
  return [...countries, ...overrides];
}

/**
 * T-017's rows: a spend + KPI CSV loaded through the real ingest pipeline. Eight months of actuals
 * (Jan–Aug 2026) for every live leaf except the split source, plus rows the pipeline must not match
 * (a valid US tuple with no envelope) and rows it must reject, each with its reason.
 */
export const GOLDEN_FACTS = {
  months: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"],
  header: ["REGION", "COUNTRY", "PLATFORM", "OBJECTIVE", "AUDIENCE", "MONTH", "SPEND_USD", "CONVERSIONS", "REVENUE"],
  /** Registry-valid, but no envelope has this tuple: lands in the unmatched queue. */
  unmatched: { region: "AMER", country: "US", platform: "Meta", objective: "awareness", audience: "prospecting", spend: "250.00" },
  rejected: [
    ["LATAM", "BR", "MySpace", "awareness", "prospecting", "2026-03", "10.00", "1", "20.00"],
    ["EMEA", "DE", "Meta", "awareness", "prospecting", "2026-13", "10.00", "1", "20.00"],
    ["EMEA", "FR", "TikTok", "conversion", "retargeting", "2026-04", "n/a", "1", "20.00"],
  ],
  mapping: {
    kind: "spend+kpi",
    columns: {
      REGION: { dimension: "region" },
      COUNTRY: { dimension: "country" },
      PLATFORM: { dimension: "platform", transform: "lower", valueMap: { "google ads": "google_ads" } },
      OBJECTIVE: { dimension: "objective" },
      AUDIENCE: { dimension: "audience" },
      MONTH: { role: "period_date", format: "yyyy-MM" },
      SPEND_USD: { role: "amount", currency: "USD" },
      CONVERSIONS: { role: "kpi", metric: "conversions" },
      REVENUE: { role: "kpi", metric: "revenue" },
    },
  },
} as const;

/** Leaves a golden tag goes on, in plan order. */
export function goldenTagLeaves(plan: PlannedEnvelope[], tagName: string): string[] {
  const t = GOLDEN_COLLAB.tags.find((x) => x.name === tagName);
  if (!t) return [];
  const keys = plan
    .filter((e) => e.level === 4 && e.key !== GOLDEN_SPLIT.sourceKey && Object.entries(t.select).every(([k, v]) => e.dimensionValues[k] === v))
    .map((e) => e.key);
  return t.first === null ? keys : keys.slice(0, t.first);
}

const PLATFORM_LABEL: Record<string, string> = { meta: "Meta", google_ads: "Google Ads", tiktok: "TikTok", amazon: "Amazon" };

export interface GoldenFactRow {
  leafKey: string | null; // null for the unmatched and rejected rows
  cells: string[];
}

/** The golden facts CSV rows in file order (header excluded). Same seed → same file. */
export function goldenFactRows(plan: PlannedEnvelope[], seed = GOLDEN_SEED): GoldenFactRow[] {
  const rand = prng(seed + 17);
  const rows: GoldenFactRow[] = [];
  for (const [i, e] of plan.filter((x) => x.level === 4 && x.key !== GOLDEN_SPLIT.sourceKey).entries()) {
    const cpa = new Decimal(Math.floor(rand() * 29) + 12); // 12 … 40
    const roas = new Decimal(Math.floor(rand() * 31) + 20).div(10); // 2.0 … 5.0
    const phasing = e.versions.find((v) => v.round === 3)?.phasing ?? [];
    const hot = i % 25 === 0; // T-018: a few leaves overspend (120 … 130 % of plan) so the over-pace rule fires
    for (const month of GOLDEN_FACTS.months) {
      const planned = new Decimal(phasing.find((p) => p.month === `${month}-01`)?.amount ?? 0);
      const pct = hot ? Math.floor(rand() * 11) + 120 : Math.floor(rand() * 31) + 80; // else 80 … 110 % of plan
      const spend = planned.mul(new Decimal(pct).div(100)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const d = e.dimensionValues;
      rows.push({
        leafKey: e.key,
        cells: [d["region"] ?? "", d["country"] ?? "", PLATFORM_LABEL[d["platform"] ?? ""] ?? "", d["objective"] ?? "", d["audience"] ?? "", month, spend.toFixed(2), spend.div(cpa).floor().toFixed(0), spend.mul(roas).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)],
      });
    }
  }
  const u = GOLDEN_FACTS.unmatched;
  for (const month of GOLDEN_FACTS.months) rows.push({ leafKey: null, cells: [u.region, u.country, u.platform, u.objective, u.audience, month, u.spend, "5", "500.00"] });
  for (const r of GOLDEN_FACTS.rejected) rows.push({ leafKey: null, cells: [...r] });
  return rows;
}

export function goldenFactsCsv(plan: PlannedEnvelope[]): string {
  return `${[GOLDEN_FACTS.header.join(","), ...goldenFactRows(plan).map((r) => r.cells.join(","))].join("\n")}\n`;
}

/**
 * T-018's rows: the default pacing rules, evaluated on three consecutive days. Rules read the
 * current fiscal year (FY2026 = calendar 2026). No projection facts exist, so the projection rules
 * never fire; CPA does not move from day to day, so the 3-day CPA rule opens on the third day.
 */
export const GOLDEN_PACING = { days: ["2026-08-13", "2026-08-14", "2026-08-15"], period: { start: "2026-01-01", end: "2026-12-31" } } as const;

/** Open alerts per default rule after GOLDEN_PACING.days, from the plan's budgets, facts and targets. */
function expectedPacing(plan: PlannedEnvelope[]): Record<string, number> {
  const facts = goldenFactRows(plan).filter((r) => r.leafKey !== null);
  const byLeaf = new Map<string, { spend: Decimal; conversions: Decimal }>();
  for (const r of facts) {
    const cur = byLeaf.get(r.leafKey as string) ?? { spend: new Decimal(0), conversions: new Decimal(0) };
    byLeaf.set(r.leafKey as string, { spend: cur.spend.plus(r.cells[6] ?? 0), conversions: cur.conversions.plus(r.cells[7] ?? 0) });
  }
  const targets = new Map(goldenTargets(plan).map((t) => [t.envelopeKey, new Decimal(t.value)]));
  const countryOf = (key: string) => key.split("/").slice(0, 2).join("/");
  const last = GOLDEN_PACING.days[GOLDEN_PACING.days.length - 1] as string;
  const dayMs = 86_400_000;
  const periodDays = (Date.parse(GOLDEN_PACING.period.end) - Date.parse(GOLDEN_PACING.period.start)) / dayMs + 1;
  const elapsed = new Decimal((Date.parse(last) - Date.parse(GOLDEN_PACING.period.start)) / dayMs + 1).div(periodDays);
  let overPace = 0;
  let cpaOver = 0;
  let cpaFar = 0;
  for (const e of plan.filter((x) => x.level === 4 && x.key !== GOLDEN_SPLIT.sourceKey)) {
    const f = byLeaf.get(e.key);
    const budget = new Decimal(e.versions.find((v) => v.round === 3)?.amount ?? 0);
    if (!f || budget.isZero()) continue;
    if (f.spend.div(budget).div(elapsed).gt("1.10")) overPace += 1;
    const target = targets.get(e.key) ?? targets.get(countryOf(e.key));
    if (target && !f.conversions.isZero()) {
      const vs = f.spend.div(f.conversions).div(target);
      if (vs.gt("1.10")) cpaOver += 1;
      if (vs.gt("1.25")) cpaFar += 1;
    }
  }
  return { "Over-pace": overPace, "Projected overrun": 0, "Projected underspend near close": 0, "CPA over target": cpaOver, "CPA far over target": cpaFar, "Implied volume gap": 0 };
}

/**
 * T-019's rows. Tags: `q4-push` on the EMEA × amazon leaves (the pending bulk's rows),
 * `brand-safety` on the first ten LATAM leaves. Threads: a blocking one on a GB leaf no other test
 * submits, a resolved one with a mention, and an open cell thread with a reply.
 */
/**
 * T-023's row: Finance exports the live LATAM leaves (the roll-up's population) as CSV through the
 * export command and worker. The file's rows and totals row must match the planner (A.exports).
 */
export const GOLDEN_EXPORT = { persona: "finance1", kind: "csv", filename: "golden-latam-live-leaves", region: "LATAM" } as const;

/**
 * T-024's rows: Finance closes 2026-Q1 through the close command (every live envelope locks, every
 * template's tree for the quarter and its months goes to the closure sink), then a workspace admin
 * restates it, so the golden workspace keeps one restated closure and no locked envelope.
 */
export const GOLDEN_CLOSURE = { periodKey: "2026-Q1", closer: "finance1", restater: "admin", reason: "Q1 actuals restated after the late invoice run (golden)" } as const;

export const GOLDEN_COLLAB = {
  tags: [
    { name: "q4-push", color: "#F97316", select: { region: "EMEA", platform: "amazon" }, first: null },
    { name: "brand-safety", color: "#0EA5E9", select: { region: "LATAM" }, first: 10 },
  ],
  threads: [
    { key: "blocking", leafKey: "EMEA/GB/google_ads/consideration/retargeting", author: "approver", isBlocking: true, anchor: "envelope", title: "Hold for Q4 retail plan", comments: ["Hold this until the Q4 retail plan lands."], resolve: false },
    { key: "resolved", leafKey: "LATAM/BR/meta/awareness/prospecting", author: "planner", isBlocking: false, anchor: "envelope", title: "Pacing check", comments: ["@budgetOwner is this pacing as planned?", "Yes, launch was moved to March."], resolve: true },
    { key: "cell", leafKey: "EMEA/DE/tiktok/conversion/prospecting", author: "budgetOwner", isBlocking: false, anchor: "cell", title: "October", comments: ["Can October take 10% more?", "Only if November gives it back."], resolve: false },
  ],
} as const;

export interface PlannedVersion {
  round: 1 | 2 | 3;
  amount: string; // NUMERIC(18,2), USD (the golden workspace reports in USD)
  phasing: Array<{ month: string; amount: string }>;
}

export interface PlannedEnvelope {
  /** Stable key, e.g. "LATAM/BR/meta/awareness/prospecting". */
  key: string;
  parentKey: string | null;
  level: 0 | 1 | 2 | 3 | 4; // region … audience
  name: string;
  dimensionValues: Record<string, string>;
  versions: PlannedVersion[]; // leaves: 3, parents: 1
}

/** mulberry32: tiny, well-known, deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MONTHS = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}-01`);

/** Twelve monthly slices, front-loaded ×1.3 in Q4 (Black Friday), remainder in December; sums exactly. */
export function phase(amount: Decimal): Array<{ month: string; amount: string }> {
  const weights = MONTHS.map((_, i) => (i >= 9 ? new Decimal(1.3) : new Decimal(1)));
  const total = weights.reduce((s, w) => s.plus(w), new Decimal(0));
  const slices = weights.map((w) => amount.mul(w).div(total).toDecimalPlaces(2, Decimal.ROUND_DOWN));
  const rest = amount.minus(slices.reduce((s, x) => s.plus(x), new Decimal(0)));
  slices[11] = (slices[11] ?? new Decimal(0)).plus(rest);
  return MONTHS.map((month, i) => ({ month, amount: (slices[i] ?? new Decimal(0)).toFixed(2) }));
}

/** Round-over-round changes a leaf can get. Mixes auto-approve, Minor and Standard routing. */
const CHANGES = [0.01, -0.015, 0.03, -0.04, 0.07, 0.12, -0.08] as const;

export function goldenPlan(seed = GOLDEN_SEED): PlannedEnvelope[] {
  const rand = prng(seed);
  const leaves: PlannedEnvelope[] = [];
  const { regions, platforms, objectives, audiences } = GOLDEN_TREE;
  for (const r of regions) {
    for (const c of r.countries) {
      for (const p of platforms) {
        for (const o of objectives) {
          for (const a of audiences) {
            // 2,000 … 9,900 in steps of 100: under Minor's 10,000 so small changes stay Minor.
            let amount = new Decimal(100).mul(20 + Math.floor(rand() * 80));
            const versions: PlannedVersion[] = [];
            for (const round of [1, 2, 3] as const) {
              if (round > 1) {
                const change = CHANGES[Math.floor(rand() * CHANGES.length)] ?? 0;
                amount = amount.mul(1 + change).toDecimalPlaces(2);
              }
              versions.push({ round, amount: amount.toFixed(2), phasing: phase(amount) });
            }
            leaves.push({
              key: `${r.code}/${c}/${p}/${o}/${a}`,
              parentKey: `${r.code}/${c}/${p}/${o}`,
              level: 4,
              name: `${c} ${p} ${o} ${a}`,
              dimensionValues: { region: r.code, country: c, platform: p, objective: o, audience: a },
              versions,
            });
          }
        }
      }
    }
  }

  // Parents: each approved once, at 105% of the most its children ever need (rounded up to a unit),
  // so no round exceeds the cap. Built bottom-up, listed top-down.
  const byKey = new Map<string, PlannedEnvelope>();
  const need = new Map<string, Decimal>();
  for (const leaf of leaves) {
    const peak = leaf.versions.reduce((m, v) => Decimal.max(m, v.amount), new Decimal(0));
    need.set(leaf.key, peak);
  }
  const parents: PlannedEnvelope[] = [];
  const levels = [3, 2, 1, 0] as const;
  let children = leaves;
  for (const level of levels) {
    const grouped = new Map<string, PlannedEnvelope[]>();
    for (const child of children) {
      const pk = child.parentKey as string;
      grouped.set(pk, [...(grouped.get(pk) ?? []), child]);
    }
    const made: PlannedEnvelope[] = [];
    for (const [key, kids] of grouped) {
      const sum = kids.reduce((s, k) => s.plus(need.get(k.key) ?? 0), new Decimal(0));
      const amount = sum.mul(1.05).toDecimalPlaces(0, Decimal.ROUND_UP);
      need.set(key, amount);
      const parts = key.split("/");
      const names = ["region", "country", "platform", "objective"].slice(0, parts.length);
      const env: PlannedEnvelope = {
        key,
        parentKey: parts.length > 1 ? parts.slice(0, -1).join("/") : null,
        level,
        name: parts.join(" "),
        dimensionValues: Object.fromEntries(names.map((n, i) => [n, parts[i] as string])),
        versions: [{ round: 1, amount: amount.toFixed(2), phasing: phase(amount) }],
      };
      made.push(env);
      byKey.set(key, env);
    }
    parents.unshift(...made);
    children = made;
  }
  // Top-down: regions, countries, platforms, objectives, then leaves.
  parents.sort((a, b) => a.level - b.level || a.key.localeCompare(b.key));
  return [...parents, ...leaves];
}

export interface GoldenTotals {
  envelopes: { total: number; leaves: number; parents: number };
  approvedVersions: number;
  /** Leaf budget (reporting currency) as of each instant; "current" = after round 3. */
  leafBudget: Record<"2026-02-01" | "2026-05-01" | "2026-08-01" | "current", { total: string; byRegion: Record<string, string> }>;
  leafBudgetCurrent: { byCountry: Record<string, string>; byPlatform: Record<string, string>; byObjective: Record<string, string> };
  parentBudget: { byRegion: Record<string, string> };
  /** Current leaf phasing summed by quarter. */
  leafPhasingByQuarter: Record<"Q1" | "Q2" | "Q3" | "Q4", string>;
  /** The pending bulk change (GOLDEN_PENDING_BULK): rows and before/after totals (USD). */
  pendingBulk: { rows: number; totalsBefore: string; totalsAfter: string };
  /** The split (GOLDEN_SPLIT): source, parts and their approved amounts. */
  split: { sourceKey: string; parts: Array<{ name: string; retailer: string; amount: string }> };
  /**
   * T-015 targets. `effectiveCpa` covers the live leaves (split parts in, archived source out): own
   * target, else the country's, summed by region — what effective_target() resolves.
   */
  targets: { envelope: number; filter: number; leafOverrides: number; effectiveCpa: { leaves: number; byRegion: Record<string, string> }; filterRoasLeaves: number };
  /** T-017: the golden facts CSV through the ingest pipeline (reporting currency). */
  facts: {
    rowsRead: number;
    rowsRejected: number;
    spendRows: number;
    matchedSpendRows: number;
    spend: string;
    matchedSpend: string;
    matchCoverage: string;
    leafActualByRegion: Record<string, string>;
    leafConversionsByRegion: Record<string, string>;
    unmatchedTuples: number;
  };
  /** T-018: open alerts per default rule after evaluating GOLDEN_PACING.days. */
  pacing: { days: string[]; openAlertsByRule: Record<string, number> };
  /** T-019: threads, comments and tag counts (GOLDEN_COLLAB). */
  collab: { tags: Record<string, number>; threads: { open: number; resolved: number; blocking: number }; comments: number; envelopesWithOpenThreads: number };
  /** T-020: search documents per type after the seed's full re-index (approvals are counted against the request table). */
  search: Record<"envelope" | "target" | "alert" | "comment" | "tag" | "dimension_value", number>;
  /** T-022: rollup_cache nodes per template and depth (0 = root) for GOLDEN_FY; root budget and actual over the live leaves. */
  rollup: { nodesByTemplate: Record<string, number[]>; rootBudget: string; rootActual: string };
  /** T-023: the GOLDEN_EXPORT file: data rows and the totals row's budget. */
  exports: { rows: number; budget: string };
  /** T-024: the GOLDEN_CLOSURE close: envelopes locked, sink rows (every template's nodes × (quarter + 3 months)), root budget and actual. */
  closure: { lockedEnvelopes: number; rows: number; budget: string; actual: string };
}

const AS_OF: Record<"2026-02-01" | "2026-05-01" | "2026-08-01" | "current", 1 | 2 | 3> = { "2026-02-01": 1, "2026-05-01": 2, "2026-08-01": 3, current: 3 };

function sumBy(rows: Array<{ k: string; v: Decimal }>): Record<string, string> {
  const m = new Map<string, Decimal>();
  for (const r of rows) m.set(r.k, (m.get(r.k) ?? new Decimal(0)).plus(r.v));
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.toFixed(2)]));
}

/** What `golden.assertions.ts` must contain for a plan. A test keeps the committed file in sync. */
export function computeTotals(plan: PlannedEnvelope[]): GoldenTotals {
  const leaves = plan.filter((e) => e.level === 4);
  const parents = plan.filter((e) => e.level < 4);
  const at = (e: PlannedEnvelope, round: number) => new Decimal(e.versions.find((v) => v.round === round)?.amount ?? 0);
  const leafBudget = Object.fromEntries(
    Object.entries(AS_OF).map(([label, round]) => {
      const rows = leaves.map((e) => ({ k: e.dimensionValues["region"] as string, v: at(e, round) }));
      return [label, { total: rows.reduce((s, r) => s.plus(r.v), new Decimal(0)).toFixed(2), byRegion: sumBy(rows) }];
    }),
  ) as GoldenTotals["leafBudget"];
  const current = (dim: string) => sumBy(leaves.map((e) => ({ k: e.dimensionValues[dim] as string, v: at(e, 3) })));
  const quarter = (month: string) => `Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}` as "Q1";
  // The split source's current version is its zero (no phasing); its parts re-phase its round-3 shape.
  const splitSource = leaves.find((e) => e.key === GOLDEN_SPLIT.sourceKey);
  const sourceShape = (splitSource?.versions.find((v) => v.round === 3)?.phasing ?? []).map((p) => ({ month: p.month, amount: new Decimal(p.amount) }));
  const partPhasing = splitAmounts(plan).flatMap((p) => rephase(sourceShape, new Decimal(p.amount)).map((x) => ({ month: x.month, amount: x.amount.toFixed(2) })));
  const currentPhasing = [...leaves.filter((e) => e.key !== GOLDEN_SPLIT.sourceKey).flatMap((e) => e.versions.find((v) => v.round === 3)?.phasing ?? []), ...partPhasing];
  const phasing = sumBy(currentPhasing.map((p) => ({ k: quarter(p.month), v: new Decimal(p.amount) })));
  return {
    // The split adds its parts (envelopes) and a zero version for the source plus one per part.
    envelopes: { total: plan.length + GOLDEN_SPLIT.parts.length, leaves: leaves.length, parents: parents.length },
    approvedVersions: plan.reduce((n, e) => n + e.versions.length, 0) + 1 + GOLDEN_SPLIT.parts.length,
    leafBudget,
    leafBudgetCurrent: { byCountry: current("country"), byPlatform: current("platform"), byObjective: current("objective") },
    parentBudget: { byRegion: sumBy(parents.filter((p) => p.level === 0).map((p) => ({ k: p.dimensionValues["region"] as string, v: at(p, 1) }))) },
    leafPhasingByQuarter: phasing as GoldenTotals["leafPhasingByQuarter"],
    pendingBulk: (() => {
      const b = GOLDEN_PENDING_BULK;
      const rows = leaves.filter((e) => e.dimensionValues["region"] === b.region && e.dimensionValues["platform"] === b.platform);
      const before = rows.reduce((s, e) => s.plus(at(e, 3)), new Decimal(0));
      // Same rounding as the bulk `pct` operation: per row, to the cent, half up.
      const after = rows.reduce((s, e) => s.plus(at(e, 3).mul(100 + b.pct).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)), new Decimal(0));
      return { rows: rows.length, totalsBefore: before.toFixed(2), totalsAfter: after.toFixed(2) };
    })(),
    split: { sourceKey: GOLDEN_SPLIT.sourceKey, parts: splitAmounts(plan) },
    targets: (() => {
      const targets = goldenTargets(plan);
      const own = new Map(targets.map((t) => [t.envelopeKey, t.value]));
      const countryOf = (key: string) => key.split("/").slice(0, 2).join("/");
      const live = [
        ...leaves.filter((e) => e.key !== GOLDEN_SPLIT.sourceKey).map((e) => ({ key: e.key, region: e.dimensionValues["region"] as string })),
        ...GOLDEN_SPLIT.parts.map(() => ({ key: `${GOLDEN_SPLIT.sourceKey}#part`, region: GOLDEN_SPLIT.sourceKey.split("/")[0] as string })),
      ];
      const rows = live.map((l) => ({ k: l.region, v: new Decimal(own.get(l.key) ?? own.get(countryOf(l.key)) ?? 0) }));
      return {
        envelope: targets.length,
        filter: 1,
        leafOverrides: targets.filter((t) => t.envelopeKey.split("/").length === 5).length,
        effectiveCpa: { leaves: live.length, byRegion: sumBy(rows) },
        filterRoasLeaves: live.filter((l) => l.region === GOLDEN_FILTER_TARGET.region).length,
      };
    })(),
    facts: (() => {
      const rows = goldenFactRows(plan);
      const matched = rows.filter((r) => r.leafKey !== null);
      const valid = rows.length - GOLDEN_FACTS.rejected.length;
      const sum = (rs: GoldenFactRow[], i: number) => rs.reduce((acc, r) => acc.plus(r.cells[i] ?? 0), new Decimal(0));
      const spend = sum(rows.slice(0, valid), 6);
      const matchedSpend = sum(matched, 6);
      return {
        rowsRead: rows.length,
        rowsRejected: GOLDEN_FACTS.rejected.length,
        spendRows: valid,
        matchedSpendRows: matched.length,
        spend: spend.toFixed(2),
        matchedSpend: matchedSpend.toFixed(2),
        matchCoverage: matchedSpend.div(spend).toDecimalPlaces(6).toString(),
        leafActualByRegion: sumBy(matched.map((r) => ({ k: r.cells[0] ?? "", v: new Decimal(r.cells[6] ?? 0) }))),
        leafConversionsByRegion: sumBy(matched.map((r) => ({ k: r.cells[0] ?? "", v: new Decimal(r.cells[7] ?? 0) }))),
        unmatchedTuples: 1,
      };
    })(),
    pacing: { days: [...GOLDEN_PACING.days], openAlertsByRule: expectedPacing(plan) },
    collab: (() => {
      const threads = GOLDEN_COLLAB.threads;
      const open = threads.filter((t) => !t.resolve);
      return {
        tags: Object.fromEntries(GOLDEN_COLLAB.tags.map((t) => [t.name, goldenTagLeaves(plan, t.name).length])),
        threads: { open: open.length, resolved: threads.length - open.length, blocking: threads.filter((t) => t.isBlocking && !t.resolve).length },
        comments: threads.reduce((n, t) => n + t.comments.length, 0),
        // The planner's has_open_thread reads envelope-anchored threads only (a cell thread is on its envelope too).
        envelopesWithOpenThreads: new Set(open.filter((t) => t.anchor === "envelope").map((t) => t.leafKey)).size,
      };
    })(),
    rollup: (() => {
      // Live leaves: the split source is archived, but its parts are live leaves with the same tuple
      // (plus retailer) and the same total, so every plan leaf's tuple is a node.
      const live = leaves;
      const templates: Array<{ name: string; path: readonly string[] }> = [{ name: DEFAULT_HIERARCHY.name, path: DEFAULT_HIERARCHY.path }, ...GOLDEN_TEMPLATES];
      const nodesByTemplate = Object.fromEntries(
        templates.map((t) => [t.name, t.path.map((_, d) => new Set(live.map((e) => t.path.slice(0, d + 1).map((k) => e.dimensionValues[k] ?? "∅").join("/"))).size).reduce((acc, n) => [...acc, n], [1])]),
      );
      const facts = goldenFactRows(plan).filter((r) => r.leafKey !== null).reduce((s, r) => s.plus(r.cells[6] ?? 0), new Decimal(0));
      return { nodesByTemplate, rootBudget: leaves.reduce((s, e) => s.plus(at(e, 3)), new Decimal(0)).toFixed(2), rootActual: facts.toFixed(2) };
    })(),
    exports: (() => {
      // Live leaves of the region: the split source is archived and its parts are live, same total.
      const inRegion = leaves.filter((e) => e.dimensionValues["region"] === GOLDEN_EXPORT.region);
      const split = inRegion.some((e) => e.key === GOLDEN_SPLIT.sourceKey) ? GOLDEN_SPLIT.parts.length - 1 : 0;
      return { rows: inRegion.length + split, budget: inRegion.reduce((s, e) => s.plus(at(e, 3)), new Decimal(0)).toFixed(2) };
    })(),
    closure: (() => {
      // Every envelope spans FY2026, so all live ones overlap Q1: the plan, plus the split parts, minus the archived source.
      const lockedEnvelopes = plan.length + GOLDEN_SPLIT.parts.length - 1;
      const templates: Array<{ path: readonly string[] }> = [DEFAULT_HIERARCHY, ...GOLDEN_TEMPLATES];
      // Every leaf overlaps every month, so each month has every node the quarter has.
      const nodes = templates.reduce((n, t) => n + 1 + t.path.reduce((m, _, d) => m + new Set(leaves.map((e) => t.path.slice(0, d + 1).map((k) => e.dimensionValues[k] ?? "∅").join("/"))).size, 0), 0);
      const actual = goldenFactRows(plan)
        .filter((r) => r.leafKey !== null && (r.cells[5] ?? "") >= "2026-01" && (r.cells[5] ?? "") <= "2026-03")
        .reduce((s, r) => s.plus(r.cells[6] ?? 0), new Decimal(0));
      return { lockedEnvelopes, rows: nodes * 4, budget: leaves.reduce((s, e) => s.plus(at(e, 3)), new Decimal(0)).toFixed(2), actual: actual.toFixed(2) };
    })(),
    search: {
      envelope: plan.length + GOLDEN_SPLIT.parts.length,
      target: goldenTargets(plan).length + 1,
      alert: Object.values(expectedPacing(plan)).reduce((n, c) => n + c, 0),
      comment: GOLDEN_COLLAB.threads.reduce((n, t) => n + t.comments.length, 0),
      tag: GOLDEN_COLLAB.tags.length,
      dimension_value: DEFAULT_DIMENSIONS.reduce((n, d) => n + d.values.length, 0) + GOLDEN_CUSTOM_DIMENSIONS.reduce((n, d) => n + d.values.length, 0),
    },
  };
}
