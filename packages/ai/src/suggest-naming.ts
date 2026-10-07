import { DomainError, MAX_AI_NAMES, NamingAiSuggestion, type DictionaryKind } from "@budget/domain";
import { openAiClient, type ChatClient } from "./map-columns.js";

/**
 * EX-6 (ADR-0091): "Suggest with AI" for campaign naming conventions — support only. Only the
 * distinct campaign names (at most MAX_AI_NAMES) and the workspace's dimension keys go to OpenAI;
 * no amounts, no ids. The answer must parse as `NamingAiSuggestion` and name only those
 * dimensions. Nothing is applied here: the user reviews the suggestion and saves it.
 */

export interface NamingDimension {
  key: string;
  label: string;
  /** The built-in dictionary the dimension already uses, so the model knows what is covered. */
  dictionary: DictionaryKind | null;
}

const SYSTEM = [
  "You read marketing campaign names and infer their naming convention.",
  'Answer with one JSON object: {"delimiter": one of "_", "-", ".", "|", "/", ":", "·", " ", "+",',
  '"positions": [{"dimension": <key> | null, "confidence": 0..1}] (one per part of a name, in order; null = not a dimension, e.g. a date or creative id),',
  '"mappings": [{"position": <1-based>, "token": <a part as written>, "value": <the value code it means, e.g. an ISO country code, a platform such as meta>, "confidence": 0..1}]}.',
  "Use only dimension keys from the list given, each at most once. Only map tokens that are abbreviations or synonyms; leave plain values out.",
].join(" ");

/** The prompt body: distinct names (first MAX_AI_NAMES) and the dimensions. */
export function buildNamingPrompt(names: readonly string[], dimensions: readonly NamingDimension[]): string {
  const distinct = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ""))].slice(0, MAX_AI_NAMES);
  return JSON.stringify({ dimensions: dimensions.map((d) => ({ key: d.key, label: d.label, dictionary: d.dictionary })), names: distinct });
}

/** Parses and validates the model's answer. */
export function parseNamingSuggestion(content: string | null, dimensions: readonly NamingDimension[]): NamingAiSuggestion {
  let raw: unknown;
  try {
    raw = JSON.parse(content ?? "");
  } catch {
    throw new DomainError("UNAVAILABLE", "The naming model returned no JSON");
  }
  const parsed = NamingAiSuggestion.safeParse(raw);
  if (!parsed.success) throw new DomainError("UNAVAILABLE", "The naming model returned an invalid suggestion", { issues: parsed.error.flatten() });
  const s = parsed.data;
  const keys = new Set(dimensions.map((d) => d.key));
  const named = s.positions.flatMap((p) => (p.dimension === null ? [] : [p.dimension]));
  const unknown = named.filter((k) => !keys.has(k));
  if (unknown.length) throw new DomainError("UNAVAILABLE", "The naming model named dimensions that do not exist", { unknown });
  if (new Set(named).size !== named.length) throw new DomainError("UNAVAILABLE", "The naming model used a dimension twice");
  const outside = s.mappings.filter((m) => m.position > s.positions.length || s.positions[m.position - 1]?.dimension == null);
  if (outside.length) throw new DomainError("UNAVAILABLE", "The naming model mapped a token at a position without a dimension", { positions: outside.map((m) => m.position) });
  return s;
}

export interface NamingSuggestionResult {
  suggestion: NamingAiSuggestion;
  model: string;
  /** How many names were sent. */
  names: number;
}

export async function suggestNamingConvention(names: readonly string[], dimensions: readonly NamingDimension[], client: ChatClient = openAiClient(), model = process.env["OPENAI_MODEL"] ?? "gpt-4.1-mini"): Promise<NamingSuggestionResult> {
  const prompt = buildNamingPrompt(names, dimensions);
  const sent = (JSON.parse(prompt) as { names: string[] }).names.length;
  const res = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ],
  });
  return { suggestion: parseNamingSuggestion(res.choices[0]?.message.content ?? null, dimensions), model, names: sent };
}
