import { Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import type { Tx } from "./sql.js";

/**
 * EX-9 (ADR-0094): the one place a data-derived dimension's values come from (`dimension.values_source
 * = 'facts'`, e.g. `campaign`). A value is a distinct `dimension_values ->> key` on the workspace's
 * live (non-superseded) spend_fact and kpi_fact rows — never a registry row, never typed by hand.
 * Demo facts follow ADR-082 / T-5: they count only while the workspace has no real, live budget,
 * unless `includeDemo`. Every consumer that offers these values (registry page, filter bar, rule
 * forms, ⌘K suggestions, MCP) reads this function.
 */

export interface FactDimensionValuesInput {
  workspaceId: string;
  /** The dimension key, e.g. `campaign`. */
  key: string;
  /** Case-insensitive substring of the value (LIKE metacharacters are literal). */
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  includeDemo?: boolean | undefined;
}

export interface FactDimensionValueRow {
  code: string;
  /** Live spend in the reporting currency, Decimal string with 2 dp ("0.00" when only KPIs carry the value). */
  spend: string;
  currency: string;
  firstSeen: string;
  lastSeen: string;
  sourceSystems: string[];
}

export interface FactDimensionValuesPage {
  items: FactDimensionValueRow[];
  /** Values matching `q`, across every page. */
  total: number;
  limit: number;
  offset: number;
}

export const FACT_VALUES_DEFAULT_LIMIT = 50;
export const FACT_VALUES_MAX_LIMIT = 200;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** One page of a data-derived dimension's values, largest live spend first (then by value). */
export async function listFactDimensionValues(tx: Tx, input: FactDimensionValuesInput): Promise<FactDimensionValuesPage> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? FACT_VALUES_DEFAULT_LIMIT), 1), FACT_VALUES_MAX_LIMIT);
  const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
  const { workspaceId: ws, key } = input;
  const q = input.q?.trim() ?? "";
  const search = q === "" ? Prisma.empty : Prisma.sql` AND dimension_values ->> ${key} ILIKE ${`%${escapeLike(q)}%`} ESCAPE '\\'`;
  const demo = input.includeDemo === true ? Prisma.empty : Prisma.sql` AND (NOT demo OR (SELECT pure FROM demo_mode))`;
  // `->> key <> ''` (not `? key`): Postgres estimates it close to the truth, so the grouping below
  // hashes instead of sorting every fact row to disk (EXPLAIN on 50k + 50k facts: ~450 ms → ~70 ms).
  // The workspace's facts are found by the existing (workspace_id, period_date) WHERE superseded_at
  // IS NULL indexes; no campaign-specific index is needed (ADR-0094).
  const where = Prisma.sql`workspace_id = ${ws}::uuid AND superseded_at IS NULL AND (dimension_values ->> ${key}) <> ''${search}${demo}`;

  const grouped = Prisma.sql`
    demo_mode AS (SELECT NOT EXISTS (SELECT 1 FROM envelope r WHERE r.workspace_id = ${ws}::uuid AND NOT r.demo AND r.status <> 'ARCHIVED') AS pure),
    f AS (
      SELECT dimension_values ->> ${key} AS code, amount_reporting AS spend, period_date, source_system FROM spend_fact WHERE ${where}
      UNION ALL
      SELECT dimension_values ->> ${key} AS code, NULL::numeric AS spend, period_date, source_system FROM kpi_fact WHERE ${where}
    ),
    -- Two hash-friendly steps instead of one array_agg(DISTINCT …), which sorts every fact row.
    per_source AS (
      SELECT code, source_system, sum(spend) AS spend, min(period_date) AS first_seen, max(period_date) AS last_seen
      FROM f GROUP BY code, source_system
    ),
    g AS (
      SELECT code, coalesce(sum(spend), 0) AS spend, min(first_seen) AS first_seen, max(last_seen) AS last_seen,
             array_agg(source_system ORDER BY source_system) AS sources
      FROM per_source GROUP BY code
    )`;
  const rows = await tx.$queryRaw<Array<{ code: string; spend: string; first_seen: string; last_seen: string; sources: string[]; total: bigint; currency: string | null }>>`
    WITH ${grouped}
    SELECT code, spend::text AS spend, first_seen::text AS first_seen, last_seen::text AS last_seen, sources, count(*) OVER () AS total,
           (SELECT w.reporting_currency FROM workspace w WHERE w.id = ${ws}::uuid) AS currency
    FROM g ORDER BY g.spend DESC, code LIMIT ${limit} OFFSET ${offset}`;

  let total = Number(rows[0]?.total ?? 0);
  if (rows.length === 0 && offset > 0) {
    // Past the last page: the window count saw no row, so count on its own.
    const counted = await tx.$queryRaw<Array<{ n: bigint }>>`WITH ${grouped} SELECT count(*) AS n FROM g`;
    total = Number(counted[0]?.n ?? 0);
  }
  return {
    items: rows.map((r) => ({
      code: r.code,
      spend: new Decimal(r.spend).toFixed(2),
      currency: r.currency ?? "",
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      sourceSystems: r.sources.filter((s) => s !== null),
    })),
    total,
    limit,
    offset,
  };
}
