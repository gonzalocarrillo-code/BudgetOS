import { describe, expect, it } from "vitest";
import { CreateNamingConventionInput, type NamingConventionToken } from "./matching.js";
import { analyzeCampaignNames, explainCampaignName, makeTokenResolver, normalizeToken, proposalFromSuggestion } from "./naming-dictionaries.js";
import {
  BulkDictionaryInput,
  DictionaryAiAnswer,
  builtinDictionaryRows,
  dictionaryToCsv,
  parseDictionaryCsv,
  parseDictionaryPaste,
  parseNamingDate,
  type DictionaryRows,
} from "./naming-dictionary-entries.js";

/**
 * EX-7 (ADR-0093): dictionaries are data. The owner's real campaign names (16 parts, client codes no
 * built-in list knows, a MMDDYY launch date and free text at the end, a hyphen inside a part) parse
 * with ignore / date / free-text positions; workspace dictionary rows resolve before the registry
 * (yours, AI, synced) or after it (built-in seed); bulk paste and CSV round-trip.
 */

export const REAL_NAMES = [
  "GOOG_C_SEM_GNB_Core-Translate_WA_BAU_ACQ_PER_MIX_ALL_NAMER_US_EN_020426_General",
  "GOOG_C_SEM_GCP_Core_WA_BAU_ACQ_PER_MIX_ALL_NAMER_US_EN_013125_General",
  "GOOG_G_PRG_YTB_Codex_BR_BAU_VID_PER_PHR_ALL_NAMER_US_EN_060126_KnowledgeWorker",
  "GOOG_G_SEM_GBR_Core_CW_BAU_ACQ_PER_DMA_ALL_NAMER_US_EN_031826_Developer",
];

const ignore = (): NamingConventionToken => ({ dimension: null, aliases: {}, kind: "ignore" });
const dim = (dimension: string): NamingConventionToken => ({ dimension, aliases: {}, kind: "dimension" });
/** Positions 1–16: client, ?, channel, product, sub-product, ?, ?, ?, ?, ?, device, region, country, language, launch date, free text. */
const convention = {
  delimiter: "_",
  tokens: [ignore(), ignore(), dim("channel"), dim("product"), ignore(), ignore(), ignore(), ignore(), ignore(), ignore(), ignore(), dim("region"), dim("country"), dim("language"), { dimension: null, aliases: {}, kind: "date", datePattern: "MMDDYY" }, { dimension: null, aliases: {}, kind: "free_text", attribute: "audience_note" }] as NamingConventionToken[],
};

const productRows: DictionaryRows = {
  seeded: false,
  entries: [
    { code: "GNB", value: "gnb", label: "Google Nest & Business", source: "user" },
    { code: "GCP", value: "gcp", label: "Google Cloud", source: "ai" },
    { code: "YTB", value: "youtube", label: "YouTube", source: "user" },
    { code: "GBR", value: "gbr", label: "Google Brand", source: "sync" },
  ],
};

describe("positions: ignore, date, free text", () => {
  it("the four real names split into 16 parts; the hyphenated part stays whole", () => {
    for (const name of REAL_NAMES) {
      const e = explainCampaignName(convention, name, makeTokenResolver({ channel: [], product: [], region: [], country: [], language: [] }, undefined, { product: productRows }));
      expect(e.parts).toHaveLength(16);
    }
    const first = explainCampaignName(convention, REAL_NAMES[0] as string, makeTokenResolver({}, undefined, { product: productRows }));
    expect(first.parts[4]?.raw).toBe("Core-Translate");
    expect(first.parts[4]?.kind).toBe("ignore");
  });

  it("dates: 020426 is 2026-02-04 (MMDDYY); DDMMYY and YYYYMMDD; nonsense is null", () => {
    expect(parseNamingDate("020426", "MMDDYY")).toBe("2026-02-04");
    expect(parseNamingDate("013125", "MMDDYY")).toBe("2025-01-31");
    expect(parseNamingDate("310125", "DDMMYY")).toBe("2025-01-31");
    expect(parseNamingDate("20260204", "YYYYMMDD")).toBe("2026-02-04");
    expect(parseNamingDate("023126", "MMDDYY")).toBeNull();
    expect(parseNamingDate("General", "MMDDYY")).toBeNull();
  });

  it("a name reads its granularities, the launch date and the free text as attributes", () => {
    const e = explainCampaignName(convention, REAL_NAMES[0] as string, makeTokenResolver({ channel: [{ code: "paid_search", label: "Paid search", aliases: [] }], country: [], language: [], region: [] }, undefined, { product: productRows, region: { seeded: false, entries: [{ code: "NAMER", value: "AMER", label: "North America", source: "user" }] } }));
    expect(e.problem).toBeNull();
    expect(e.dimensionValues).toEqual({ channel: "paid_search", product: "gnb", region: "AMER", country: "US", language: "en" });
    expect(e.attributes).toEqual({ launch_date: "2026-02-04", audience_note: "General" });
    expect(e.parts[14]).toMatchObject({ kind: "date", code: "2026-02-04" });
  });

  it("ignored positions never make a name non-conforming, not even when empty; a bad date does", () => {
    const resolve = makeTokenResolver({}, undefined, { product: productRows, channel: { seeded: false, entries: [{ code: "SEM", value: "paid_search", label: "Search", source: "user" }] }, region: { seeded: false, entries: [{ code: "NAMER", value: "AMER", label: "NA", source: "user" }] } });
    const odd = "__SEM_GNB________NAMER_US_EN_020426_";
    const e = explainCampaignName(convention, odd, resolve);
    expect(e.problem).toBeNull();
    expect(e.attributes).toEqual({ launch_date: "2026-02-04" });
    const bad = explainCampaignName(convention, (REAL_NAMES[0] as string).replace("020426", "999999"), resolve);
    expect(bad.problem).toEqual({ kind: "date", position: 15, value: "999999" });
  });

  it("the convention schema checks each kind's fields", () => {
    expect(CreateNamingConventionInput.safeParse(convention).success).toBe(true);
    expect(CreateNamingConventionInput.safeParse({ delimiter: "_", tokens: [dim("country"), { dimension: null, aliases: {}, kind: "date" }] }).success).toBe(false);
    expect(CreateNamingConventionInput.safeParse({ delimiter: "_", tokens: [dim("country"), { dimension: "product", aliases: {}, kind: "free_text" }] }).success).toBe(false);
    expect(CreateNamingConventionInput.safeParse({ delimiter: "_", tokens: [{ dimension: null, aliases: {}, kind: "dimension" }] }).success).toBe(false);
    // EX-6 tokens without a kind still parse: dimension → "dimension", null → "ignore".
    expect(CreateNamingConventionInput.safeParse({ delimiter: "_", tokens: [{ dimension: "country", aliases: {} }, { dimension: null, aliases: {} }] }).success).toBe(true);
  });

  it("analysis proposes the date position; country and language land on exact codes (US, EN), not on PER (Peru, Persian)", () => {
    const a = analyzeCampaignNames(REAL_NAMES, [{ key: "country" }, { key: "language" }, { key: "region" }]);
    expect(a.partCount).toBe(16);
    expect(a.proposal.tokens[14]).toMatchObject({ dimension: null, kind: "date", datePattern: "MMDDYY" });
    expect(a.proposal.tokens[12]?.dimension).toBe("country");
    expect(a.proposal.tokens[13]?.dimension).toBe("language");
    expect(a.proposal.tokens[8]?.dimension).toBeNull();
  });
});

describe("workspace dictionary rows in the resolver", () => {
  const registry = { product: [{ code: "gcp_registry", label: "GCP", aliases: [] }], country: [{ code: "UK", label: "United Kingdom", aliases: [] }] };

  it("your entries (user, ai, sync) win over registry values; built-in rows come after the registry", () => {
    const resolve = makeTokenResolver(registry, undefined, { product: productRows });
    expect(resolve("product", "gcp")).toMatchObject({ code: "gcp", source: "dictionary", known: false, label: "Google Cloud" });
    expect(resolve("product", "gnb")).toMatchObject({ code: "gnb", source: "dictionary" });
    expect(resolve("product", "ytb")).toMatchObject({ code: "youtube" });
  });

  it("a seeded dictionary reads only its rows: a built-in entry deleted there no longer resolves; registry synonyms still land", () => {
    const rows = builtinDictionaryRows("country").filter((r) => r.value !== "BR");
    const resolve = makeTokenResolver(registry, undefined, { country: { seeded: true, entries: rows.map((r) => ({ ...r, source: "builtin" as const })) } });
    expect(resolve("country", "Brasil")).toBeNull();
    expect(resolve("country", "GBR")).toMatchObject({ code: "UK", known: true });
    expect(resolve("country", "Alemania")).toMatchObject({ code: "DE", known: false });
    // Not seeded: the static built-in dictionary (EX-6) still reads it.
    expect(makeTokenResolver(registry)("country", "Brasil")).toMatchObject({ code: "BR" });
  });

  it("built-in rows: every synonym once (normalized), landing on the canonical code", () => {
    const rows = builtinDictionaryRows("country");
    const norms = rows.map((r) => normalizeToken(r.code));
    expect(new Set(norms).size).toBe(norms.length);
    expect(rows.find((r) => r.code === "UK")).toMatchObject({ value: "GB", label: "United Kingdom" });
    expect(rows.length).toBeGreaterThan(600);
    expect(builtinDictionaryRows("platform").find((r) => r.code === "FB")?.value ?? builtinDictionaryRows("platform").find((r) => normalizeToken(r.code) === "fb")?.value).toBe("meta");
    expect(builtinDictionaryRows("quarter")).toEqual([]);
  });
});

describe("bulk paste and CSV", () => {
  it("parses code<TAB>meaning per line (optional value); reports bad lines", () => {
    const res = parseDictionaryPaste("GNB\tGoogle Nest & Business\nGCP\tGoogle Cloud\tgcp\n\nnotab\n");
    expect(res.entries).toEqual([
      { code: "GNB", meaning: "Google Nest & Business" },
      { code: "GCP", meaning: "Google Cloud", value: "gcp" },
    ]);
    expect(res.errors).toEqual([4]);
    expect(BulkDictionaryInput.safeParse({ entries: res.entries }).success).toBe(true);
  });

  it("CSV round-trips, quotes and commas included", () => {
    const entries = [
      { code: "GNB", meaning: "Nest, Business", value: "gnb", notes: 'says "home"', source: "user" as const },
      { code: "YTB", meaning: "YouTube", value: "youtube", notes: null, source: "builtin" as const },
    ];
    const csv = dictionaryToCsv(entries);
    expect(csv.split("\n")[0]).toBe("code,meaning,value,notes,source");
    expect(parseDictionaryCsv(csv)).toEqual({
      entries: [
        { code: "GNB", meaning: "Nest, Business", value: "gnb", notes: 'says "home"' },
        { code: "YTB", meaning: "YouTube", value: "youtube" },
      ],
      errors: [],
    });
    expect(parseDictionaryCsv("code,meaning\nA,Alpha\n,missing").errors).toEqual([3]);
  });
});

describe("AI", () => {
  it("the dictionary answer is validated", () => {
    expect(DictionaryAiAnswer.safeParse({ entries: [{ code: "GNB", meaning: "Nest", value: null, confidence: 0.7 }] }).success).toBe(true);
    expect(DictionaryAiAnswer.safeParse({ entries: [{ code: "GNB", meaning: "Nest", confidence: 2 }] }).success).toBe(false);
  });

  it("an AI convention suggestion may say date, free text or ignore per position", () => {
    const p = proposalFromSuggestion({
      delimiter: "_",
      positions: [
        { dimension: "country", confidence: 0.9 },
        { dimension: null, role: "date", datePattern: "MMDDYY", confidence: 0.9 },
        { dimension: null, role: "free_text", confidence: 0.6 },
        { dimension: null, role: "ignore", confidence: 0.6 },
      ],
      mappings: [],
    });
    expect(p.tokens.map((t) => t.kind)).toEqual(["dimension", "date", "free_text", "ignore"]);
    expect(p.tokens[1]?.datePattern).toBe("MMDDYY");
  });
});
