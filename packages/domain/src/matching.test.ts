import { describe, expect, it } from "vitest";
import { CreateNamingConventionInput, MatchRulesResponse, OpenCampaign, parseCampaignName } from "./matching.js";
import { SourceMapping } from "./sources.js";

/** EX-5 (ADR-0090): naming conventions read campaign names into dimension values; a source column can name the budget. */

const convention = {
  delimiter: "_",
  tokens: [
    { dimension: "country", aliases: {} },
    { dimension: "platform", aliases: { FB: "meta", IG: "meta" } },
    { dimension: "objective", aliases: {} },
    { dimension: null, aliases: {} },
    { dimension: null, aliases: {} },
  ],
};
const registry: Record<string, string[]> = { country: ["BR", "MX"], platform: ["meta", "google"], objective: ["prospecting", "retargeting"] };
const resolve = (d: string, v: string) => registry[d]?.find((c) => c.toLowerCase() === v.toLowerCase()) ?? null;

describe("parseCampaignName", () => {
  it("reads each position into its dimension, through the registry (case-insensitive)", () => {
    expect(parseCampaignName(convention, "BR_Meta_Prospecting_Q4_VideoA", resolve)).toEqual({ ok: true, dimensionValues: { country: "BR", platform: "meta", objective: "prospecting" } });
  });

  it("applies a position's aliases before the registry, case-insensitively", () => {
    expect(parseCampaignName(convention, "mx_fb_retargeting_Q1_x", resolve)).toEqual({ ok: true, dimensionValues: { country: "MX", platform: "meta", objective: "retargeting" } });
    expect(parseCampaignName(convention, "MX_ig_Retargeting_Q1_x", resolve)).toMatchObject({ ok: true, dimensionValues: { platform: "meta" } });
  });

  it("a name with the wrong number of parts, an empty part or an unknown value does not fit", () => {
    expect(parseCampaignName(convention, "BR_Meta_Prospecting", resolve)).toEqual({ ok: false, problem: { kind: "parts", expected: 5, found: 3 } });
    expect(parseCampaignName(convention, "BR__Prospecting_Q4_x", resolve)).toEqual({ ok: false, problem: { kind: "empty", position: 2 } });
    expect(parseCampaignName(convention, "BR_TikTok_Prospecting_Q4_x", resolve)).toEqual({ ok: false, problem: { kind: "unknown_value", position: 2, dimension: "platform", value: "TikTok" } });
    expect(parseCampaignName(convention, "Spring sale Brazil", resolve)).toMatchObject({ ok: false, problem: { kind: "parts" } });
  });

  it("without a registry the raw part (after aliases) is the value", () => {
    expect(parseCampaignName({ delimiter: "-", tokens: [{ dimension: "country" }, { dimension: "platform", aliases: { fb: "meta" } }] }, "AR-FB")).toEqual({ ok: true, dimensionValues: { country: "AR", platform: "meta" } });
  });
});

describe("CreateNamingConventionInput", () => {
  it("accepts the example convention", () => {
    expect(CreateNamingConventionInput.safeParse(convention).success).toBe(true);
  });
  it("needs at least one dimension, each from one position, never campaign, and no aliases on ignored positions", () => {
    expect(CreateNamingConventionInput.safeParse({ delimiter: "_", tokens: [{ dimension: null }, { dimension: null }] }).success).toBe(false);
    expect(CreateNamingConventionInput.safeParse({ delimiter: "_", tokens: [{ dimension: "country" }, { dimension: "country" }] }).success).toBe(false);
    expect(CreateNamingConventionInput.safeParse({ delimiter: "_", tokens: [{ dimension: "campaign" }] }).success).toBe(false);
    expect(CreateNamingConventionInput.safeParse({ delimiter: "_", tokens: [{ dimension: "country" }, { dimension: null, aliases: { a: "b" } }] }).success).toBe(false);
    expect(CreateNamingConventionInput.safeParse({ delimiter: "~", tokens: [{ dimension: "country" }] }).success).toBe(false);
  });
});

describe("budget_ref column role", () => {
  it("a source may map one budget_ref column, which is enough identity without dimension columns", () => {
    const base = { kind: "spend" as const, columns: { date: { role: "period_date" }, spend: { role: "amount", currency: "USD" } } };
    expect(SourceMapping.safeParse({ ...base, columns: { ...base.columns, budget: { role: "budget_ref" } } }).success).toBe(true);
    expect(SourceMapping.safeParse(base).success).toBe(false);
    expect(SourceMapping.safeParse({ ...base, columns: { ...base.columns, a: { role: "budget_ref" }, b: { role: "budget_ref" } } }).success).toBe(false);
  });
});

describe("responses", () => {
  it("rule lists and open campaigns from before EX-5 still parse (new fields default)", () => {
    expect(MatchRulesResponse.parse({ rules: [] })).toEqual({ rules: [], conventions: [], references: [] });
    expect(OpenCampaign.parse({ campaign: "c", label: null, status: "unmatched", amount: "1.00", rows: 1, firstDate: "2026-01-01", lastDate: "2026-01-01", candidates: [] }).reason).toBeNull();
  });
});
