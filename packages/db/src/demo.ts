import { randomUUID } from "node:crypto";
import { DomainError } from "@budget/domain";
import { Decimal } from "decimal.js";
import { DEFAULT_DIMENSIONS } from "../seed/defaults.registry.js";
import { ensurePartitions, matchRunFacts, upsertKpiFacts, upsertSpendFacts, type KpiFactInput, type SpendFactInput } from "./facts.js";
import { upsertDimensionValue } from "./registry.js";
import type { Tx } from "./sql.js";

/**
 * The demo dataset of a new workspace (spec §27): a small version of the golden plan — three
 * markets (BR, MX, US) under their regions, two platforms each, conversion / prospecting leaves —
 * with approved budgets phased by month, a CPA target per market, daily campaign-level spend and
 * KPI facts for every day of the fiscal year up to yesterday (EX-3), and one demo experiment
 * comparing two campaigns of the same budget. Every row it writes has `demo = true`; the facts
 * carry `source_system = 'demo'`. `purgeDemoData` deletes exactly those rows in one transaction.
 * The caller writes the audit_event and the outbox row.
 */

export interface DemoSummary {
  envelopes: number;
  leaves: number;
  facts: number;
  targets: number;
  campaigns: number;
  experiments: number;
  budget: string;
  envelopeIds: string[];
}

const MARKETS = [
  { region: "LATAM", country: "BR", label: "Brazil" },
  { region: "LATAM", country: "MX", label: "Mexico" },
  { region: "AMER", country: "US", label: "United States" },
] as const;
const PLATFORMS = [
  { code: "meta", label: "Meta" },
  { code: "google_ads", label: "Google Ads" },
] as const;
const LEAF = { objective: "conversion", audience: "prospecting" } as const;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Deterministic amounts so a demo workspace always shows the same numbers. */
function amountFor(i: number): Decimal {
  return new Decimal(18_000 + ((i * 7_919) % 9) * 4_000);
}

/** The fiscal year containing `today` (yyyy-MM-dd), which the demo data covers. */
export function demoPeriod(today: string, fiscalYearStartMonth: number): { start: string; end: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const fyYear = m >= fiscalYearStartMonth ? y : y - 1;
  return { start: iso(new Date(Date.UTC(fyYear, fiscalYearStartMonth - 1, 1))), end: iso(new Date(Date.UTC(fyYear + 1, fiscalYearStartMonth - 1, 0))) };
}

/**
 * W3-10: the caller creates the demo period's month partitions first, outside this transaction
 * (`ensurePartitions(prisma, ...demoPeriod(...))`); the call below is then a lock-free no-op.
 */

// ---- EX-3: campaign-level demo data -------------------------------------------------------------

/** A tiny deterministic hash (FNV-1a), so every "random" choice below is stable across runs. */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** A deterministic pseudo-random number in [0, 1), keyed by any stable string. */
function rand01(key: string): number {
  const h = hashStr(key);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}
function daysInMonthUTC(y: number, monthIdx0: number): number {
  return new Date(Date.UTC(y, monthIdx0 + 1, 0)).getUTCDate();
}
/** Every ISO date in [startIso, untilIso], inclusive. */
function allDays(startIso: string, untilIso: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${startIso}T00:00:00Z`);
  const last = new Date(`${untilIso}T00:00:00Z`);
  while (cursor <= last) {
    out.push(iso(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

const CAMPAIGN_ROLES = [
  { audience: "Prospecting", creative: "VideoA" },
  { audience: "Retargeting", creative: "StaticB" },
  { audience: "Prospecting", creative: "CarouselC" },
  { audience: "Broad", creative: "VideoD" },
] as const;

export interface DemoCampaign {
  code: string;
  label: string;
  weight: number;
}

/** 2–4 campaigns for one leaf budget, realistic names like "BR_Meta_Prospecting_Q4_VideoA" (plan §27, EX-3). `wsShort` keeps the (org-wide) campaign dimension's codes unique across demo workspaces. */
export function campaignsForLeaf(leaf: { id: string; tuple: Record<string, string> }, wsShort: string): DemoCampaign[] {
  const count = 2 + (hashStr(`count:${leaf.id}`) % 3); // 2..4
  const platformTitle = leaf.tuple["platform"] === "meta" ? "Meta" : "GoogleAds";
  const rawWeights = Array.from({ length: count }, (_, i) => 0.6 + rand01(`weight:${leaf.id}:${i}`));
  const total = rawWeights.reduce((s, w) => s + w, 0);
  return rawWeights.map((w, i) => {
    const role = CAMPAIGN_ROLES[i % CAMPAIGN_ROLES.length] as (typeof CAMPAIGN_ROLES)[number];
    const label = `${leaf.tuple["country"]}_${platformTitle}_${role.audience}_Q4_${role.creative}`;
    return { code: `${wsShort}_${label}`, label, weight: w / total };
  });
}

export interface CampaignLeafInput {
  id: string;
  tuple: Record<string, string>;
  amount: Decimal;
  /** Index among leaves, for the same deterministic pct the old monthly seed used. */
  index: number;
}

export interface CampaignFactsResult {
  spend: SpendFactInput[];
  kpi: KpiFactInput[];
  campaignsByLeaf: Map<string, DemoCampaign[]>;
}

/**
 * Daily spend_fact + kpi_fact (impressions, clicks, conversions, revenue) for every campaign of
 * every leaf, from `startIso` to `untilIso` (yesterday), deterministic. Per leaf per month the
 * target total is the same `85…105% of the monthly plan` the old monthly seed used, split across
 * that month's active campaigns (weighted) and its days (±20% daily jitter); a few days per
 * campaign are dropped entirely ("no data", a paused campaign — never a zero row). Exactly one
 * leaf (the first) has one campaign that only starts midway through the window. Because the
 * current (still open) month only has facts for its elapsed days, and no-data days are dropped
 * rather than redistributed, a leaf's total over the whole window is close to but a little under
 * its old monthly-seed total — by design (plan §27, EX-3 "Done when": documented tolerance).
 */
export function campaignFactsForLeaves(
  leaves: CampaignLeafInput[],
  wsShort: string,
  fyYear: number,
  fyStartMonth: number,
  startIso: string,
  untilIso: string,
  runId: string,
  reportingCurrency: string,
): CampaignFactsResult {
  const spend: SpendFactInput[] = [];
  const kpi: KpiFactInput[] = [];
  const campaignsByLeaf = new Map<string, DemoCampaign[]>();
  const days = allDays(startIso, untilIso);
  const midStartDay = days.length > 1 ? days[Math.floor(days.length / 2)] : undefined;
  const fyStartMonth0 = fyStartMonth - 1;

  leaves.forEach((leaf, leafPos) => {
    const campaigns = campaignsForLeaf(leaf, wsShort);
    campaignsByLeaf.set(leaf.id, campaigns);
    // Exactly one campaign in the whole dataset starts mid-period: the last campaign of the first leaf.
    const midStartIdx = leafPos === 0 && campaigns.length > 1 && midStartDay !== undefined ? campaigns.length - 1 : -1;

    for (const day of days) {
      const d = new Date(`${day}T00:00:00Z`);
      const y = d.getUTCFullYear();
      const monthIdx0 = d.getUTCMonth();
      const n = (y - fyYear) * 12 + (monthIdx0 - fyStartMonth0);
      const daysInMonth = daysInMonthUTC(y, monthIdx0);
      const pct = new Decimal(85 + ((leaf.index * 13 + n * 7) % 21)).div(100); // 85…105% of the monthly plan
      const monthlyAmount = leaf.amount.div(12).mul(pct);

      const active = campaigns.filter((_, i) => i !== midStartIdx || day >= (midStartDay as string));
      if (active.length === 0) continue;
      const activeWeight = active.reduce((s, c) => s + c.weight, 0);

      for (const c of active) {
        // A few deliberate no-data days per campaign (~1 in 60): the campaign was paused.
        if (hashStr(`paused:${leaf.id}:${c.code}:${day}`) % 61 === 0) continue;
        const campaignMonthlyShare = monthlyAmount.mul(c.weight / activeWeight);
        const perDayBase = campaignMonthlyShare.div(daysInMonth);
        const jitter = new Decimal(0.8).plus(new Decimal(rand01(`mult:${c.code}:${day}`)).mul(0.4)); // 0.8…1.2
        const amount = perDayBase.mul(jitter).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        if (amount.lte(0)) continue;

        const dimensionValues = { ...leaf.tuple, campaign: c.code };
        const hash = `demo:${runId}:${c.code}:${day}`;
        spend.push({ dimensionValues, periodDate: day, currency: reportingCurrency, amount: amount.toFixed(2), amountReporting: amount.toFixed(2), fxRateId: null, rowHash: hash });

        const cpaBase = new Decimal(15 + (hashStr(`cpa:${c.code}`) % 20));
        const cpa = cpaBase.mul(new Decimal(0.9).plus(new Decimal(rand01(`cpaday:${c.code}:${day}`)).mul(0.2)));
        const conversions = amount.div(cpa).floor();
        const cpmBase = new Decimal(4 + (hashStr(`cpm:${c.code}`) % 8));
        const impressions = amount.div(cpmBase).mul(1000).floor();
        const ctrBase = new Decimal(8 + (hashStr(`ctr:${c.code}`) % 20)).div(1000);
        const clicks = impressions.mul(ctrBase).floor();
        const aov = new Decimal(30 + (hashStr(`aov:${c.code}`) % 90));
        const revenue = conversions.mul(aov);

        kpi.push({ dimensionValues, periodDate: day, metric: "conversions", value: conversions.toFixed(0), attributionModel: null, rowHash: `${hash}:conversions` });
        kpi.push({ dimensionValues, periodDate: day, metric: "impressions", value: impressions.toFixed(0), attributionModel: null, rowHash: `${hash}:impressions` });
        kpi.push({ dimensionValues, periodDate: day, metric: "clicks", value: clicks.toFixed(0), attributionModel: null, rowHash: `${hash}:clicks` });
        kpi.push({ dimensionValues, periodDate: day, metric: "revenue", value: revenue.toFixed(2), attributionModel: null, rowHash: `${hash}:revenue` });
      }
    }
  });
  return { spend, kpi, campaignsByLeaf };
}

/** The org-wide `campaign` dimension (plan §8, defaults.registry.ts), created the first time any workspace of the org needs it. */
async function ensureCampaignDimension(tx: Tx, orgId: string, createdBy: string, newId: () => string): Promise<string> {
  const existing = await tx.dimension.findFirst({ where: { orgId, workspaceId: null, key: "campaign" }, select: { id: true } });
  if (existing) return existing.id;
  const spec = DEFAULT_DIMENSIONS.find((d) => d.key === "campaign");
  if (!spec) throw new DomainError("NOT_FOUND", "campaign is not in the registry defaults");
  try {
    const created = await tx.dimension.create({
      data: { id: newId(), orgId, workspaceId: null, key: spec.key, label: spec.label, dataType: spec.dataType, icon: spec.icon, allowedParents: [...spec.allowedParents], isRequiredForLeaf: spec.isRequiredForLeaf, sortOrder: spec.sortOrder, createdBy },
    });
    return created.id;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      const row = await tx.dimension.findFirst({ where: { orgId, workspaceId: null, key: "campaign" }, select: { id: true } });
      if (row) return row.id;
    }
    throw e;
  }
}

/** Idempotent: a campaign value already at this code keeps its id (ON CONFLICT (dimension_id, code)). */
async function ensureCampaignValues(tx: Tx, dimensionId: string, campaigns: DemoCampaign[], newId: () => string): Promise<void> {
  for (const c of campaigns) {
    await upsertDimensionValue(tx, { id: newId(), dimensionId, code: c.code, label: c.label, parentValueId: null, aliases: [], externalIds: {} });
  }
}

/** POST /experiments/:id/start's effect, written directly (the demo experiment is created already RUNNING). */
async function seedDemoExperiment(
  tx: Tx,
  ctx: { workspaceId: string; createdBy: string; today: string },
  leaf: CampaignLeafInput,
  campaigns: DemoCampaign[],
  newId: () => string,
): Promise<number> {
  if (campaigns.length < 2) return 0;
  const [test, control] = campaigns as [DemoCampaign, DemoCampaign];
  const end = new Date(`${ctx.today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  const filterFor = (code: string) => ({ logic: "and" as const, children: [{ field: { kind: "dimension" as const, key: "campaign" }, op: "eq" as const, value: code }] });
  await tx.experiment.create({
    data: {
      id: newId(),
      workspaceId: ctx.workspaceId,
      name: `${test.label} vs ${control.label}`,
      // EX-2 (ADR-086): a `fact` scope evaluates the filter on spend_fact/kpi_fact dimension_values
      // directly, independent of budgets — exactly campaign vs campaign, with real numbers from day one.
      hypothesis: `${test.label} converts at a lower CPA than ${control.label} within the same budget.`,
      kind: "CUSTOM",
      testFilter: filterFor(test.code),
      testScopeKind: "fact",
      controlFilter: filterFor(control.code),
      controlScopeKind: "fact",
      primaryMetric: "cpa",
      criterion: { comparator: "lte", vs: "control" },
      startDate: start,
      endDate: end,
      status: "RUNNING",
      ownerId: ctx.createdBy,
      demo: true,
    },
  });
  return 1;
}

export async function seedDemoData(
  tx: Tx,
  ctx: { workspaceId: string; orgId: string; createdBy: string; reportingCurrency: string; fiscalYearStartMonth: number; today: string },
  newId: () => string,
): Promise<DemoSummary> {
  const y = Number(ctx.today.slice(0, 4));
  const m = Number(ctx.today.slice(5, 7));
  const fyYear = m >= ctx.fiscalYearStartMonth ? y : y - 1;
  const start = new Date(Date.UTC(fyYear, ctx.fiscalYearStartMonth - 1, 1));
  const end = new Date(Date.UTC(fyYear + 1, ctx.fiscalYearStartMonth - 1, 0));
  const months = Array.from({ length: 12 }, (_, k) => new Date(Date.UTC(fyYear, ctx.fiscalYearStartMonth - 1 + k, 1)));
  const yesterday = iso(new Date(new Date(`${ctx.today}T00:00:00Z`).getTime() - 86_400_000));
  const until = yesterday < iso(start) ? iso(start) : yesterday;

  // Registry ids for the codes the plan uses (a workspace dimension shadows the org's).
  const keys = ["region", "country", "platform", "objective", "audience"];
  const dims = await tx.dimension.findMany({ where: { orgId: ctx.orgId, key: { in: keys }, OR: [{ workspaceId: null }, { workspaceId: ctx.workspaceId }] }, select: { id: true, key: true, workspaceId: true } });
  const dimOf = new Map<string, string>();
  for (const d of dims) if (!dimOf.has(d.key) || d.workspaceId !== null) dimOf.set(d.key, d.id);
  const values = await tx.dimensionValue.findMany({ where: { dimensionId: { in: [...dimOf.values()] } }, select: { id: true, dimensionId: true, code: true } });
  const valueOf = new Map(values.map((v) => [`${v.dimensionId}|${v.code}`, v.id]));
  const pairs = (tuple: Record<string, string>) =>
    Object.entries(tuple).flatMap(([k, code]) => {
      const dimensionId = dimOf.get(k);
      const valueId = dimensionId ? valueOf.get(`${dimensionId}|${code}`) : undefined;
      return dimensionId && valueId ? [{ dimensionId, valueId }] : [];
    });

  const envelopes: Array<{ id: string; parentId: string | null; name: string; tuple: Record<string, string>; amount: Decimal }> = [];
  let i = 0;
  for (const market of MARKETS) {
    const parentId = newId();
    const leaves = PLATFORMS.map((p) => ({ id: newId(), parentId, name: `${market.country} ${p.label} conversion prospecting`, tuple: { region: market.region, country: market.country, platform: p.code, ...LEAF }, amount: amountFor(i++) }));
    const cap = leaves.reduce((s, l) => s.plus(l.amount), new Decimal(0)).mul("1.1").toDecimalPlaces(0);
    envelopes.push({ id: parentId, parentId: null, name: `${market.label} (demo)`, tuple: { region: market.region, country: market.country }, amount: cap }, ...leaves);
  }
  // Only tuples the registry knows (a trimmed template may lack a value): an envelope needs every one.
  const usable = envelopes.filter((e) => pairs(e.tuple).length === Object.keys(e.tuple).length);
  const approvedAt = new Date();
  for (const e of usable) {
    const versionId = newId();
    await tx.envelope.create({
      data: {
        id: e.id,
        workspaceId: ctx.workspaceId,
        parentId: e.parentId && usable.some((p) => p.id === e.parentId) ? e.parentId : null,
        name: e.name,
        dimensionValues: e.tuple,
        startDate: start,
        endDate: end,
        currency: ctx.reportingCurrency,
        status: "APPROVED",
        createdBy: ctx.createdBy,
        demo: true,
        dims: { create: pairs(e.tuple) },
      },
    });
    const monthly = e.amount.div(12).toDecimalPlaces(2, Decimal.ROUND_DOWN);
    const phasing = months.map((mo, k) => ({ month: mo, amount: (k === 11 ? e.amount.minus(monthly.mul(11)) : monthly).toFixed(2) }));
    await tx.envelopeVersion.create({
      data: { id: versionId, envelopeId: e.id, versionNo: 1, amount: e.amount.toFixed(2), amountReporting: e.amount.toFixed(2), status: "APPROVED", rationale: "Demo budget", createdBy: ctx.createdBy, approvedAt, demo: true, phasing: { create: phasing } },
    });
    await tx.envelope.update({ where: { id: e.id }, data: { currentVersionId: versionId } });
  }

  // A CPA target on each market (its leaves inherit it).
  let targets = 0;
  for (const e of usable.filter((x) => x.parentId === null)) {
    const targetId = newId();
    const versionId = newId();
    await tx.target.create({ data: { id: targetId, workspaceId: ctx.workspaceId, scopeType: "envelope", envelopeId: e.id, metricKey: "cpa", startDate: start, endDate: end, ownerId: ctx.createdBy, demo: true } });
    await tx.targetVersion.create({ data: { id: versionId, targetId, versionNo: 1, value: "25", comparator: "lte", status: "APPROVED", createdBy: ctx.createdBy, approvedAt, demo: true } });
    await tx.target.update({ where: { id: targetId }, data: { currentVersionId: versionId } });
    targets += 1;
  }

  // EX-3: campaign registry + daily, campaign-level spend and KPI facts for every leaf.
  const runId = randomUUID();
  const load = { workspaceId: ctx.workspaceId, sourceSystem: "demo", sourceRunId: runId };
  const leaves = usable.filter((e) => e.parentId !== null);
  const wsShort = ctx.workspaceId.replace(/-/g, "").slice(0, 8);
  const campaignLeaves: CampaignLeafInput[] = leaves.map((l, index) => ({ id: l.id, tuple: l.tuple, amount: l.amount, index }));
  const { spend, kpi, campaignsByLeaf } = campaignFactsForLeaves(campaignLeaves, wsShort, fyYear, ctx.fiscalYearStartMonth, iso(start), until, runId, ctx.reportingCurrency);

  let campaignCount = 0;
  if (spend.length) {
    const campaignDimId = await ensureCampaignDimension(tx, ctx.orgId, ctx.createdBy, newId);
    for (const campaigns of campaignsByLeaf.values()) {
      await ensureCampaignValues(tx, campaignDimId, campaigns, newId);
      campaignCount += campaigns.length;
    }
    await ensurePartitions(tx, iso(start), iso(end));
    await upsertSpendFacts(tx, load, spend);
    await upsertKpiFacts(tx, load, kpi);
    await tx.$executeRaw`UPDATE spend_fact SET demo = true WHERE workspace_id = ${ctx.workspaceId}::uuid AND source_run_id = ${runId}::uuid`;
    await tx.$executeRaw`UPDATE kpi_fact SET demo = true WHERE workspace_id = ${ctx.workspaceId}::uuid AND source_run_id = ${runId}::uuid`;
    await matchRunFacts(tx, ctx.workspaceId, runId);
  }

  // One demo experiment: two campaigns of the first leaf that has at least two.
  let experiments = 0;
  const expLeaf = campaignLeaves.find((l) => (campaignsByLeaf.get(l.id)?.length ?? 0) >= 2);
  if (expLeaf) {
    experiments += await seedDemoExperiment(tx, ctx, expLeaf, campaignsByLeaf.get(expLeaf.id) as DemoCampaign[], newId);
  }

  return {
    envelopes: usable.length,
    leaves: leaves.length,
    facts: spend.length + kpi.length,
    targets,
    campaigns: campaignCount,
    experiments,
    budget: leaves.reduce((s, l) => s.plus(l.amount), new Decimal(0)).toFixed(2),
    envelopeIds: usable.map((e) => e.id),
  };
}

export interface ReseedCampaignsSummary {
  /** True when the workspace already had campaign-level demo facts; nothing was written. */
  alreadyPresent: boolean;
  campaigns: number;
  facts: number;
  supersededFacts: number;
  experiments: number;
}

/**
 * POST /workspaces/:ws/demo-data/campaigns (EX-3): adds campaign-level demo data to a workspace
 * that only has the older, leaf-level monthly demo facts (every workspace seeded before this
 * change, including the production Sandbox). Idempotent: if campaign-tagged demo facts already
 * exist, this is a no-op. Otherwise it generates the same campaign + daily facts seedDemoData now
 * writes for a brand-new workspace, then supersedes (never deletes, ADR-071) the old monthly demo
 * facts of the same leaves so totals do not double.
 */
export async function reseedCampaignDemoData(
  tx: Tx,
  ctx: { workspaceId: string; orgId: string; createdBy: string; today: string },
  newId: () => string,
): Promise<ReseedCampaignsSummary> {
  const already = await tx.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM spend_fact
    WHERE workspace_id = ${ctx.workspaceId}::uuid AND demo AND dimension_values ? 'campaign' AND superseded_at IS NULL`;
  if (Number(already[0]?.n ?? 0) > 0) {
    return { alreadyPresent: true, campaigns: 0, facts: 0, supersededFacts: 0, experiments: 0 };
  }

  const envelopes = await tx.envelope.findMany({ where: { workspaceId: ctx.workspaceId, demo: true, parentId: { not: null } }, select: { id: true, dimensionValues: true, currency: true, currentVersion: { select: { amount: true } } } });
  if (envelopes.length === 0) return { alreadyPresent: false, campaigns: 0, facts: 0, supersededFacts: 0, experiments: 0 };
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { reportingCurrency: true, fiscalYearStartMonth: true } });

  const y = Number(ctx.today.slice(0, 4));
  const m = Number(ctx.today.slice(5, 7));
  const fyYear = m >= ws.fiscalYearStartMonth ? y : y - 1;
  const start = new Date(Date.UTC(fyYear, ws.fiscalYearStartMonth - 1, 1));
  const yesterday = iso(new Date(new Date(`${ctx.today}T00:00:00Z`).getTime() - 86_400_000));
  const until = yesterday < iso(start) ? iso(start) : yesterday;

  const campaignLeaves: CampaignLeafInput[] = envelopes.map((e, index) => ({ id: e.id, tuple: e.dimensionValues as Record<string, string>, amount: new Decimal(e.currentVersion?.amount ?? "0"), index }));
  const wsShort = ctx.workspaceId.replace(/-/g, "").slice(0, 8);
  const runId = randomUUID();
  const { spend, kpi, campaignsByLeaf } = campaignFactsForLeaves(campaignLeaves, wsShort, fyYear, ws.fiscalYearStartMonth, iso(start), until, runId, ws.reportingCurrency);
  if (spend.length === 0) return { alreadyPresent: false, campaigns: 0, facts: 0, supersededFacts: 0, experiments: 0 };

  const campaignDimId = await ensureCampaignDimension(tx, ctx.orgId, ctx.createdBy, newId);
  let campaignCount = 0;
  for (const campaigns of campaignsByLeaf.values()) {
    await ensureCampaignValues(tx, campaignDimId, campaigns, newId);
    campaignCount += campaigns.length;
  }

  await ensurePartitions(tx, iso(start), iso(new Date(Date.UTC(fyYear + 1, ws.fiscalYearStartMonth - 1, 0))));
  const load = { workspaceId: ctx.workspaceId, sourceSystem: "demo", sourceRunId: runId };
  await upsertSpendFacts(tx, load, spend);
  await upsertKpiFacts(tx, load, kpi);
  await tx.$executeRaw`UPDATE spend_fact SET demo = true WHERE workspace_id = ${ctx.workspaceId}::uuid AND source_run_id = ${runId}::uuid`;
  await tx.$executeRaw`UPDATE kpi_fact SET demo = true WHERE workspace_id = ${ctx.workspaceId}::uuid AND source_run_id = ${runId}::uuid`;
  await matchRunFacts(tx, ctx.workspaceId, runId);

  // ADR-071 supersede, by hand (no ingest_run/source_id for the demo source): every live demo fact
  // of these leaves without a campaign (the old monthly seed) is superseded by this run, never deleted.
  const leafIds = envelopes.map((e) => e.id);
  let supersededFacts = 0;
  for (const table of ["spend_fact", "kpi_fact"] as const) {
    supersededFacts += await tx.$executeRawUnsafe(
      `UPDATE ${table} SET superseded_at = now(), superseded_by_run_id = $1::uuid
       WHERE workspace_id = $2::uuid AND demo AND source_run_id <> $1::uuid AND superseded_at IS NULL
         AND envelope_id = ANY($3::uuid[]) AND NOT (dimension_values ? 'campaign')`,
      runId,
      ctx.workspaceId,
      leafIds,
    );
  }

  let experiments = 0;
  const expLeaf = campaignLeaves.find((l) => (campaignsByLeaf.get(l.id)?.length ?? 0) >= 2);
  const existingDemoExperiment = await tx.experiment.findFirst({ where: { workspaceId: ctx.workspaceId, demo: true }, select: { id: true, testScopeKind: true, controlScopeKind: true } });
  if (existingDemoExperiment) {
    // Pre-EX-2 demo experiment: its campaign filter scoped nothing (envelope scope by default).
    // Switch it to EX-2's fact scope (ADR-086) so it shows real campaign-vs-campaign data.
    if (existingDemoExperiment.testScopeKind !== "fact" || existingDemoExperiment.controlScopeKind !== "fact") {
      await tx.experiment.update({ where: { id: existingDemoExperiment.id }, data: { testScopeKind: "fact", controlScopeKind: "fact" } });
      experiments += 1;
    }
  } else if (expLeaf) {
    experiments += await seedDemoExperiment(tx, ctx, expLeaf, campaignsByLeaf.get(expLeaf.id) as DemoCampaign[], newId);
  }

  return { alreadyPresent: false, campaigns: campaignCount, facts: spend.length + kpi.length, supersededFacts, experiments };
}

export interface PurgeSummary {
  envelopes: number;
  facts: number;
  /** I-3: real facts that had matched onto a demo envelope, detached (not deleted) so they re-match. */
  detachedFacts: number;
  targets: number;
  experiments: number;
  envelopeIds: string[];
}

/**
 * Deletes every demo row of the workspace in one statement group (spec §27, I-3). Only rows marked
 * `demo = true` are deleted: a real fact that `matchRunFacts` happened to land on a demo envelope
 * (same tuple, both live) is detached instead — `envelope_id` and `match_method` go back to NULL,
 * so it sits in the unmatched queue until the next load of that row (same `source_row_hash`) runs
 * `matchRunFacts` again and finds it a real envelope. `projection_fact` has no `demo` column (the
 * demo dataset never writes projections, spec §27): every row of it on a demo envelope is real and
 * is always detached, never deleted. A real target cannot be silently dropped this way — scopeType
 * is fixed to an envelope, there is no "unmatch" for it — so the whole purge refuses first. EX-3:
 * the demo experiment and its links go too; the `campaign` dimension's values are removed only when
 * no live (non-superseded) fact anywhere in the org still uses them — a campaign dimension is
 * org-wide, so another workspace's real data may share it.
 */
export async function purgeDemoData(tx: Tx, workspaceId: string): Promise<PurgeSummary> {
  const ids = (await tx.envelope.findMany({ where: { workspaceId, demo: true }, select: { id: true } })).map((e) => e.id);
  const demoExperimentIds = (await tx.experiment.findMany({ where: { workspaceId, demo: true }, select: { id: true } })).map((e) => e.id);
  if (ids.length === 0 && demoExperimentIds.length === 0) return { envelopes: 0, facts: 0, detachedFacts: 0, targets: 0, experiments: 0, envelopeIds: [] };

  const realTargets = (await tx.target.findMany({ where: { workspaceId, demo: false, envelopeId: { in: ids } }, select: { id: true } })).map((t) => t.id);
  if (realTargets.length > 0) {
    throw new DomainError("CONFLICT", "Real targets are attached to demo budgets; move or delete them first", { targetIds: realTargets });
  }

  // EX-3 campaign codes this workspace's demo facts used, so they can be dropped from the org-wide
  // registry once no live fact (anywhere in the org) still references them.
  const campaignCodes = ids.length
    ? (
        await tx.$queryRaw<Array<{ code: string }>>`
          SELECT DISTINCT dimension_values ->> 'campaign' AS code FROM spend_fact
          WHERE workspace_id = ${workspaceId}::uuid AND demo AND dimension_values ? 'campaign'
          UNION
          SELECT DISTINCT dimension_values ->> 'campaign' AS code FROM kpi_fact
          WHERE workspace_id = ${workspaceId}::uuid AND demo AND dimension_values ? 'campaign'`
      ).map((r) => r.code)
    : [];

  let facts = 0;
  let detachedFacts = 0;
  for (const table of ["spend_fact", "kpi_fact"] as const) {
    facts += await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE workspace_id = $1::uuid AND demo`, workspaceId);
    detachedFacts += await tx.$executeRawUnsafe(
      `UPDATE ${table} SET envelope_id = NULL, match_method = NULL WHERE workspace_id = $1::uuid AND NOT demo AND envelope_id = ANY($2::uuid[])`,
      workspaceId,
      ids,
    );
  }
  detachedFacts += await tx.$executeRawUnsafe(
    `UPDATE projection_fact SET envelope_id = NULL, match_method = NULL WHERE workspace_id = $1::uuid AND envelope_id = ANY($2::uuid[])`,
    workspaceId,
    ids,
  );

  // EX-3: the demo experiment (no FK from experiment_envelope in this schema version; link rows, if
  // any, reference these envelope ids and are cleaned up by the envelope delete's own cascading).
  const experiments = demoExperimentIds.length ? (await tx.experiment.deleteMany({ where: { id: { in: demoExperimentIds } } })).count : 0;

  const demoTargets = (await tx.target.findMany({ where: { workspaceId, demo: true }, select: { id: true } })).map((t) => t.id);
  await tx.target.updateMany({ where: { id: { in: demoTargets } }, data: { currentVersionId: null, draftVersionId: null } });
  await tx.targetVersion.deleteMany({ where: { targetId: { in: demoTargets } } });
  const targets = (await tx.target.deleteMany({ where: { id: { in: demoTargets } } })).count;
  await tx.$executeRaw`DELETE FROM rule_state WHERE envelope_id = ANY(${ids}::uuid[])`;
  await tx.alert.deleteMany({ where: { envelopeId: { in: ids } } });
  await tx.$executeRaw`DELETE FROM search_document WHERE workspace_id = ${workspaceId}::uuid AND entity_type = 'envelope' AND entity_id = ANY(${ids}::uuid[])`;
  await tx.envelope.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null, draftVersionId: null } });
  await tx.envelopeVersion.deleteMany({ where: { envelopeId: { in: ids } } });
  // Leaves before their parents (parent_id references envelope).
  await tx.envelope.updateMany({ where: { id: { in: ids } }, data: { parentId: null } });
  const envelopes = (await tx.envelope.deleteMany({ where: { id: { in: ids } } })).count;

  if (campaignCodes.length > 0) {
    const stillUsed = await tx.$queryRaw<Array<{ code: string }>>`
      SELECT DISTINCT dimension_values ->> 'campaign' AS code FROM spend_fact
      WHERE superseded_at IS NULL AND dimension_values ->> 'campaign' = ANY(${campaignCodes})
      UNION
      SELECT DISTINCT dimension_values ->> 'campaign' AS code FROM kpi_fact
      WHERE superseded_at IS NULL AND dimension_values ->> 'campaign' = ANY(${campaignCodes})`;
    const stillUsedSet = new Set(stillUsed.map((r) => r.code));
    const removable = campaignCodes.filter((c) => !stillUsedSet.has(c));
    if (removable.length > 0) {
      await tx.$executeRaw`DELETE FROM dimension_value dv USING dimension d
        WHERE dv.dimension_id = d.id AND d.key = 'campaign' AND d.org_id = (SELECT org_id FROM workspace WHERE id = ${workspaceId}::uuid)
          AND dv.code = ANY(${removable})`;
    }
  }

  return { envelopes, facts, detachedFacts, targets, experiments, envelopeIds: ids };
}
