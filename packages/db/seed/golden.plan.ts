import { rephase } from "@budget/domain";
import { Decimal } from "decimal.js";

/**
 * The golden dataset as a pure, deterministic plan (spec §21). `apps/api/src/seed/golden.ts` turns
 * it into rows by calling the real registry, envelope and approval commands; `golden.assertions.ts`
 * holds the totals this plan implies. Same seed → same plan, byte for byte.
 *
 * Scope (LOCAL_BUILD_PHASES phase 9): registry, envelope tree, approved versions, phasing. Facts,
 * threads, tags, pacing rules and closures are added by the tasks that build their commands;
 * targets arrived with T-015 (goldenTargets).
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
  };
}
