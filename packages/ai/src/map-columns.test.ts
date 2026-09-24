import { describe, expect, it } from "vitest";
import { buildPrompt, openAiClient, parseSuggestion } from "./map-columns.js";

/** No network: prompt shape and answer validation. The live call needs OPENAI_API_KEY (ADR-011). */
const sample = { header: ["COUNTRY", "MONTH", "SPEND_USD"], rows: Array.from({ length: 30 }, (_, i) => ["BR", "2026-01", String(i)]) };

describe("mapColumns", () => {
  it("sends at most 20 sample rows with the dimension keys", () => {
    const body = JSON.parse(buildPrompt(sample, ["country", "platform"])) as { rows: unknown[]; dimensionKeys: string[] };
    expect(body.rows).toHaveLength(20);
    expect(body.dimensionKeys).toEqual(["country", "platform"]);
  });

  it("accepts a valid mapping and refuses invented columns, dimensions or bad JSON", () => {
    const ok = { kind: "spend", columns: { COUNTRY: { dimension: "country" }, MONTH: { role: "period_date", format: "yyyy-MM" }, SPEND_USD: { role: "amount", currency: "USD" } } };
    expect(parseSuggestion(JSON.stringify(ok), sample, ["country"]).kind).toBe("spend");
    expect(() => parseSuggestion(JSON.stringify({ ...ok, columns: { ...ok.columns, EXTRA: { role: "ignore" } } }), sample, ["country"])).toThrow(/do not exist/);
    expect(() => parseSuggestion(JSON.stringify({ ...ok, columns: { ...ok.columns, COUNTRY: { dimension: "planet" } } }), sample, ["country"])).toThrow(/do not exist/);
    expect(() => parseSuggestion("not json", sample, ["country"])).toThrow(/no JSON/);
    expect(() => parseSuggestion(JSON.stringify({ kind: "spend", columns: {} }), sample, ["country"])).toThrow(/invalid mapping/);
  });

  it("is unavailable without OPENAI_API_KEY", () => {
    expect(() => openAiClient({})).toThrow(/OPENAI_API_KEY/);
  });
});
