import { DomainError, type FamilyInput, type FamilyMember, type FamilyPlan, type FamilySum } from "@budget/domain";
import { Decimal } from "decimal.js";

/**
 * The family plan (ADR-039), pure: a parent's new amount and how each direct child follows it, then
 * down the tree — a child whose amount changes carries its own percent children with it; manual
 * children keep their amount. Percent shares are split by largest remainder, so shares that add up
 * to 100 % add up to the parent to the cent.
 */

export interface Node {
  id: string;
  name: string;
  parentId: string | null;
  currency: string;
  status: string;
  /** The open draft's amount, else the approved one; null when neither exists. */
  amount: string | null;
  rule: { mode: "percent" | "manual"; pct: string | null } | null;
  children: string[];
  /** The approved amount alone (null when never approved); `amount` when not given. */
  approved?: string | null;
  /** An open draft or a pending request. */
  proposed?: boolean;
}

const HUNDRED = new Decimal(100);
const same = (a: Decimal | null, b: Decimal | null) => (a === null || b === null ? a === b : a.equals(b));

/** Cents for each share of `total`, adding up to round(total × Σpct / 100) exactly. */
export function splitByPercent(total: Decimal, shares: Array<{ id: string; pct: Decimal }>): Map<string, Decimal> {
  const cents = total.times(100);
  const target = shares.reduce((s, x) => s.plus(x.pct), new Decimal(0)).div(HUNDRED).times(cents).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const raw = shares.map((x) => ({ id: x.id, exact: cents.times(x.pct).div(HUNDRED) }));
  const floors = raw.map((r) => ({ id: r.id, cents: r.exact.floor(), frac: r.exact.minus(r.exact.floor()) }));
  let left = target.minus(floors.reduce((s, f) => s.plus(f.cents), new Decimal(0))).toNumber();
  for (const f of [...floors].sort((a, b) => b.frac.comparedTo(a.frac) || (a.id < b.id ? -1 : 1))) {
    if (left <= 0) break;
    f.cents = f.cents.plus(1);
    left -= 1;
  }
  return new Map(floors.map((f) => [f.id, f.cents.div(100)]));
}

function sumOf(parentId: string, parentAmount: Decimal, children: Decimal[]): FamilySum {
  const total = children.reduce((s, x) => s.plus(x), new Decimal(0));
  const unallocated = parentAmount.minus(total);
  return { parentId, parentAmount: parentAmount.toFixed(2), childrenTotal: total.toFixed(2), unallocated: unallocated.toFixed(2), status: unallocated.isZero() ? "balanced" : unallocated.gt(0) ? "under" : "over" };
}

export function planFamily(nodes: Map<string, Node>, rootId: string, input: FamilyInput | null): FamilyPlan {
  const root = nodes.get(rootId);
  if (!root) throw new DomainError("NOT_FOUND", "Envelope not found", { id: rootId });
  const after = new Map<string, Decimal | null>();
  const mode = new Map<string, { mode: "percent" | "manual"; pct: string | null } | null>();
  const dec = (v: string | null) => (v === null ? null : new Decimal(v));
  for (const n of nodes.values()) {
    after.set(n.id, dec(n.amount));
    mode.set(n.id, n.rule);
  }
  const given = new Map((input?.children ?? []).map((c) => [c.envelopeId, c]));
  for (const id of given.keys()) if (!root.children.includes(id)) throw new DomainError("VALIDATION", "Only the parent's own children can be set here", { envelopeId: id });
  if (input) after.set(rootId, new Decimal(input.parentAmount));

  const sums: FamilySum[] = [];
  const touched = new Set<string>();
  // Parents to (re)allocate, top down: the root, then every child whose amount changes.
  const queue = [rootId];
  while (queue.length) {
    const pid = queue.shift() as string;
    const parent = nodes.get(pid) as Node;
    const parentAfter = after.get(pid) ?? null;
    const changed = !same(dec(parent.amount), parentAfter);
    const percents: Array<{ id: string; pct: Decimal }> = [];
    for (const cid of parent.children) {
      const child = nodes.get(cid) as Node;
      const spec = pid === rootId ? given.get(cid) : undefined;
      if (spec) {
        if (spec.mode === "percent" && child.currency !== parent.currency) throw new DomainError("VALIDATION", "A child in another currency follows its parent only manually", { envelopeId: cid, currency: child.currency, parentCurrency: parent.currency });
        mode.set(cid, { mode: spec.mode, pct: spec.mode === "percent" ? new Decimal(spec.pct as string).toFixed(6).replace(/\.?0+$/, "") : null });
        if (spec.mode === "manual") after.set(cid, new Decimal(spec.amount as string));
      }
      const rule = mode.get(cid) ?? null;
      // A percent child follows its parent when the parent changes (or its share was just set).
      if (rule?.mode === "percent" && rule.pct !== null && child.currency === parent.currency && (changed || spec)) percents.push({ id: cid, pct: new Decimal(rule.pct) });
    }
    if (parentAfter !== null && percents.length) for (const [cid, amt] of splitByPercent(parentAfter, percents)) after.set(cid, amt);
    if (parent.children.length && parentAfter !== null && (pid === rootId || changed)) {
      sums.push(sumOf(pid, parentAfter, parent.children.map((cid) => after.get(cid) ?? new Decimal(0))));
    }
    for (const cid of parent.children) {
      const child = nodes.get(cid) as Node;
      const now = after.get(cid) ?? null;
      const moved = !same(dec(child.amount), now);
      if (moved) touched.add(cid);
      if (moved && child.children.length) queue.push(cid);
    }
  }

  const member = (n: Node, level: number): FamilyMember => {
    const a = after.get(n.id) ?? null;
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    const rule = mode.get(n.id) ?? null;
    return {
      envelopeId: n.id,
      name: n.name,
      parentId: n.parentId,
      level,
      currency: n.currency,
      status: n.status,
      mode: rule?.mode ?? null,
      pct: rule?.pct ?? null,
      before: n.amount,
      after: a === null ? null : a.toFixed(2),
      changed: !same(dec(n.amount), a),
      childCount: n.children.length,
      sameCurrency: parent === undefined || parent.currency === n.currency,
    };
  };
  // The parent's direct children always; deeper members only where the plan changes them.
  const members: FamilyMember[] = [];
  const walk = (id: string, level: number) => {
    for (const cid of (nodes.get(id) as Node).children) {
      const n = nodes.get(cid) as Node;
      if (level === 1 || touched.has(cid)) members.push(member(n, level));
      if (touched.has(cid)) walk(cid, level + 1);
    }
  };
  walk(rootId, 1);
  // Approved amounts only, as the family stands today; the drafts and pending requests are the "proposed" sums above.
  const approvedOf = (n: Node) => (n.approved === undefined ? n.amount : n.approved);
  const rootApproved = approvedOf(root);
  const kids = root.children.map((cid) => nodes.get(cid) as Node);
  const approvedSum = root.children.length && rootApproved !== null ? sumOf(rootId, new Decimal(rootApproved), kids.map((k) => new Decimal(approvedOf(k) ?? 0))) : null;
  const proposals = [root, ...kids].filter((n) => n.proposed === true).length;
  return { parent: member(root, 0), members, sums, approvedSum, proposals };
}
