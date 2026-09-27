import { DomainError, FilterGroup, LIVE_LEAVES, ListExperimentsQuery, SuccessCriterion, criterionMet, type ExperimentReadout, type FilterGroupT, type MetricSet } from "@budget/domain";
import { plannerOptions, withTenant, type Tx } from "@budget/db";
import { compileTotals, sanitize } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import type { Experiment, ExperimentEnvelope, PrismaClient } from "@prisma/client";
import { clock } from "../../../common/clock.js";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { scopedQuery } from "../../query/queries/run-query.js";

/**
 * Experiments read side (spec §25.2): the list and one experiment with its read-out. Each side of
 * the read-out is the planner's totals over its scope for the experiment's window: the scope filter
 * OR the envelopes linked in that role, live leaves only, cut to the caller's read scope (as /query).
 * The primary metric is the planner's weighted KPI (CPA = Σspend / Σconversions), never an average.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const DAY = 86_400_000;
const money = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toFixed(2));
const decimal = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toDecimalPlaces(4).toString());

export function experimentView(x: Experiment & { envelopes?: ExperimentEnvelope[] }) {
  return {
    id: x.id,
    workspaceId: x.workspaceId,
    name: x.name,
    hypothesis: x.hypothesis,
    kind: x.kind,
    testFilter: FilterGroup.parse(x.testFilter),
    controlFilter: x.controlFilter === null ? null : FilterGroup.parse(x.controlFilter),
    primaryMetric: x.primaryMetric,
    criterion: SuccessCriterion.parse(x.criterion),
    startDate: iso(x.startDate),
    endDate: iso(x.endDate),
    status: x.status,
    ownerId: x.ownerId,
    decision: x.decision,
    decidedBy: x.decidedBy,
    decidedAt: x.decidedAt?.toISOString() ?? null,
    createdAt: x.createdAt.toISOString(),
    ...(x.envelopes ? { envelopes: x.envelopes.map((e) => ({ envelopeId: e.envelopeId, role: e.role })) } : {}),
  };
}

/** The scope of one side: its filter (when it has predicates) OR the envelopes linked in that role. */
export function sideFilter(experimentId: string, filter: FilterGroupT | null, role: "TEST" | "CONTROL"): FilterGroupT {
  const linked = { field: { kind: "attr" as const, key: "experiment" as const }, op: "eq" as const, value: `${experimentId}:${role}` };
  const either: FilterGroupT = { logic: "or", children: [...(filter && filter.children.length ? [filter] : []), linked] };
  return { logic: "and", children: [...LIVE_LEAVES, either] };
}

/** Days the experiment has run: 0 until started; counted to today, its end, or its decision. */
export function daysRunning(x: Pick<Experiment, "status" | "startDate" | "endDate" | "decidedAt">, today: string): number {
  if (x.status === "PLANNED") return 0;
  const stop = [today, iso(x.endDate), ...(x.decidedAt ? [iso(x.decidedAt)] : [])].sort()[0] as string;
  return Math.max(0, Math.round((Date.parse(`${stop}T00:00:00Z`) - Date.parse(`${iso(x.startDate)}T00:00:00Z`)) / DAY) + 1);
}

async function metricSet(tx: Tx, auth: AuthContext, x: Experiment, filter: FilterGroupT, today: string): Promise<MetricSet> {
  const period = { start: iso(x.startDate), end: iso(x.endDate) };
  const q = scopedQuery(auth, { workspaceId: x.workspaceId, filter, period: { kind: "range", ...period }, measures: ["budget", "actual"], targets: [x.primaryMetric], limit: 1 });
  const opts = await plannerOptions(tx, { orgId: auth.user.orgId, workspaceId: x.workspaceId }, [x.primaryMetric], period);
  const c = compileTotals(q, period, today, opts);
  const [row] = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(c.sql, ...c.values);
  return { budget: money(row?.["budget"]), actual: money(row?.["actual"]), metric: decimal(row?.[`kpi_${sanitize(x.primaryMetric)}`]), leafCount: Number(row?.["leaf_count"] ?? 0) };
}

export async function readout(tx: Tx, auth: AuthContext, x: Experiment, hasControlLinks: boolean, today: string): Promise<ExperimentReadout> {
  const criterion = SuccessCriterion.parse(x.criterion);
  const test = await metricSet(tx, auth, x, sideFilter(x.id, FilterGroup.parse(x.testFilter), "TEST"), today);
  const controlScope = x.controlFilter === null ? null : FilterGroup.parse(x.controlFilter);
  const control = controlScope || hasControlLinks ? await metricSet(tx, auth, x, sideFilter(x.id, controlScope, "CONTROL"), today) : null;
  const reference = criterion.vs === "absolute" ? (criterion.value ?? null) : (control?.metric ?? null);
  const days = daysRunning(x, today);
  const delta =
    test.metric !== null && reference !== null
      ? (() => {
          const abs = new Decimal(test.metric).minus(reference);
          return { abs: abs.toDecimalPlaces(4).toString(), pct: new Decimal(reference).isZero() ? null : abs.div(reference).toDecimalPlaces(4).toString() };
        })()
      : null;
  return { test, control, delta, criterionMet: criterionMet(criterion, test.metric, reference, days, (a, b) => new Decimal(a).comparedTo(b)), daysRunning: days };
}

/** GET /workspaces/:ws/experiments?status= — newest first. */
export async function listExperiments(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const q = parseInput(ListExperimentsQuery, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const statuses = q.status ? (q.status.split(",") as Experiment["status"][]) : null;
  return withTenant(prisma, auth.ctx, async (tx) => {
    const rows = await tx.experiment.findMany({ where: { workspaceId, ...(statuses ? { status: { in: statuses } } : {}) }, include: { envelopes: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    return rows.map(experimentView);
  });
}

/** GET /experiments/:id — the experiment, its linked envelopes and the read-out. */
export async function getExperiment(prisma: PrismaClient, auth: AuthContext, rawId: string, now: Date = clock.now()) {
  const id = parseId(rawId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const x = await tx.experiment.findUnique({ where: { id }, include: { envelopes: true } });
    if (x === null) throw new DomainError("NOT_FOUND", "Experiment not found");
    const names = new Map((await tx.envelope.findMany({ where: { id: { in: x.envelopes.map((e) => e.envelopeId) } }, select: { id: true, name: true, displayName: true } })).map((e) => [e.id, e.displayName ?? e.name]));
    return {
      experiment: { ...experimentView(x), envelopes: x.envelopes.map((e) => ({ envelopeId: e.envelopeId, role: e.role, name: names.get(e.envelopeId) ?? null })) },
      readout: await readout(tx, auth, x, x.envelopes.some((e) => e.role === "CONTROL"), iso(now)),
    };
  });
}
