import type { ObjectStore } from "../object-store.js";
import type { Connector } from "../types.js";
import { BigQueryConnector } from "./bigquery.js";
import { CsvConnector } from "./csv.js";
import { SheetsConnector } from "./sheets.js";
import { SnowflakeConnector } from "./snowflake.js";

export { BigQueryConnector, CsvConnector, SheetsConnector, SnowflakeConnector };

export function connectorFor(kind: string, store: ObjectStore): Connector {
  switch (kind) {
    case "csv":
      return new CsvConnector(store);
    case "snowflake":
      return new SnowflakeConnector();
    case "sheets":
      return new SheetsConnector();
    case "bigquery":
      return new BigQueryConnector();
    default:
      throw new Error(`no connector for source kind ${kind}`);
  }
}
