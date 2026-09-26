import { describe, expect, it } from "vitest";
import { guessDateFormat, guessMapping, mappingProblems, parseCsvSample } from "./mapping.js";

const dims = [
  { key: "country", label: "Country" },
  { key: "platform", label: "Platform" },
  { key: "objective", label: "Objective" },
];

describe("mapping wizard helpers (T-032)", () => {
  it("reads a CSV sample: quotes, doubled quotes, CRLF, blank lines, and stops at maxRows", () => {
    const csv = 'Date,Country,"Media, spend",Note\r\n2026-01-01,BR,10.5,"said ""hi"""\r\n\r\n2026-01-02,MX,3,\r\n2026-01-03,AR,4,x\r\n';
    expect(parseCsvSample(csv)).toEqual({ header: ["Date", "Country", "Media, spend", "Note"], rows: [["2026-01-01", "BR", "10.5", 'said "hi"'], ["2026-01-02", "MX", "3", ""], ["2026-01-03", "AR", "4", "x"]] });
    expect(parseCsvSample(csv, 1).rows).toHaveLength(1);
  });

  it("guesses date formats", () => {
    expect(guessDateFormat(["2026-01", "2026-02"])).toBe("yyyy-MM");
    expect(guessDateFormat(["31/01/2026"])).toBe("dd/MM/yyyy");
    expect(guessDateFormat(["01/31/2026"])).toBe("MM/dd/yyyy");
    expect(guessDateFormat(["2026-01-31"])).toBe("yyyy-MM-dd");
  });

  it("guesses a spend + KPI mapping by name that the domain schema accepts once it has a currency", () => {
    const sample = parseCsvSample("date,country,platform,spend,currency,conversions,campaign id\n2026-01-01,BR,meta,10,USD,3,123\n");
    const m = guessMapping(sample, dims);
    expect(m).toEqual({
      kind: "spend+kpi",
      columns: { date: { role: "period_date", format: "yyyy-MM-dd" }, country: { dimension: "country" }, platform: { dimension: "platform" }, spend: { role: "amount" }, currency: { role: "currency" }, conversions: { role: "kpi", metric: "conversions" }, "campaign id": { role: "ignore" } },
    });
    expect(mappingProblems(m)).toEqual([]);
    expect(mappingProblems({ ...m, columns: { ...m.columns, currency: { role: "ignore" } } })).toEqual(["The amount needs a currency, inline or from a currency column"]);
  });
});
