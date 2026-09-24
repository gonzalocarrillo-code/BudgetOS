import { auth as googleAuth, sheets } from "@googleapis/sheets";
import type { Connector, DataSourceRef, RawRow } from "../types.js";

/**
 * Google Sheets (spec §14): `spreadsheets.values.get` on the configured range, first row = header,
 * with the runtime service account added to the sheet as a viewer. One API call returns the range,
 * so rows are yielded from that response. Not called until credentials exist (ADR-011).
 */
export class SheetsConnector implements Connector {
  readonly kind = "sheets" as const;

  async *read(source: DataSourceRef): AsyncIterable<RawRow> {
    const c = source.config;
    if (c.kind !== "sheets") throw new Error(`sheets connector given a ${c.kind} source`);
    const auth = new googleAuth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
    const api = sheets({ version: "v4", auth });
    const res = await api.spreadsheets.values.get({ spreadsheetId: c.spreadsheetId, range: c.range, valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" });
    const [header, ...rows] = (res.data.values ?? []) as Array<Array<string | number | null>>;
    if (!header) return;
    for (const r of rows) {
      const row: RawRow = {};
      header.forEach((h, i) => {
        const v = r[i];
        row[String(h)] = v === undefined || v === "" ? null : v;
      });
      yield row;
    }
  }
}
