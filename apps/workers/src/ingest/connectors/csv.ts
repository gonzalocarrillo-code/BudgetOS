import { parse } from "csv-parse";
import type { ObjectStore } from "../object-store.js";
import type { Connector, DataSourceRef, RawRow } from "../types.js";

/** CSV from the GCS upload URI (spec §14), streamed with csv-parse; the header row names the columns. */
export class CsvConnector implements Connector {
  readonly kind = "csv" as const;
  constructor(private readonly store: ObjectStore) {}

  async *read(source: DataSourceRef): AsyncIterable<RawRow> {
    if (source.config.kind !== "csv") throw new Error(`csv connector given a ${source.config.kind} source`);
    const parser = this.store.read(source.config.uri).pipe(parse({ columns: true, bom: true, skip_empty_lines: true, trim: true, relax_column_count: true }));
    for await (const record of parser as AsyncIterable<Record<string, string>>) {
      const row: RawRow = {};
      for (const [k, v] of Object.entries(record)) row[k] = v === "" ? null : v;
      yield row;
    }
  }
}
