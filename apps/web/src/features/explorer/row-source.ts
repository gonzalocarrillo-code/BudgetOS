import { LIVE_LEAVES, type FilterGroupT, type Predicate, type QueryResponse, type QueryRow } from "@budget/domain";
import type { RowSource } from "@budget/grid";
import { t } from "@budget/ui/i18n";
import { api, unwrap } from "../../lib/api.js";

/**
 * The Explorer's RowSource (spec §18.2), over POST /workspaces/:ws/query. Every query ANDs the
 * live-leaf filter (ADR-016: parents are caps and never count twice), so the tree, the pivot and
 * the totals row sum the same envelopes. The server groups, sorts and totals; nothing is summed here.
 *
 * - tree: one level per hierarchy-template key. A node's children are the next level's groups
 *   under its prefix (eq on each ancestor, is_empty for "none"); below the last key, the envelopes.
 *   Expanded node keys live in the URL (`expanded`).
 * - pivot: the groups of `groupBy`, or the envelopes themselves when groupBy is empty.
 */

export const NONE = "∅";
export type ExplorerRow = QueryRow & { hasChildren: boolean; expanded: boolean; level: number; name: string };

export interface ExplorerQuery {
  ws: string;
  view: "tree" | "pivot";
  filter: FilterGroupT;
  period: unknown;
  measures: string[];
  asOf?: string | undefined;
  /** tree: the hierarchy template's path. */
  levels: string[];
  /** pivot: grouping keys (empty = envelopes). */
  groupBy: string[];
  expanded: string[];
  sort: Array<{ key: string; dir: "asc" | "desc" }>;
}

type Labels = (dimension: string, code: string) => string;

const PAGE = 1000;
const prefix = (keys: string[], segments: string[]): Predicate[] =>
  keys.map((key, i) => (segments[i] === NONE ? { field: { kind: "dimension", key }, op: "is_empty" } : { field: { kind: "dimension", key }, op: "eq", value: segments[i] as string }));

export class ExplorerRowSource implements RowSource {
  private roots: ExplorerRow[] = [];
  private readonly children = new Map<string, ExplorerRow[]>();
  private readonly expanded: Set<string>;
  private flat: ExplorerRow[] = [];
  private listeners = new Set<() => void>();
  private ready: Promise<void>;
  totals: QueryResponse["totals"] = {};
  dataVersion = "0";

  constructor(
    private readonly q: ExplorerQuery,
    private readonly labels: Labels,
    private readonly onExpandedChange: (keys: string[]) => void,
    private readonly onLoaded: (s: ExplorerRowSource) => void = () => undefined,
  ) {
    this.expanded = new Set(q.expanded);
    this.ready = this.load();
  }

  private filterWith(extra: Predicate[]): FilterGroupT {
    const own = this.q.filter.children.length ? [this.q.filter] : [];
    return { logic: "and", children: [...LIVE_LEAVES, ...own, ...extra] };
  }

  /** Every page of one query (a level of the tree or the pivot; the golden workspace is small, T-034 measures the large one). */
  private async all(groupBy: string[], extra: Predicate[], sort = this.q.sort): Promise<{ rows: QueryRow[]; totals: QueryResponse["totals"]; dataVersion: number }> {
    const rows: QueryRow[] = [];
    let cursor: string | null = null;
    let last: QueryResponse | undefined;
    do {
      const body = { workspaceId: this.q.ws, filter: this.filterWith(extra), groupBy, measures: this.q.measures, period: this.q.period, sort, limit: PAGE, ...(this.q.asOf ? { asOf: this.q.asOf } : {}), ...(cursor ? { cursor } : {}) };
      last = (await unwrap(api.POST("/api/v1/workspaces/{ws}/query", { params: { path: { ws: this.q.ws } }, body: body as never }))) as QueryResponse;
      rows.push(...last.rows);
      cursor = last.nextCursor;
    } while (cursor);
    return { rows, totals: last?.totals ?? {}, dataVersion: last?.dataVersion ?? 0 };
  }

  private groupRows(rows: QueryRow[], keys: string[], parentSegments: string[]): ExplorerRow[] {
    const depth = keys.length;
    const key = keys[depth - 1] as string;
    return rows.map((r) => {
      const segment = r.dimensions[key] ?? NONE;
      const segments = [...parentSegments, segment];
      const nodeKey = segments.join("/");
      return { ...r, key: nodeKey, path: segments, level: depth - 1, name: segment === NONE ? t("explorer.none") : this.labels(key, segment), hasChildren: true, expanded: this.expanded.has(nodeKey) };
    });
  }

  private envelopeRows(rows: QueryRow[], level: number): ExplorerRow[] {
    return rows.map((r) => ({ ...r, key: r.envelopeId ?? r.key, level, name: r.path.at(-1) ?? "", hasChildren: false, expanded: false }));
  }

  private async childrenOf(node: ExplorerRow): Promise<ExplorerRow[]> {
    const segments = node.path;
    const depth = segments.length;
    const levels = this.q.levels;
    const extra = prefix(levels.slice(0, depth), segments);
    if (depth < levels.length) {
      const keys = levels.slice(0, depth + 1);
      return this.groupRows((await this.all(keys, extra, [])).rows, keys, segments);
    }
    return this.envelopeRows((await this.all([], extra, [{ key: "name", dir: "asc" }])).rows, depth);
  }

  private async load(): Promise<void> {
    if (this.q.view === "pivot") {
      const res = await this.all(this.q.groupBy, []);
      this.totals = res.totals;
      this.dataVersion = String(res.dataVersion);
      this.roots = this.q.groupBy.length
        ? res.rows.map((r) => ({ ...r, level: 0, name: this.q.groupBy.map((k) => (r.dimensions[k] ?? NONE) === NONE ? t("explorer.none") : this.labels(k, r.dimensions[k] as string)).join(" · "), hasChildren: false, expanded: false }))
        : this.envelopeRows(res.rows, 0);
    } else if (this.q.levels.length === 0) {
      const res = await this.all([], [], [{ key: "name", dir: "asc" }]);
      Object.assign(this, { totals: res.totals, dataVersion: String(res.dataVersion) });
      this.roots = this.envelopeRows(res.rows, 0);
    } else {
      const keys = this.q.levels.slice(0, 1);
      const res = await this.all(keys, [], []);
      this.totals = res.totals;
      this.dataVersion = String(res.dataVersion);
      this.roots = this.groupRows(res.rows, keys, []);
      // Re-open what the URL says is expanded, parents first.
      const open = async (rows: ExplorerRow[]) => {
        for (const r of rows) {
          if (!r.hasChildren || !this.expanded.has(r.key)) continue;
          const kids = await this.childrenOf(r);
          this.children.set(r.key, kids);
          await open(kids);
        }
      };
      await open(this.roots);
    }
    this.rebuild();
    this.onLoaded(this);
  }

  private rebuild(): void {
    const out: ExplorerRow[] = [];
    const walk = (rows: ExplorerRow[]) => {
      for (const r of rows) {
        const expanded = r.hasChildren && this.expanded.has(r.key);
        out.push({ ...r, expanded });
        if (expanded) walk(this.children.get(r.key) ?? []);
      }
    };
    walk(this.roots);
    this.flat = out;
  }

  get total(): number {
    return this.flat.length;
  }

  rowAt(index: number): ExplorerRow | undefined {
    return this.flat[index];
  }

  async getRows(range: { start: number; end: number }) {
    await this.ready;
    return { rows: this.flat.slice(range.start, range.end), total: this.flat.length, dataVersion: this.dataVersion };
  }

  async toggle(nodeKey: string) {
    await this.ready;
    if (this.expanded.has(nodeKey)) this.expanded.delete(nodeKey);
    else {
      const node = this.flat.find((r) => r.key === nodeKey);
      if (!node?.hasChildren) return { total: this.flat.length };
      this.expanded.add(nodeKey);
      if (!this.children.has(nodeKey)) this.children.set(nodeKey, await this.childrenOf(node));
    }
    this.rebuild();
    this.onExpandedChange([...this.expanded]);
    this.onLoaded(this);
    this.listeners.forEach((l) => l());
    return { total: this.flat.length };
  }

  subscribe(onInvalidate: () => void): () => void {
    this.listeners.add(onInvalidate);
    return () => this.listeners.delete(onInvalidate);
  }
}
