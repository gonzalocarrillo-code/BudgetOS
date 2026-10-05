import type { Tx } from "./sql.js";

/**
 * Fact retention (docs/DATA_PLAN.md D-002): Postgres keeps the last 13 months of facts; older months
 * live in the BigQuery replica only. These helpers read and delete one workspace's month. They run
 * inside that workspace's tenant session, so RLS keeps every statement to it.
 */
export const FACT_TABLES = [
  { table: "spend_fact", amount: "amount_reporting" },
  { table: "kpi_fact", amount: "value" },
  { table: "projection_fact", amount: "value_reporting" },
] as const;
export type FactTable = (typeof FACT_TABLES)[number]["table"];

export interface MonthTotals {
  table: FactTable;
  rows: number;
  /** Σ amount (spend, projections: reporting currency; KPIs: value), fixed to 2 dp; "0.00" when empty. */
  amount: string;
}

/** The first days of the months before `before` (yyyy-MM-01) that still have facts in Postgres, oldest first. */
export async function factMonthsBefore(tx: Tx, workspaceId: string, before: string): Promise<string[]> {
  const rows = await tx.$queryRawUnsafe<Array<{ m: string }>>(
    FACT_TABLES.map((f) => `SELECT DISTINCT date_trunc('month', period_date)::date::text AS m FROM ${f.table} WHERE workspace_id = $1::uuid AND period_date < $2::date`).join(" UNION ") + " ORDER BY 1",
    workspaceId,
    before,
  );
  return rows.map((r) => r.m);
}

/**
 * Row count and Σ amount per fact table for one month (yyyy-MM-01). `rows` counts every row, superseded
 * or not (all of them are deleted, so all must be in the replica); `amount` sums the live ones (what
 * reports read, ADR-071), so a supersession the replica has not caught up with holds the month.
 */
export async function factMonthTotals(tx: Tx, workspaceId: string, month: string): Promise<MonthTotals[]> {
  const out: MonthTotals[] = [];
  for (const f of FACT_TABLES) {
    const [row] = await tx.$queryRawUnsafe<Array<{ rows: bigint; amount: string }>>(
      `SELECT count(*) AS rows, coalesce(sum(${f.amount}) FILTER (WHERE superseded_at IS NULL), 0)::numeric(18,2)::text AS amount FROM ${f.table}
       WHERE workspace_id = $1::uuid AND period_date >= $2::date AND period_date < ($2::date + interval '1 month')`,
      workspaceId,
      month,
    );
    out.push({ table: f.table, rows: Number(row?.rows ?? 0), amount: row?.amount ?? "0.00" });
  }
  return out;
}

/** Deletes one month of facts (and its spend_month roll-up). Returns rows deleted per table. */
export async function deleteFactMonth(tx: Tx, workspaceId: string, month: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const range = `workspace_id = $1::uuid AND period_date >= $2::date AND period_date < ($2::date + interval '1 month')`;
  for (const f of FACT_TABLES) counts[f.table] = await tx.$executeRawUnsafe(`DELETE FROM ${f.table} WHERE ${range}`, workspaceId, month);
  counts["spend_month"] = await tx.$executeRawUnsafe(`DELETE FROM spend_month WHERE workspace_id = $1::uuid AND month = $2::date`, workspaceId, month);
  return counts;
}

/** The newest spend fact's date (yyyy-MM-dd), or null: how fresh the actuals are. */
export async function lastFactDate(tx: Tx, workspaceId: string): Promise<string | null> {
  const [row] = await tx.$queryRaw<Array<{ d: string | null }>>`SELECT max(period_date)::text AS d FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid AND superseded_at IS NULL`;
  return row?.d ?? null;
}
