export interface ParsedSearch {
  text: string;
  qualifiers: Array<{ key: string; op: "eq" | "gt" | "lt" | "neq"; value: string }>;
  types: string[];
}
const QUAL = /(?:^|\s)(-)?([a-z_]+):((?:>|<)?[^\s"]+|"[^"]*")/gi;

export function parseSearch(input: string): ParsedSearch {
  const qualifiers: ParsedSearch["qualifiers"] = [];
  const types: string[] = [];
  const text = input
    .replace(QUAL, (_, neg: string | undefined, key: string, raw: string) => {
      let value = raw.replace(/^"|"$/g, "");
      let op: ParsedSearch["qualifiers"][number]["op"] = neg ? "neq" : "eq";
      if (value.startsWith(">")) {
        op = "gt";
        value = value.slice(1);
      } else if (value.startsWith("<")) {
        op = "lt";
        value = value.slice(1);
      }
      if (key.toLowerCase() === "type") types.push(value.toLowerCase());
      else qualifiers.push({ key: key.toLowerCase(), op, value });
      return " ";
    })
    .trim()
    .replace(/\s+/g, " ");
  return { text, qualifiers, types };
}
