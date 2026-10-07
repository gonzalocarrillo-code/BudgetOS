import type { UnassignedReason } from "@budget/domain";
import { Decimal } from "decimal.js";
import type { Tx } from "./sql.js";

/**
 * EX-1 (ADR-0085): how much live spend landed on exactly one budget, how much on none, and how
 * much is ambiguous (more than one budget qualified), in the workspace's reporting currency.
 * Superseded facts are never read. matched + unmatched + ambiguous = Σ amount_reporting of the
 * period's live facts, by construction (every fact is in exactly one of the three).
 */

export interface CoverageAmountsRow {
  total: string;
  matched: string;
  unmatched: string;
  ambiguous: string;
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  ambiguousRows: number;
}

export interface MatchCoverage {
  from: string | null;
  to: string | null;
  currency: string;
  totals: CoverageAmountsRow;
  bySource: Array<CoverageAmountsRow & { sourceId: string | null; sourceName: string | null; sourceSystem: string }>;
  byCampaign: Array<CoverageAmountsRow & { campaign: string | null; label: string | null }>;
  open: Array<{ campaign: string | null; label: string | null; status: "unmatched" | "ambiguous"; reason: UnassignedReason | null; amount: string; rows: number; firstDate: string; lastDate: string; candidates: Array<{ id: string; name: string }> }>;
}

interface Agg {
  m: string;
  u: string;
  a: string;
  mr: bigint;
  ur: bigint;
  ar: bigint;
}

const SUMS = `
  coalesce(sum(a) FILTER (WHERE st = 'matched'), 0)::text AS m,
  coalesce(sum(a) FILTER (WHERE st = 'unmatched'), 0)::text AS u,
  coalesce(sum(a) FILTER (WHERE st = 'ambiguous'), 0)::text AS a,
  count(*) FILTER (WHERE st = 'matched') AS mr,
  count(*) FILTER (WHERE st = 'unmatched') AS ur,
  count(*) FILTER (WHERE st = 'ambiguous') AS ar`;

/** The live spend facts of the period, each with its state. $1 workspace, $2 from, $3 to. */
const FACTS = `
  WITH f AS (
    SELECT sf.amount_reporting AS a, sf.source_system, sf.source_run_id, sf.dimension_values ->> $4 AS campaign,
           sf.period_date, sf.match_candidates,
           CASE WHEN sf.envelope_id IS NOT NULL THEN 'matched' WHEN sf.match_status = 'ambiguous' THEN 'ambiguous' ELSE 'unmatched' END AS st,
           CASE WHEN sf.envelope_id IS NULL AND sf.match_status <> 'ambiguous' THEN sf.match_status END AS reason
    FROM spend_fact sf
    WHERE sf.workspace_id = $1::uuid AND sf.superseded_at IS NULL
      AND ($2::date IS NULL OR sf.period_date >= $2::date) AND ($3::date IS NULL OR sf.period_date <= $3::date)
  )`;

const amounts = (r: Agg): CoverageAmountsRow => {
  const total = new Decimal(r.m).plus(r.u).plus(r.a);
  return {
    total: total.toFixed(2),
    matched: new Decimal(r.m).toFixed(2),
    unmatched: new Decimal(r.u).toFixed(2),
    ambiguous: new Decimal(r.a).toFixed(2),
    totalRows: Number(r.mr + r.ur + r.ar),
    matchedRows: Number(r.mr),
    unmatchedRows: Number(r.ur),
    ambiguousRows: Number(r.ar),
  };
};

export async function matchCoverage(tx: Tx, workspaceId: string, args: { from?: string | undefined; to?: string | undefined; limit: number; campaignKey: string }): Promise<MatchCoverage> {
  const p = [workspaceId, args.from ?? null, args.to ?? null, args.campaignKey] as const;
  const [ws] = await tx.$queryRawUnsafe<Array<{ currency: string; org_id: string }>>(`SELECT reporting_currency AS currency, org_id::text FROM workspace WHERE id = $1::uuid`, workspaceId);
  const [tot] = await tx.$queryRawUnsafe<Agg[]>(`${FACTS} SELECT ${SUMS} FROM f`, ...p);
  const bySource = await tx.$queryRawUnsafe<Array<Agg & { source_id: string | null; source_name: string | null; source_system: string }>>(
    `${FACTS}
     SELECT r.source_id::text AS source_id, ds.name AS source_name, f.source_system, ${SUMS}
     FROM f LEFT JOIN ingest_run r ON r.id = f.source_run_id LEFT JOIN data_source ds ON ds.id = r.source_id
     GROUP BY r.source_id, ds.name, f.source_system
     ORDER BY sum(f.a) DESC, f.source_system, ds.name`,
    ...p,
  );
  // The campaign's label from the registry (org-wide or this workspace's `campaign` dimension).
  const label = `(SELECT dv.label FROM dimension d JOIN dimension_value dv ON dv.dimension_id = d.id
                  WHERE d.key = $4 AND d.org_id = $5::uuid AND (d.workspace_id IS NULL OR d.workspace_id = $1::uuid) AND dv.code = g.campaign
                  ORDER BY d.workspace_id NULLS LAST LIMIT 1)`;
  const byCampaign = await tx.$queryRawUnsafe<Array<Agg & { campaign: string | null; label: string | null }>>(
    `${FACTS}, g AS (SELECT campaign, ${SUMS}, sum(a) AS total FROM f GROUP BY campaign)
     SELECT g.campaign, ${label} AS label, g.m, g.u, g.a, g.mr, g.ur, g.ar FROM g
     ORDER BY g.total DESC, g.campaign NULLS LAST LIMIT $6`,
    ...p,
    ws?.org_id ?? workspaceId,
    args.limit,
  );
  const open = await tx.$queryRawUnsafe<Array<{ campaign: string | null; label: string | null; st: "unmatched" | "ambiguous"; reason: UnassignedReason | null; amount: string; rows: bigint; first: string; last: string; cands: string[] | null }>>(
    `${FACTS}, g AS (
       SELECT campaign, st, reason, sum(a) AS amount, count(*) AS rows, min(period_date) AS first, max(period_date) AS last,
              (SELECT array_agg(DISTINCT c::text ORDER BY c::text) FROM f f2, unnest(f2.match_candidates) c WHERE f2.st = 'ambiguous' AND f2.campaign IS NOT DISTINCT FROM f.campaign AND f.st = 'ambiguous') AS cands
       FROM f WHERE st <> 'matched' GROUP BY campaign, st, reason
     )
     SELECT g.campaign, ${label} AS label, g.st, g.reason, g.amount::text AS amount, g.rows, g.first::text AS first, g.last::text AS last, g.cands FROM g
     ORDER BY g.amount DESC, g.campaign NULLS LAST, g.st, g.reason NULLS FIRST LIMIT $6`,
    ...p,
    ws?.org_id ?? workspaceId,
    args.limit,
  );
  const candidateIds = [...new Set(open.flatMap((o) => o.cands ?? []))];
  const names = new Map(
    candidateIds.length === 0
      ? []
      : (await tx.$queryRawUnsafe<Array<{ id: string; name: string }>>(`SELECT id::text, coalesce(display_name, name) AS name FROM envelope WHERE id = ANY($1::uuid[])`, candidateIds)).map((e) => [e.id, e.name]),
  );
  return {
    from: args.from ?? null,
    to: args.to ?? null,
    currency: ws?.currency ?? "USD",
    totals: amounts(tot ?? { m: "0", u: "0", a: "0", mr: 0n, ur: 0n, ar: 0n }),
    bySource: bySource.map((r) => ({ sourceId: r.source_id, sourceName: r.source_name, sourceSystem: r.source_system, ...amounts(r) })),
    byCampaign: byCampaign.map((r) => ({ campaign: r.campaign, label: r.label, ...amounts(r) })),
    open: open.map((o) => ({
      campaign: o.campaign,
      label: o.label,
      status: o.st,
      reason: o.reason,
      amount: new Decimal(o.amount).toFixed(2),
      rows: Number(o.rows),
      firstDate: o.first,
      lastDate: o.last,
      candidates: (o.cands ?? []).map((id) => ({ id, name: names.get(id) ?? id })),
    })),
  };
}
