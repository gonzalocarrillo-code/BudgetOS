import { DomainError, SourceMapping } from "@budget/domain";
import OpenAI from "openai";

/**
 * Column-mapping suggestion (spec §14 `suggest-mapping`): the header row and up to 20 sample rows go
 * to OpenAI in JSON mode; the answer must parse as a `SourceMapping`. Nothing is applied here: the
 * user confirms the mapping in the UI. The only OpenAI call site for ingestion (AGENTS.md §4).
 */

export interface SampleTable {
  header: string[];
  rows: Array<Array<string | number | null>>;
}

export interface MappingSuggestion {
  mapping: SourceMapping;
  model: string;
}

/** The client surface mapColumns uses; the OpenAI SDK satisfies it. */
export interface ChatClient {
  chat: { completions: { create(body: { model: string; response_format: { type: "json_object" }; messages: Array<{ role: "system" | "user"; content: string }> }): Promise<{ choices: Array<{ message: { content: string | null } }> }> } };
}

export const MAX_SAMPLE_ROWS = 20;

const SYSTEM = [
  "You map spreadsheet columns for a marketing budget system.",
  'Answer with one JSON object: {"kind": "spend" | "kpi" | "spend+kpi" | "projection", "columns": {<header>: <mapping>}}.',
  'A mapping is {"dimension": <key>, "transform"?: "lower"|"upper"|"trim"} or {"role": <role>, …}.',
  'Roles: "period_date" with "format" (yyyy-MM-dd | yyyy-MM | dd/MM/yyyy | MM/dd/yyyy); "amount" with optional "currency" (ISO 4217);',
  '"currency"; "kpi" with "metric" (lower_snake_case, e.g. conversions, revenue, impressions, clicks, leads);',
  '"projection" with "metric"; "formula_version"; "horizon_end"; "ignore".',
  "Use only dimension keys from the list given. Map every header. Do not invent columns.",
  'When "hints" are given: "columns" says what a header (in lower case, letters and digits only) usually means in this workspace; prefer it.',
  '"ratioWords" are ratio metrics (CPA, ROAS, CTR, …): the system computes them from counts, so map those columns to "ignore".',
].join(" ");

/** The workspace's own words (D-005): what headers usually mean here, and which words are ratios. */
export interface MappingHints {
  columns: Record<string, unknown>;
  ratioWords: string[];
}

/** The prompt body: dimension keys, header and the first MAX_SAMPLE_ROWS rows. */
export function buildPrompt(sample: SampleTable, dimensionKeys: string[], hints?: MappingHints): string {
  return JSON.stringify({ dimensionKeys, header: sample.header, rows: sample.rows.slice(0, MAX_SAMPLE_ROWS), ...(hints ? { hints } : {}) });
}

/** Parses and validates the model's answer; unknown headers or dimension keys are refused. */
export function parseSuggestion(content: string | null, sample: SampleTable, dimensionKeys: string[]): SourceMapping {
  let raw: unknown;
  try {
    raw = JSON.parse(content ?? "");
  } catch {
    throw new DomainError("UNAVAILABLE", "The mapping model returned no JSON");
  }
  const parsed = SourceMapping.safeParse(raw);
  if (!parsed.success) throw new DomainError("UNAVAILABLE", "The mapping model returned an invalid mapping", { issues: parsed.error.flatten() });
  const extra = Object.keys(parsed.data.columns).filter((c) => !sample.header.includes(c));
  const dims = new Set(dimensionKeys);
  const unknownDims = Object.values(parsed.data.columns).flatMap((c) => ("dimension" in c && !dims.has(c.dimension) ? [c.dimension] : []));
  if (extra.length || unknownDims.length) throw new DomainError("UNAVAILABLE", "The mapping model named columns or dimensions that do not exist", { extra, unknownDims });
  return parsed.data;
}

export function openAiClient(env: NodeJS.ProcessEnv = process.env): ChatClient {
  const apiKey = env["OPENAI_API_KEY"];
  if (!apiKey) throw new DomainError("UNAVAILABLE", "Mapping suggestions need OPENAI_API_KEY");
  return new OpenAI({ apiKey }) as unknown as ChatClient;
}

export async function mapColumns(sample: SampleTable, dimensionKeys: string[], client: ChatClient = openAiClient(), model = process.env["OPENAI_MODEL"] ?? "gpt-4.1-mini", hints?: MappingHints): Promise<MappingSuggestion> {
  const res = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: buildPrompt(sample, dimensionKeys, hints) },
    ],
  });
  return { mapping: parseSuggestion(res.choices[0]?.message.content ?? null, sample, dimensionKeys), model };
}
