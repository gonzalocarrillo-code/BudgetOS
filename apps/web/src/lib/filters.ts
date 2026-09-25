import { FilterGroup, type FilterGroupT } from "@budget/domain";
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";

/** FilterGroup in the URL (spec §18.3): lz-string of its JSON. Decoding validates with the domain schema. */
export const encodeFilter = (f: FilterGroupT): string => compressToEncodedURIComponent(JSON.stringify(f));

export function decodeFilter(s: string): FilterGroupT {
  const json = decompressFromEncodedURIComponent(s);
  if (!json) throw new Error("filter is not an lz-string FilterGroup");
  return FilterGroup.parse(JSON.parse(json));
}
