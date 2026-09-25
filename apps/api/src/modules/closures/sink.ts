import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigQuery } from "@google-cloud/bigquery";
import { DomainError, newId } from "@budget/domain";

/**
 * Where a closure's budget vs actual rows go (spec §15, ADR-018). Production writes BigQuery
 * `closures.budget_vs_actual_<workspace>_<period>[_r<N>]`; a table is never written twice. The
 * recording sink exists for tests only: it is not a second system of record.
 */

export interface ClosureRow {
  closure_id: string;
  workspace_id: string;
  period_key: string;
  period_start: string;
  period_end: string;
  template_id: string;
  template_name: string;
  /** `total`: the whole period. `month`: one calendar month of it (actual and projected only; ADR-018). */
  grain: "total" | "month";
  month: string | null;
  node_path: string;
  depth: number;
  envelope_id: string | null;
  currency: string;
  budget: string | null;
  actual: string | null;
  projected: string | null;
  remaining: string | null;
  pace_index: string | null;
  spend_to_date_pct: string | null;
  projected_close_pct: string | null;
  leaf_count: number;
  closed_at: string;
}

export interface ClosureSink {
  /** Creates `table` and writes every row; throws CONFLICT when the table already exists. */
  write(table: string, rows: ClosureRow[]): Promise<void>;
}

export const CLOSURE_SINK = Symbol("CLOSURE_SINK");
export const CLOSURE_DATASET = "closures";
/** Above this many rows the BigQuery sink uses a load job instead of streaming inserts. */
export const STREAMING_MAX_ROWS = 100_000;

const STRING = ["closure_id", "workspace_id", "period_key", "template_id", "template_name", "grain", "node_path", "envelope_id", "currency"];
const NUMERIC = ["budget", "actual", "projected", "remaining", "pace_index", "spend_to_date_pct", "projected_close_pct"];
export const CLOSURE_SCHEMA = {
  fields: [
    ...STRING.map((name) => ({ name, type: "STRING", mode: ["envelope_id"].includes(name) ? "NULLABLE" : "REQUIRED" })),
    { name: "period_start", type: "DATE", mode: "REQUIRED" },
    { name: "period_end", type: "DATE", mode: "REQUIRED" },
    { name: "month", type: "DATE", mode: "NULLABLE" },
    { name: "depth", type: "INT64", mode: "REQUIRED" },
    { name: "leaf_count", type: "INT64", mode: "REQUIRED" },
    ...NUMERIC.map((name) => ({ name, type: "BIGNUMERIC", mode: "NULLABLE" })),
    { name: "closed_at", type: "TIMESTAMP", mode: "REQUIRED" },
  ],
};

/** Streaming inserts (insertId per row for BigQuery's best-effort dedupe), or one load job above STREAMING_MAX_ROWS. */
export class BigQueryClosureSink implements ClosureSink {
  constructor(
    private readonly bq: BigQuery,
    private readonly datasetId = CLOSURE_DATASET,
  ) {}

  async write(table: string, rows: ClosureRow[]): Promise<void> {
    const dataset = this.bq.dataset(this.datasetId);
    const [exists] = await dataset.table(table).exists();
    if (exists) throw new DomainError("CONFLICT", `Closure table ${this.datasetId}.${table} already exists; it is never overwritten`, { table });
    const [created] = await dataset.createTable(table, { schema: CLOSURE_SCHEMA });
    if (rows.length > STREAMING_MAX_ROWS) {
      const file = join(tmpdir(), `closure-${newId()}.ndjson`);
      try {
        await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n"));
        await created.load(file, { sourceFormat: "NEWLINE_DELIMITED_JSON", writeDisposition: "WRITE_EMPTY" });
      } finally {
        await rm(file, { force: true });
      }
      return;
    }
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({ insertId: `${r.closure_id}:${r.template_id}:${r.grain}:${r.month ?? ""}:${r.node_path}`, json: r }));
      await created.insert(chunk, { raw: true });
    }
  }
}

/** Tests only (NODE_ENV=test): keeps the rows in memory and refuses a second write to a table. */
export class RecordingClosureSink implements ClosureSink {
  readonly tables = new Map<string, ClosureRow[]>();
  async write(table: string, rows: ClosureRow[]): Promise<void> {
    if (this.tables.has(table)) throw new DomainError("CONFLICT", `Closure table ${table} already exists; it is never overwritten`, { table });
    this.tables.set(table, rows);
  }
}

/** BigQuery when the process has a GCP project; the recording sink under tests; otherwise none (closing is 503). */
export function closureSinkFromEnv(env: NodeJS.ProcessEnv = process.env): ClosureSink | null {
  if (env["GOOGLE_CLOUD_PROJECT"]) return new BigQueryClosureSink(new BigQuery({ projectId: env["GOOGLE_CLOUD_PROJECT"] }), env["CLOSURE_DATASET"] ?? CLOSURE_DATASET);
  if (env["NODE_ENV"] === "test") return new RecordingClosureSink();
  return null;
}
