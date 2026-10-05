import { randomUUID } from "node:crypto";
import { DomainError } from "@budget/domain";
import { Decimal } from "decimal.js";
import { ensurePartitions, matchRunFacts, upsertKpiFacts, upsertSpendFacts } from "./facts.js";
import type { Tx } from "./sql.js";

/**
 * The demo dataset of a new workspace (spec §27): a small version of the golden plan — three
 * markets (BR, MX, US) under their regions, two platforms each, conversion / prospecting leaves —
 * with approved budgets phased by month, a CPA target per market, and spend and conversions for
 * every month of the fiscal year up to today. Every row it writes has `demo = true`; the facts
 * carry `source_system = 'demo'`. `purgeDemoData` deletes exactly those rows in one transaction.
 * The caller writes the audit_event and the outbox row.
 */

export interface DemoSummary {
  envelopes: number;
  leaves: number;
  facts: number;
  targets: number;
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

  // Spend and conversions per leaf for every month that has ended (and the current one to today).
  const runId = randomUUID();
  const load = { workspaceId: ctx.workspaceId, sourceSystem: "demo", sourceRunId: runId };
  const spend = [];
  const kpis = [];
  const leaves = usable.filter((e) => e.parentId !== null);
  for (const [k, leaf] of leaves.entries()) {
    for (const [n, mo] of months.entries()) {
      const date = iso(mo);
      if (date > ctx.today) break;
      const pct = new Decimal(85 + ((k * 13 + n * 7) % 21)).div(100); // 85 … 105 % of the monthly plan
      const amount = leaf.amount.div(12).mul(pct).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const cpa = new Decimal(18 + ((k * 5 + n * 3) % 14));
      const hash = `demo:${runId}:${leaf.id}:${date}`;
      spend.push({ dimensionValues: leaf.tuple, periodDate: date, currency: ctx.reportingCurrency, amount: amount.toFixed(2), amountReporting: amount.toFixed(2), fxRateId: null, rowHash: hash });
      kpis.push({ dimensionValues: leaf.tuple, periodDate: date, metric: "conversions", value: amount.div(cpa).floor().toFixed(0), attributionModel: null, rowHash: `${hash}:conversions` });
    }
  }
  if (spend.length) {
    await ensurePartitions(tx, iso(start), iso(end));
    await upsertSpendFacts(tx, load, spend);
    await upsertKpiFacts(tx, load, kpis);
    await tx.$executeRaw`UPDATE spend_fact SET demo = true WHERE workspace_id = ${ctx.workspaceId}::uuid AND source_run_id = ${runId}::uuid`;
    await tx.$executeRaw`UPDATE kpi_fact SET demo = true WHERE workspace_id = ${ctx.workspaceId}::uuid AND source_run_id = ${runId}::uuid`;
    await matchRunFacts(tx, ctx.workspaceId, runId);
  }
  return {
    envelopes: usable.length,
    leaves: leaves.length,
    facts: spend.length + kpis.length,
    targets,
    budget: leaves.reduce((s, l) => s.plus(l.amount), new Decimal(0)).toFixed(2),
    envelopeIds: usable.map((e) => e.id),
  };
}

export interface PurgeSummary {
  envelopes: number;
  facts: number;
  /** I-3: real facts that had matched onto a demo envelope, detached (not deleted) so they re-match. */
  detachedFacts: number;
  targets: number;
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
 * is fixed to an envelope, there is no "unmatch" for it — so the whole purge refuses first.
 */
export async function purgeDemoData(tx: Tx, workspaceId: string): Promise<PurgeSummary> {
  const ids = (await tx.envelope.findMany({ where: { workspaceId, demo: true }, select: { id: true } })).map((e) => e.id);
  if (ids.length === 0) return { envelopes: 0, facts: 0, detachedFacts: 0, targets: 0, envelopeIds: [] };

  const realTargets = (await tx.target.findMany({ where: { workspaceId, demo: false, envelopeId: { in: ids } }, select: { id: true } })).map((t) => t.id);
  if (realTargets.length > 0) {
    throw new DomainError("CONFLICT", "Real targets are attached to demo budgets; move or delete them first", { targetIds: realTargets });
  }

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
  return { envelopes, facts, detachedFacts, targets, envelopeIds: ids };
}
