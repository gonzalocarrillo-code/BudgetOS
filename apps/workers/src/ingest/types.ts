import type { SourceConfig } from "@budget/domain";

/** Connector contract from spec §14. One connector per data_source kind. */

export interface RawRow {
  [column: string]: string | number | null;
}

export interface NormalizedFact {
  kind: "spend" | "kpi" | "projection" | "target";
  dimensionValues: Record<string, string>;
  periodDate: string;
  currency?: string;
  amount?: string;
  metric?: string;
  value?: string;
  attributionModel?: string;
  formulaVersion?: string;
  horizonEnd?: string;
  /** ADR-071: the fact's natural key (row id or business key, never the measure); see normalize.naturalKey. */
  rowHash: string;
  /** The key comes from the source's row_id column (unique per row), not from the business key. */
  byRowId?: true;
  /** §24.3: the tuple came from an external id or a match key (the match confirms it). */
  matchHint?: "external_id" | "match_key";
  /** EX-5 (ADR-0090): the budget the row names (a `budget_ref` column): a budget id or a budget's match key. */
  budgetRef?: string;
}

/** The fields of a data_source row a connector reads. */
export interface DataSourceRef {
  id: string;
  workspaceId: string;
  kind: string;
  config: SourceConfig;
}

export interface Connector {
  kind: "snowflake" | "sheets" | "bigquery" | "csv" | "manual"; // 'manual' rows come from an approved ManualEntryBatch (§26), never from a stream
  /** Stream normalized rows. Never buffers the whole source. */
  read(source: DataSourceRef, secret: Record<string, string>, since?: Date): AsyncIterable<RawRow>;
}
