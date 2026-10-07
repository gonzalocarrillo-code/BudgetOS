import { describe, expect, it, vi } from "vitest";
import type { ChatClient } from "./map-columns.js";
import { buildNamingPrompt, parseNamingSuggestion, suggestNamingConvention } from "./suggest-naming.js";

/**
 * EX-6 (ADR-0092): "Suggest with AI" sends only distinct campaign names (at most 300) and the
 * workspace's dimension keys; the answer is validated before anyone sees it. No network here.
 */
const dims = [
  { key: "country", label: "Country", dictionary: "country" as const },
  { key: "platform", label: "Platform", dictionary: "platform" as const },
  { key: "audience", label: "Audience", dictionary: "audience" as const },
];
const names = Array.from({ length: 400 }, (_, i) => `BR_FB_Prospecting_Q4_V${i % 350}`);
const answer = {
  delimiter: "_",
  positions: [
    { dimension: "country", confidence: 0.98 },
    { dimension: "platform", confidence: 0.9 },
    { dimension: "audience", confidence: 0.8 },
    { dimension: null, confidence: 0.7 },
    { dimension: null, confidence: 0.6 },
  ],
  mappings: [{ position: 2, token: "FB", value: "meta", confidence: 0.95 }],
};
const client = (content: string): ChatClient => ({ chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content } }] })) } } });

describe("suggestNamingConvention", () => {
  it("sends distinct names only (cap 300) and the dimension keys; no amounts, no ids", () => {
    const body = JSON.parse(buildNamingPrompt(names, dims)) as { names: string[]; dimensions: Array<{ key: string }> } & Record<string, unknown>;
    expect(body.names).toHaveLength(300);
    expect(new Set(body.names).size).toBe(300);
    expect(body.dimensions.map((d) => d.key)).toEqual(["country", "platform", "audience"]);
    expect(Object.keys(body).sort()).toEqual(["dimensions", "names"]);
  });

  it("validates the answer: shape, known dimension keys, positions in range, one position per dimension", () => {
    expect(parseNamingSuggestion(JSON.stringify(answer), dims).positions).toHaveLength(5);
    expect(() => parseNamingSuggestion("nope", dims)).toThrow(/no JSON/);
    expect(() => parseNamingSuggestion(JSON.stringify({ ...answer, delimiter: "~" }), dims)).toThrow(/invalid/);
    expect(() => parseNamingSuggestion(JSON.stringify({ ...answer, positions: [{ dimension: "planet", confidence: 1 }] }), dims)).toThrow(/do not exist/);
    expect(() => parseNamingSuggestion(JSON.stringify({ ...answer, positions: [{ dimension: "country", confidence: 1 }, { dimension: "country", confidence: 1 }] }), dims)).toThrow(/twice/);
    expect(() => parseNamingSuggestion(JSON.stringify({ ...answer, mappings: [{ position: 9, token: "x", value: "y", confidence: 1 }] }), dims)).toThrow(/position/);
  });

  it("calls the client once in JSON mode and returns the validated suggestion", async () => {
    const c = client(JSON.stringify(answer));
    const res = await suggestNamingConvention(names, dims, c, "test-model");
    expect(res).toEqual({ suggestion: answer, model: "test-model", names: 300 });
    expect(c.chat.completions.create).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(c.chat.completions.create).mock.calls[0]?.[0];
    expect(sent?.response_format).toEqual({ type: "json_object" });
    expect(sent?.messages[1]?.content).not.toMatch(/\d+\.\d{2}/);
  });
});
