import { SourceMapping } from "@budget/domain";
import { describe, expect, it } from "vitest";
import { RegistryIndex, normalize, parseDate, rowHash } from "./normalize.js";

const registry = new RegistryIndex(
  new Map([
    [
      "country",
      [
        { code: "BR", aliases: ["Brasil"], externalIds: ["meta:BR-001"], mergedInto: null, isActive: true },
        { code: "MX", aliases: [], externalIds: [], mergedInto: null, isActive: true },
        { code: "XB", aliases: [], externalIds: [], mergedInto: "BR", isActive: false },
        { code: "YU", aliases: [], externalIds: [], mergedInto: null, isActive: false },
      ],
    ],
    [
      "platform",
      [
        { code: "meta", aliases: [], externalIds: [], mergedInto: null, isActive: true },
        { code: "google_ads", aliases: [], externalIds: [], mergedInto: null, isActive: true },
      ],
    ],
  ]),
);

const mapping = SourceMapping.parse({
  kind: "spend+kpi",
  columns: {
    COUNTRY: { dimension: "country" },
    PLATFORM: { dimension: "platform", transform: "lower", valueMap: { "google ads": "google_ads" } },
    MONTH: { role: "period_date", format: "yyyy-MM" },
    SPEND: { role: "amount" },
    CCY: { role: "currency" },
    CONV: { role: "kpi", metric: "conversions", attributionModel: "7d_click" },
    REV: { role: "kpi", metric: "revenue" },
    NOTE: { role: "ignore" },
  },
});
const row = (over: Record<string, string | number | null> = {}) => ({ COUNTRY: "BR", PLATFORM: "Meta", MONTH: "2026-03", SPEND: "100.005", CCY: "usd", CONV: "4", REV: null, NOTE: "x", ...over });

describe("normalize", () => {
  it("maps a row to one spend fact and one KPI fact per filled KPI column", () => {
    const res = normalize(row(), mapping, registry, "src-1");
    if (!("facts" in res)) throw new Error(res.rejected);
    expect(res.facts.map((f) => f.kind)).toEqual(["spend", "kpi"]);
    expect(res.facts[0]).toMatchObject({ dimensionValues: { country: "BR", platform: "meta" }, periodDate: "2026-03-01", currency: "USD", amount: "100.01" });
    expect(res.facts[1]).toMatchObject({ metric: "conversions", value: "4.0000", attributionModel: "7d_click" });
    expect(res.facts[0]?.rowHash).not.toBe(res.facts[1]?.rowHash);
  });

  it("resolves aliases, external ids, value maps, case and merged values; refuses unknown and retired ones", () => {
    const dims = (over: Record<string, string>) => {
      const r = normalize(row(over), mapping, registry, "s");
      return "facts" in r ? r.facts[0]?.dimensionValues : r.rejected;
    };
    expect(dims({ COUNTRY: "Brasil" })).toEqual({ country: "BR", platform: "meta" });
    expect(dims({ COUNTRY: "meta:BR-001" })).toEqual({ country: "BR", platform: "meta" });
    expect(dims({ COUNTRY: "br" })).toEqual({ country: "BR", platform: "meta" });
    expect(dims({ COUNTRY: "XB" })).toEqual({ country: "BR", platform: "meta" });
    expect(dims({ PLATFORM: "Google Ads" })).toEqual({ country: "BR", platform: "google_ads" });
    expect(dims({ COUNTRY: "ZZ" })).toBe('unknown country "ZZ"');
    expect(dims({ COUNTRY: "YU" })).toBe('country "YU" is retired');
  });

  it("rejects bad dates, numbers and currencies with the reason", () => {
    const reason = (over: Record<string, string | null>) => {
      const r = normalize(row(over), mapping, registry, "s");
      return "rejected" in r ? r.rejected : "ok";
    };
    expect(reason({ MONTH: "2026-13" })).toBe('MONTH "2026-13" is not yyyy-MM');
    expect(reason({ MONTH: null })).toBe("missing MONTH");
    expect(reason({ SPEND: "1,000.00" })).toBe('SPEND "1,000.00" is not a number');
    expect(reason({ CCY: "dollars" })).toBe('CCY "dollars" is not a currency code');
    expect(reason({ CCY: null })).toBe("no currency for the amount");
    expect(reason({ SPEND: null, CONV: null })).toBe("no values in the row");
    expect(reason({ SPEND: null })).toBe("ok"); // KPI-only row of a spend+kpi source
  });

  it("hashes the row, not its column order", () => {
    expect(rowHash("s", { a: "1", b: "2" })).toBe(rowHash("s", { b: "2", a: "1" }));
    expect(rowHash("s", { a: "1" })).not.toBe(rowHash("t", { a: "1" }));
  });

  it("parses the four date formats and refuses impossible dates", () => {
    expect(parseDate("2026-02-28", "yyyy-MM-dd")).toBe("2026-02-28");
    expect(parseDate("2026-02-29", "yyyy-MM-dd")).toBeNull();
    expect(parseDate("2026-02-03T10:00:00Z", "yyyy-MM-dd")).toBe("2026-02-03");
    expect(parseDate("03/02/2026", "dd/MM/yyyy")).toBe("2026-02-03");
    expect(parseDate("02/03/2026", "MM/dd/yyyy")).toBe("2026-02-03");
    expect(parseDate("2026-2", "yyyy-MM")).toBeNull();
  });
});
