import { describe, expect, it } from "vitest";
import { analyzeCampaignNames, dictionaryKindFor, explainCampaignName, lookupDictionary, makeTokenResolver, normalizeToken } from "./naming-dictionaries.js";

/**
 * EX-6 (ADR-0091): built-in dictionaries read campaign-name tokens (countries, languages, regions,
 * platforms, objectives, audiences, devices, months, quarters, years) without anyone typing lists;
 * a token resolves workspace alias > registry value > dictionary > unresolved; "Analyze names"
 * finds the delimiter and which dictionary each position follows.
 */

const code = (kind: Parameters<typeof lookupDictionary>[0], token: string) => lookupDictionary(kind, token)?.code ?? null;

describe("dictionaries", () => {
  it("normalizes case, accents and punctuation", () => {
    expect(normalizeToken("Español")).toBe("espanol");
    expect(normalizeToken(" Non-Brand ")).toBe("nonbrand");
    expect(normalizeToken("CÔTE D'IVOIRE")).toBe("cotedivoire");
  });

  it("countries: ISO alpha-2, alpha-3, English / Spanish / Portuguese names, common abbreviations", () => {
    expect(code("country", "UK")).toBe("GB");
    expect(code("country", "gbr")).toBe("GB");
    expect(code("country", "Brasil")).toBe("BR");
    expect(code("country", "brazil")).toBe("BR");
    expect(code("country", "BRA")).toBe("BR");
    expect(code("country", "Alemania")).toBe("DE");
    expect(code("country", "Alemanha")).toBe("DE");
    expect(code("country", "méxico")).toBe("MX");
    expect(code("country", "USA")).toBe("US");
    expect(code("country", "EEUU")).toBe("US");
    expect(code("country", "España")).toBe("ES");
    expect(code("country", "Narnia")).toBeNull();
  });

  it("languages: ISO 639-1 codes, three-letter codes, English / native / Spanish / Portuguese names", () => {
    expect(code("language", "Español")).toBe("es");
    expect(code("language", "ESP")).toBe("es");
    expect(code("language", "spanish")).toBe("es");
    expect(code("language", "ES")).toBe("es");
    expect(code("language", "Português")).toBe("pt");
    expect(code("language", "ENG")).toBe("en");
    expect(code("language", "Inglés")).toBe("en");
    expect(code("language", "deutsch")).toBe("de");
  });

  it("regions, platforms, objectives, audiences, devices", () => {
    expect(code("region", "LatAm")).toBe("LATAM");
    expect(code("region", "NA")).toBe("AMER");
    expect(code("region", "Europe")).toBe("EU");
    expect(code("platform", "FB")).toBe("meta");
    expect(code("platform", "Instagram")).toBe("meta");
    expect(code("platform", "GoogleAds")).toBe("google_ads");
    expect(code("platform", "AdWords")).toBe("google_ads");
    expect(code("platform", "YT")).toBe("google_ads");
    expect(code("platform", "DV360")).toBe("dv360");
    expect(code("platform", "TT")).toBe("tiktok");
    expect(code("platform", "Twitter")).toBe("x");
    expect(code("platform", "LI")).toBe("linkedin");
    expect(code("objective", "Branding")).toBe("brand");
    expect(code("objective", "Conversión")).toBe("conversion");
    expect(code("audience", "Remarketing")).toBe("retargeting");
    expect(code("audience", "RTG")).toBe("retargeting");
    expect(code("device", "Mobile")).toBe("mobile");
    expect(code("month", "Enero")).toBe("01");
    expect(code("month", "dez")).toBe("12");
    expect(code("quarter", "Q4")).toBe("Q4");
    expect(code("year", "FY25")).toBe("2025");
  });

  it("a dimension of a known kind gets its dictionary from its key", () => {
    expect(dictionaryKindFor("country")).toBe("country");
    expect(dictionaryKindFor("market")).toBe("country");
    expect(dictionaryKindFor("language")).toBe("language");
    expect(dictionaryKindFor("platform")).toBe("platform");
    expect(dictionaryKindFor("funnel_stage")).toBe("funnel_stage");
    expect(dictionaryKindFor("client")).toBeNull();
  });
});

describe("resolution order: workspace alias > registry > dictionary > unresolved", () => {
  const resolve = makeTokenResolver({
    country: [{ code: "UK", label: "United Kingdom", aliases: [] }, { code: "BR", label: "Brazil", aliases: [] }],
    platform: [{ code: "meta", label: "Meta", aliases: [] }, { code: "fbx", label: "FB Experimental", aliases: ["FB"] }],
    client: [{ code: "acme", label: "Acme Inc", aliases: [] }],
  });
  const convention = { delimiter: "_", tokens: [{ dimension: "country", aliases: {} }, { dimension: "platform", aliases: { Face: "meta" } }, { dimension: "client", aliases: {} }] };

  it("the registry (code, label, value alias) wins over the dictionary", () => {
    expect(resolve("platform", "FB")).toEqual({ code: "fbx", source: "registry", known: true });
    expect(resolve("country", "brazil")).toEqual({ code: "BR", source: "registry", known: true });
  });

  it("the dictionary lands on the registry's own value when it has one, else on the canonical code", () => {
    expect(resolve("country", "GB")).toEqual({ code: "UK", source: "dictionary", known: true });
    expect(resolve("country", "Alemania")).toEqual({ code: "DE", source: "dictionary", known: false, label: "Germany" });
    expect(resolve("platform", "TikTok")).toEqual({ code: "tiktok", source: "dictionary", known: false, label: "TikTok" });
    expect(resolve("client", "globex")).toBeNull();
  });

  it("a workspace alias overrides both; every part is explained, unresolved ones too", () => {
    expect(explainCampaignName(convention, "Brasil_Face_Globex", resolve)).toEqual({
      dimensionValues: null,
      problem: { kind: "unknown_value", position: 3, dimension: "client", value: "Globex" },
      parts: [
        { position: 1, raw: "Brasil", dimension: "country", code: "BR", source: "dictionary" },
        { position: 2, raw: "Face", dimension: "platform", code: "meta", source: "alias" },
        { position: 3, raw: "Globex", dimension: "client", code: null, source: null },
      ],
    });
    expect(explainCampaignName(convention, "UK_FB_acme", resolve)).toMatchObject({ dimensionValues: { country: "UK", platform: "fbx", client: "acme" }, problem: null });
    expect(explainCampaignName(convention, "UK_FB", resolve)).toEqual({ dimensionValues: null, problem: { kind: "parts", expected: 3, found: 2 }, parts: [] });
  });
});

describe("analyzeCampaignNames", () => {
  // EX-3's demo campaign names (packages/db/src/demo.ts campaignsForLeaf), plus a few stragglers.
  const demo = ["BR", "MX", "US"].flatMap((c) =>
    ["Meta", "GoogleAds"].flatMap((p) => [`${c}_${p}_Prospecting_Q4_VideoA`, `${c}_${p}_Retargeting_Q4_StaticB`, `${c}_${p}_Prospecting_Q4_CarouselC`, `${c}_${p}_Broad_Q4_VideoD`]),
  );
  const names = [...demo, "Brand awareness always-on", "AR_Meta_Prospecting_Q1_VideoA"];
  const dims = ["region", "country", "platform", "objective", "audience", "creative_format", "campaign"].map((key) => ({ key }));

  it("detects the delimiter and the dictionary each position follows, and proposes a convention", () => {
    const a = analyzeCampaignNames(names, dims);
    expect(a.delimiter).toBe("_");
    expect(a.partCount).toBe(5);
    expect(a.total).toBe(names.length);
    expect(a.fitting).toBe(names.length - 1);
    const [p1, p2, p3, p4, p5] = a.positions;
    expect(p1).toMatchObject({ position: 1, cardinality: 4, best: { kind: "country", dimension: "country", hitRate: 1 } });
    expect(p1?.examples.slice(0, 3)).toEqual(["BR", "MX", "US"]);
    expect(p2).toMatchObject({ cardinality: 2, best: { kind: "platform", dimension: "platform", hitRate: 1 } });
    expect(p3).toMatchObject({ best: { kind: "audience", dimension: "audience", hitRate: 1 } });
    expect(p4).toMatchObject({ best: { kind: "quarter", dimension: null, hitRate: 1 } });
    expect(p5?.best?.dimension ?? null).toBeNull();
    expect(a.proposal).toEqual({ delimiter: "_", tokens: [{ dimension: "country", aliases: {} }, { dimension: "platform", aliases: {} }, { dimension: "audience", aliases: {} }, { dimension: null, aliases: {} }, { dimension: null, aliases: {} }] });
  });

  it("uses the registry's own values for dimensions without a dictionary", () => {
    const a = analyzeCampaignNames(["acme-BR-x", "globex-MX-y", "acme-US-z"], [{ key: "client" }, { key: "country" }], (d, tk) => d === "client" && ["acme", "globex"].includes(tk.toLowerCase()));
    expect(a.delimiter).toBe("-");
    expect(a.proposal.tokens.map((t) => t.dimension)).toEqual(["client", "country", null]);
  });

  it("no names: nothing to propose", () => {
    expect(analyzeCampaignNames([], dims)).toMatchObject({ total: 0, fitting: 0, positions: [], proposal: { delimiter: "_", tokens: [] } });
  });
});
