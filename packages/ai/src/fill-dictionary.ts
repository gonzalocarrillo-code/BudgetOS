import { DictionaryAiAnswer, DomainError, MAX_AI_CODES, MAX_AI_EXAMPLES, MAX_AI_VALUES, normalizeToken, type DictionaryAiProposal } from "@budget/domain";
import { openAiClient, type ChatClient } from "./map-columns.js";

/**
 * EX-7 (ADR-0093): "Fill dictionary with AI" for one position of the campaign naming convention —
 * support only. Sent: the position's unresolved codes (at most MAX_AI_CODES), a few full example
 * names (MAX_AI_EXAMPLES) for context, the granularity's name and its existing registry values
 * (codes and labels, MAX_AI_VALUES). No amounts, no ids. The answer is validated with zod and
 * narrowed to the codes sent and values that exist; nothing is written here.
 */

export interface DictionaryFillInput {
  granularity: string;
  codes: readonly string[];
  examples: readonly string[];
  values: ReadonlyArray<{ code: string; label: string }>;
}

const SYSTEM = [
  "You expand abbreviations used in marketing campaign names for one granularity (e.g. Product, Tactic, Audience).",
  'Answer with one JSON object: {"entries": [{"code": <a code exactly as given>, "meaning": <short human meaning>, "value": <one of the existing value codes given, only when it clearly means that value, else null>, "confidence": 0..1}]}.',
  "Only answer for the codes given. If you do not know a code, leave it out rather than guess.",
].join(" ");

const distinct = (xs: readonly string[], cap: number) => [...new Set(xs.map((x) => x.trim()).filter((x) => x !== ""))].slice(0, cap);

/** The prompt body: capped codes, example names and registry values. */
export function buildDictionaryPrompt(input: DictionaryFillInput): string {
  return JSON.stringify({
    granularity: input.granularity.slice(0, 120),
    codes: distinct(input.codes, MAX_AI_CODES),
    examples: distinct(input.examples, MAX_AI_EXAMPLES),
    values: input.values.slice(0, MAX_AI_VALUES).map((v) => ({ code: v.code, label: v.label })),
  });
}

/** Parses and validates the model's answer: only codes that were sent (as sent), only values that exist. */
export function parseDictionaryAnswer(content: string | null, input: DictionaryFillInput): DictionaryAiProposal[] {
  let raw: unknown;
  try {
    raw = JSON.parse(content ?? "");
  } catch {
    throw new DomainError("UNAVAILABLE", "The dictionary model returned no JSON");
  }
  const parsed = DictionaryAiAnswer.safeParse(raw);
  if (!parsed.success) throw new DomainError("UNAVAILABLE", "The dictionary model returned an invalid answer", { issues: parsed.error.flatten() });
  const sent = new Map(distinct(input.codes, MAX_AI_CODES).map((c) => [normalizeToken(c), c]));
  const values = new Map(input.values.slice(0, MAX_AI_VALUES).map((v) => [normalizeToken(v.code), v.code]));
  const seen = new Set<string>();
  const out: DictionaryAiProposal[] = [];
  for (const e of parsed.data.entries) {
    const k = normalizeToken(e.code);
    const code = sent.get(k);
    if (code === undefined || seen.has(k)) continue;
    seen.add(k);
    out.push({ code, meaning: e.meaning.trim().slice(0, 200), value: e.value ? (values.get(normalizeToken(e.value)) ?? null) : null, confidence: e.confidence });
  }
  return out;
}

export interface DictionaryFillResult {
  proposals: DictionaryAiProposal[];
  model: string;
  codes: number;
  examples: number;
}

export async function fillNamingDictionary(input: DictionaryFillInput, client: ChatClient = openAiClient(), model = process.env["OPENAI_MODEL"] ?? "gpt-4.1-mini"): Promise<DictionaryFillResult> {
  const prompt = buildDictionaryPrompt(input);
  const body = JSON.parse(prompt) as { codes: string[]; examples: string[] };
  const res = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ],
  });
  return { proposals: parseDictionaryAnswer(res.choices[0]?.message.content ?? null, input), model, codes: body.codes.length, examples: body.examples.length };
}
