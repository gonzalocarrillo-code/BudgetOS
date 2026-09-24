import snowflake from "snowflake-sdk";
import type { Connector, DataSourceRef, RawRow } from "../types.js";

/**
 * Snowflake with key-pair auth (spec §14): `SELECT * FROM <view> WHERE UPDATED_AT > :since`,
 * streamed. `secret.privateKey` comes from Secret Manager. Not called until credentials exist (ADR-011).
 */
export class SnowflakeConnector implements Connector {
  readonly kind = "snowflake" as const;

  async *read(source: DataSourceRef, secret: Record<string, string>, since?: Date): AsyncIterable<RawRow> {
    const c = source.config;
    if (c.kind !== "snowflake") throw new Error(`snowflake connector given a ${c.kind} source`);
    const privateKey = secret["privateKey"];
    if (!privateKey) throw new Error("snowflake secret has no privateKey");
    const conn = snowflake.createConnection({
      account: c.account,
      username: c.username,
      authenticator: "SNOWFLAKE_JWT",
      privateKey,
      warehouse: c.warehouse,
      database: c.database,
      schema: c.schema,
    });
    await new Promise<void>((resolve, reject) => conn.connect((err) => (err ? reject(err) : resolve())));
    try {
      // The view name is a validated unquoted identifier (SourceConfig); `since` is a bind.
      const sqlText = since ? `SELECT * FROM ${c.view} WHERE UPDATED_AT > ?` : `SELECT * FROM ${c.view}`;
      const stream = conn.execute({ sqlText, binds: since ? [since.toISOString()] : [], streamResult: true }).streamRows();
      for await (const row of stream as AsyncIterable<Record<string, unknown>>) yield toRaw(row);
    } finally {
      await new Promise<void>((resolve) => conn.destroy(() => resolve()));
    }
  }
}

export function toRaw(row: Record<string, unknown>): RawRow {
  const out: RawRow = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v === null || v === undefined ? null : typeof v === "number" ? v : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  }
  return out;
}
