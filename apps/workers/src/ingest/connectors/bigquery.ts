import { BigQuery } from "@google-cloud/bigquery";
import { toRaw } from "./snowflake.js";
import type { Connector, DataSourceRef, RawRow } from "../types.js";

/** BigQuery `createQueryStream` (spec §14). Not called until credentials exist (ADR-011). */
export class BigQueryConnector implements Connector {
  readonly kind = "bigquery" as const;

  async *read(source: DataSourceRef, _secret: Record<string, string>, since?: Date): AsyncIterable<RawRow> {
    const c = source.config;
    if (c.kind !== "bigquery") throw new Error(`bigquery connector given a ${c.kind} source`);
    const bq = new BigQuery({ projectId: c.projectId });
    // Dataset, table and column are validated identifiers (SourceConfig); `since` is a parameter.
    const table = `\`${c.projectId}.${c.dataset}.${c.table}\``;
    const query = since && c.updatedAtColumn ? `SELECT * FROM ${table} WHERE ${c.updatedAtColumn} > @since` : `SELECT * FROM ${table}`;
    const stream = bq.createQueryStream({ query, params: since && c.updatedAtColumn ? { since: since.toISOString() } : {} });
    for await (const row of stream as AsyncIterable<Record<string, unknown>>) {
      const flat: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) flat[k] = v !== null && typeof v === "object" && "value" in v ? (v as { value: unknown }).value : v;
      yield toRaw(flat);
    }
  }
}
