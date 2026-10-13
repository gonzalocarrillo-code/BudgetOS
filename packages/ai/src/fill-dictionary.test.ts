import { describe, expect, it, vi } from "vitest";
import type { ChatClient } from "./map-columns.js";
import { buildDictionaryPrompt, fillNamingDictionary, parseDictionaryAnswer } from "./fill-dictionary.js";
import { parseNamingSuggestion } from "./suggest-naming.js";

/**
 * EX-7 (ADR-0093): "Fill dictionary with AI" sends only a position's unresolved codes, a few full
 * example names, the granularity's name and existing registry values (codes + labels); the answer is
 * validated and narrowed to the codes sent and values that exist. No network here.
 */
const codes = Array.from({ length: 260 }, (_, i) => `C${i}`);
const examples = Array.from({ length: 30 }, (_, i) => `GOOG_C_SEM_C${i}_Core_WA_BAU_ACQ_PER_MIX_ALL_NAMER_US_EN_020426_General`);
const input = { granularity: "Product", codes, examples, values: [{ code: "gcp", label: "Google Cloud" }] };
const client = (content: string): ChatClient => ({ chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content } }] })) } } });

describe("fillNamingDictionary", () => {
  it("sends capped codes, examples and values; nothing else", () => {
    const body = JSON.parse(buildDictionaryPrompt(input)) as Record<string, unknown> & { codes: string[]; examples: string[] };
    expect(Object.keys(body).sort()).toEqual(["codes", "examples", "granularity", "values"]);
    expect(body.codes).toHaveLength(200);
    expect(body.examples).toHaveLength(10);
  });

  it("keeps only codes that were sent; a value that is not a registry value becomes null", () => {
    const answer = { entries: [{ code: "c1", meaning: "Cloud", value: "gcp", confidence: 0.9 }, { code: "C2", meaning: "Two", value: "nope", confidence: 0.4 }, { code: "ZZZ", meaning: "?", value: null, confidence: 1 }] };
    expect(parseDictionaryAnswer(JSON.stringify(answer), input)).toEqual([
      { code: "C1", meaning: "Cloud", value: "gcp", confidence: 0.9 },
      { code: "C2", meaning: "Two", value: null, confidence: 0.4 },
    ]);
    expect(() => parseDictionaryAnswer("nope", input)).toThrow(/no JSON/);
    expect(() => parseDictionaryAnswer(JSON.stringify({ entries: [{ code: "C1" }] }), input)).toThrow(/invalid/);
  });

  it("calls the client once in JSON mode", async () => {
    const c = client(JSON.stringify({ entries: [{ code: "C1", meaning: "Cloud", value: null, confidence: 0.6 }] }));
    const res = await fillNamingDictionary(input, c, "test-model");
    expect(res).toEqual({ proposals: [{ code: "C1", meaning: "Cloud", value: null, confidence: 0.6 }], model: "test-model", codes: 200, examples: 10 });
    expect(vi.mocked(c.chat.completions.create).mock.calls[0]?.[0].response_format).toEqual({ type: "json_object" });
  });
});

describe("suggest naming roles (EX-7)", () => {
  const dims = [{ key: "country", label: "Country", dictionary: "country" as const }];
  it("a position may be a date (with a pattern), free text, ignored, or a new granularity", () => {
    const s = parseNamingSuggestion(JSON.stringify({ delimiter: "_", positions: [{ dimension: "country", confidence: 1 }, { dimension: null, role: "date", datePattern: "MMDDYY", confidence: 0.9 }, { dimension: null, role: "free_text", confidence: 0.5 }, { dimension: null, role: "dimension", newGranularity: "Product", confidence: 0.6 }], mappings: [] }), dims);
    expect(s.positions.map((p) => p.role ?? null)).toEqual([null, "date", "free_text", "dimension"]);
    expect(() => parseNamingSuggestion(JSON.stringify({ delimiter: "_", positions: [{ dimension: null, role: "date", confidence: 1 }], mappings: [] }), dims)).toThrow(/pattern/);
  });
});
