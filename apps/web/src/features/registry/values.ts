import type { DimensionValue } from "../../lib/queries.js";

/** `Market tier` → `market_tier` (a dimension key: /^[a-z][a-z0-9_]{1,40}$/). */
export function toKey(label: string): string {
  const k = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[0-9_]+/, "")
    .slice(0, 41);
  return k.length >= 2 ? k : "";
}

/** `Non-brand` → `non_brand` (a value code: /^[A-Za-z0-9_]{1,80}$/). */
export function toCode(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export interface ValueLine {
  code: string;
  label: string;
  parentCode?: string;
}

/**
 * The "add values" box: one value per line; `Parent > Child > Grandchild` nests (each level is
 * created if new, and an existing value is found by its label or code); `code = Label` sets the code.
 * Parents come before children, and a value appears once.
 */
export function parseValueLines(text: string, existing: Array<Pick<DimensionValue, "code" | "label">> = []): ValueLine[] {
  const known = new Map<string, string>(); // lower(label or code) → code
  for (const v of existing) {
    known.set(v.label.toLowerCase(), v.code);
    known.set(v.code.toLowerCase(), v.code);
  }
  const out: ValueLine[] = [];
  const added = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    let parent: string | undefined;
    for (const part of raw.split(">").map((p) => p.trim()).filter(Boolean)) {
      const m = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(part);
      const label = (m?.[2] ?? part).trim();
      const code = m?.[1] ?? known.get(label.toLowerCase()) ?? toCode(label);
      if (!code) break;
      if (!added.has(code) && !existing.some((v) => v.code === code)) {
        out.push({ code, label, ...(parent ? { parentCode: parent } : {}) });
        added.add(code);
      }
      known.set(label.toLowerCase(), code);
      parent = code;
    }
  }
  return out;
}

export interface TreeNode {
  value: DimensionValue;
  depth: number;
}

/** Values in tree order (parents first, children under them, by label), each with its depth. */
export function flattenTree(values: DimensionValue[]): TreeNode[] {
  const byParent = new Map<string | null, DimensionValue[]>();
  const ids = new Set(values.map((v) => v.id));
  for (const v of values) {
    const p = v.parentValueId && ids.has(v.parentValueId) ? v.parentValueId : null;
    byParent.set(p, [...(byParent.get(p) ?? []), v]);
  }
  const out: TreeNode[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const v of (byParent.get(parent) ?? []).sort((a, b) => a.label.localeCompare(b.label))) {
      out.push({ value: v, depth });
      walk(v.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The value and everything under it (a value cannot move into its own subtree). */
export function subtreeIds(values: DimensionValue[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const v of values) {
      if (v.parentValueId && out.has(v.parentValueId) && !out.has(v.id)) {
        out.add(v.id);
        grew = true;
      }
    }
  }
  return out;
}
