import { describe, expect, it } from "vitest";
import { compileParsePattern, formatPeriod, renderTemplate, type NamingTemplateT } from "./naming.js";

const dims = { country: { code: "BR", label: "Brazil" }, platform: { code: "google_ads", label: "Google Ads" }, objective: { code: "non_brand", label: "Não marca" } };
const period = { start: "2026-10-01", end: "2026-12-31", fiscalLabel: "FY2026 Q4" };
const t = (over: Partial<NamingTemplateT>): NamingTemplateT => ({ kind: "display", chips: [], casing: "original", whitespace: "keep", stripAccents: false, ...over });

describe("naming templates (spec §24.2)", () => {
  it("display renders labels, match_key renders codes, with separators, text and the period", () => {
    const chips: NamingTemplateT["chips"] = [
      { type: "dimension", key: "country" },
      { type: "separator", value: " " },
      { type: "separator", value: "·" },
      { type: "separator", value: " " },
      { type: "dimension", key: "platform" },
      { type: "separator", value: "_" },
      { type: "text", value: "Q" },
      { type: "period", format: "yyyy-QQ" },
    ];
    expect(renderTemplate(t({ chips }), { dims, period })).toBe("Brazil · Google Ads_Q2026-Q4");
    expect(renderTemplate(t({ kind: "match_key", chips, casing: "lower", whitespace: "remove" }), { dims, period })).toBe("br·google_ads_q2026-q4");
  });

  it("strips accents, changes case and whitespace; a missing dimension renders empty", () => {
    const chips: NamingTemplateT["chips"] = [{ type: "dimension", key: "objective" }, { type: "separator", value: "-" }, { type: "dimension", key: "audience" }];
    expect(renderTemplate(t({ chips, stripAccents: true, casing: "upper", whitespace: "underscore" }), { dims })).toBe("NAO_MARCA-");
  });

  it("period formats and parse patterns", () => {
    expect(["yyyy", "yyyy-QQ", "yyyy-MM", "MMM yyyy", "fiscal"].map((f) => formatPeriod(period, f as "yyyy"))).toEqual(["2026", "2026-Q4", "2026-10", "Oct 2026", "FY2026 Q4"]);
    expect(compileParsePattern("^(?<country>[A-Z]{2})_(?<platform>[a-z_]+)")?.exec("BR_meta_awareness")?.groups).toEqual({ country: "BR", platform: "meta_awareness" });
    expect(compileParsePattern("^[A-Z]{2}_")).toBeNull(); // no named group
    expect(compileParsePattern("(?<country>[")).toBeNull(); // not a regex
  });
});
