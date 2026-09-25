/**
 * The comment editor shows `@Name`; the API stores `@[user:<uuid>]` / `@[group:<uuid>]` (spec §13).
 * These helpers convert between the two with the list of people picked from the autocomplete,
 * and find the `@partial` being typed at the caret (ADR-025).
 */

export interface Picked {
  type: "user" | "group";
  id: string;
  name: string;
}

export type Names = { users: Record<string, string>; groups: Record<string, string> };

const CANONICAL = /@\[(user|group):([0-9a-f-]{36})\]/g;

/** `@Name` → canonical, longest names first so "Ana Maria" wins over "Ana". A name no longer in the text is dropped. */
export function toCanonical(text: string, picked: Picked[]): string {
  let out = text;
  for (const p of [...picked].sort((a, b) => b.name.length - a.name.length)) out = out.split(`@${p.name}`).join(`@[${p.type}:${p.id}]`);
  return out;
}

/** Canonical → `@Name` plus the people it mentions, to edit an existing comment. */
export function fromCanonical(body: string, names: Names): { text: string; picked: Picked[] } {
  const picked: Picked[] = [];
  const text = body.replace(CANONICAL, (_, type: "user" | "group", id: string) => {
    const name = (type === "user" ? names.users[id] : names.groups[id]) ?? id;
    if (!picked.some((p) => p.id === id)) picked.push({ type, id, name });
    return `@${name}`;
  });
  return { text, picked };
}

/** The `@partial` ending at the caret, if the caret is in one: its start index and the query. */
export function activeMention(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([\p{L}\p{N}._-]{0,40})$/u.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - (m[2]?.length ?? 0) - 1, query: m[2] ?? "" };
}

/** A body split into text and mention parts, for display with names resolved. */
export function bodyParts(body: string, names: Names): Array<{ kind: "text"; text: string } | { kind: "mention"; type: "user" | "group"; id: string; name: string }> {
  const parts: ReturnType<typeof bodyParts> = [];
  let last = 0;
  for (const m of body.matchAll(CANONICAL)) {
    const type = m[1] as "user" | "group";
    const id = m[2] as string;
    if (m.index > last) parts.push({ kind: "text", text: body.slice(last, m.index) });
    parts.push({ kind: "mention", type, id, name: (type === "user" ? names.users[id] : names.groups[id]) ?? "unknown" });
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push({ kind: "text", text: body.slice(last) });
  return parts;
}
