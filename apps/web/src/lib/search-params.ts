import { parseSearchWith, stringifySearchWith } from "@tanstack/react-router";
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";

/**
 * URL search serialization (spec §18.3): JSON values as TanStack's default, except `filter` and
 * `expanded`, which travel as lz-string (they are large). Validation stays in each route's
 * validateSearch; a value that does not decode is passed through for it to reject.
 */
const LZ_KEYS = ["filter", "expanded"] as const;
const base = { parse: parseSearchWith(JSON.parse), stringify: stringifySearchWith(JSON.stringify) };

export function parseSearch(search: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base.parse(search) };
  for (const key of LZ_KEYS) {
    const v = out[key];
    if (typeof v !== "string") continue;
    try {
      const json = decompressFromEncodedURIComponent(v);
      if (json) out[key] = JSON.parse(json) as unknown;
    } catch {
      // leave it: validateSearch reports the bad value
    }
  }
  return out;
}

export function stringifySearch(search: Record<string, unknown>): string {
  const out: Record<string, unknown> = { ...search };
  for (const key of LZ_KEYS) {
    const v = out[key];
    if (v !== undefined && v !== null && typeof v !== "string") out[key] = compressToEncodedURIComponent(JSON.stringify(v));
  }
  return base.stringify(out);
}
