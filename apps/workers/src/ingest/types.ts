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
  rowHash: string;
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
