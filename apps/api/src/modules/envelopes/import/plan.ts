import { BUDGET_IMPORT_COLUMNS, BUDGET_IMPORT_MAX_ROWS, DomainError, canInScope, nearestCode, normTerm, type BudgetImportLine, type BudgetImportOverCap, type BudgetImportParent } from "@budget/domain";
import { importEnvelopesById, importEnvelopesByTuple, liveChildrenApproved, type ImportEnvelope, type Tx } from "@budget/db";
import { loadRegistry, type RegistryIndex } from "@budget/workers";
import { Decimal } from "decimal.js";
import { envelopeScopeTargets, scopeTargetForValues } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { validateTuple } from "../../registry/commands/validate-tuple.js";
import { parseCsv } from "../bulk/csv.js";
import { resolveFx } from "../fx.js";
import { checkPhasing } from "../commands/version-writer.js";

/**
 * The budget import's plan (docs/DATA_PLAN.md §3, D-008): a CSV read against the workspace's
 * registry and budgets. Preview and commit both build it, in their own transaction, so a commit
 * re-checks everything instead of trusting a stored plan.
 *
 * - One row per budget. Headers are granularity keys or labels, the template's columns, and months
 *   (yyyy-MM) for phasing; a row whose first cell starts with # is a comment.
 * - A row with `envelope_id`, or whose granularities and dates are a live budget's, edits that
 *   budget: `change` when the amount differs, `same` when it does not. Any other row is `new`.
 * - A new row's parents come from `parent_key` (another row's `key`, or a budget id), else from the
 *   hierarchy template: each shorter prefix of its granularities, in the template's order, is a
 *   parent, matched to a live budget covering the row's dates or created, holding the sum of what
 *   the import puts under it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^\d{1,16}(\.\d{1,2})?$/;
const MONTH = /^\d{4}-\d{2}$/;
/** "1,500.00" is 1500.00; "12,5" is not a number here (a comma is only a thousands separator). */
const plainAmount = (v: string) => (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(v) ? v.replace(/,/g, "") : v);
const FIXED = new Set<string>(BUDGET_IMPORT_COLUMNS);

export interface PlannedNode {
  /** A key inside the plan: `row:<line>` for a row's budget, `parent:<tuple>|<currency>` for a created parent. */
  ref: string;
  kind: "leaf" | "parent";
  line: number | null;
  name: string;
  dimensionValues: Record<string, string>;
  currency: string;
  amount: Decimal;
  startDate: string;
  endDate: string;
  phasing: Array<{ month: string; amount: string }> | undefined;
  rationale: string | undefined;
  /** Where it goes: an existing budget, another planned node, or the top. */
  parent: { envelopeId: string } | { ref: string } | null;
  depth: number;
}

export interface PlannedChange {
  line: number;
  envelope: ImportEnvelope;
  amount: Decimal;
  phasing: Array<{ month: string; amount: string }> | undefined;
  rationale: string | undefined;
}

export interface ImportPlan {
  lines: BudgetImportLine[];
  nodes: PlannedNode[];
  changes: PlannedChange[];
  overCap: BudgetImportOverCap[];
  unknownColumns: string[];
  reporting: string;
  totals: { new: Decimal; change: Decimal };
  rates: Map<string, Decimal>;
  /** Names of the existing budgets the plan refers to. */
  names: Map<string, string>;
}

interface Dim {
  id: string;
  key: string;
  label: string;
}

const label = (d: Record<string, string>, order: string[]) => [...order.filter((k) => d[k] !== undefined), ...Object.keys(d).filter((k) => !order.includes(k)).sort()].map((k) => d[k]).join(" ");
const tupleKey = (d: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(d).sort(([a], [b]) => a.localeCompare(b))));

export async function buildImportPlan(tx: Tx, auth: AuthContext, workspaceId: string, csv: string, templateId: string | undefined): Promise<ImportPlan> {
  const table = parseCsv(csv).filter((r) => !(r[0] ?? "").trim().startsWith("#"));
  const [headerRow, ...body] = table;
  if (!headerRow) throw new DomainError("VALIDATION", "The file is empty");
  if (body.length > BUDGET_IMPORT_MAX_ROWS) throw new DomainError("VALIDATION", `At most ${BUDGET_IMPORT_MAX_ROWS} rows per import`, { rows: body.length });
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { reportingCurrency: true } });

  // The registry: dimensions (a workspace one shadows an org one), values by code, alias, external id and label.
  const dimRows = await tx.dimension.findMany({ where: { orgId: auth.user.orgId, isActive: true, OR: [{ workspaceId: null }, { workspaceId }] }, select: { id: true, key: true, label: true, workspaceId: true } });
  const dims = new Map<string, Dim>();
  for (const d of dimRows) if (!dims.has(d.key) || d.workspaceId !== null) dims.set(d.key, { id: d.id, key: d.key, label: d.label });
  const registry: RegistryIndex = await loadRegistry(tx, auth.user.orgId, workspaceId);
  const values = await tx.dimensionValue.findMany({ where: { dimensionId: { in: [...dims.values()].map((d) => d.id) }, isActive: true }, select: { dimensionId: true, code: true, label: true, aliases: true } });
  const keyOfDim = new Map([...dims.values()].map((d) => [d.id, d.key]));
  const byLabel = new Map<string, Map<string, string>>();
  const candidates = new Map<string, Array<{ code: string; names: string[] }>>();
  for (const v of values) {
    const k = keyOfDim.get(v.dimensionId) as string;
    if (!byLabel.has(k)) byLabel.set(k, new Map());
    byLabel.get(k)?.set(normTerm(v.label), v.code);
    candidates.set(k, [...(candidates.get(k) ?? []), { code: v.code, names: [v.code, v.label, ...v.aliases] }]);
  }
  const template = templateId
    ? await tx.hierarchyTemplate.findFirst({ where: { id: templateId, workspaceId } })
    : await tx.hierarchyTemplate.findFirst({ where: { workspaceId, isDefault: true } });
  if (templateId && !template) throw new DomainError("NOT_FOUND", "Hierarchy template not found");
  const order = template?.path ?? [];

  // Columns: a template column, a month, or a granularity by key or label.
  const header = headerRow.map((h) => h.trim());
  const columnOf = new Map<number, { kind: "fixed"; name: string } | { kind: "dim"; key: string } | { kind: "month"; month: string }>();
  const unknownColumns: string[] = [];
  header.forEach((h, i) => {
    const lower = h.toLowerCase();
    if (FIXED.has(lower)) return void columnOf.set(i, { kind: "fixed", name: lower });
    if (MONTH.test(h)) return void columnOf.set(i, { kind: "month", month: `${h}-01` });
    const dim = [...dims.values()].find((d) => normTerm(d.key) === normTerm(h) || normTerm(d.label) === normTerm(h));
    if (dim) return void columnOf.set(i, { kind: "dim", key: dim.key });
    if (h !== "") unknownColumns.push(h);
  });
  for (const need of ["currency", "amount", "start_date", "end_date"]) {
    if (![...columnOf.values()].some((c) => c.kind === "fixed" && c.name === need)) throw new DomainError("VALIDATION", `The file needs a ${need} column (download the template)`, { missing: need });
  }

  const rates = new Map<string, Decimal>();
  const rateOf = async (currency: string): Promise<Decimal | null> => {
    if (!rates.has(currency)) {
      try {
        rates.set(currency, (await resolveFx(tx, currency, workspaceId)).rate);
      } catch {
        return null;
      }
    }
    return rates.get(currency) ?? null;
  };

  // Pass 1: read every row.
  type Row = { line: number; cells: Map<string, string>; dimensionValues: Record<string, string>; months: Array<{ month: string; amount: string }>; problems: BudgetImportLine["problems"] };
  const rows: Row[] = body.map((r, i) => {
    const row: Row = { line: i + 2, cells: new Map(), dimensionValues: {}, months: [], problems: [] };
    header.forEach((_, j) => {
      const c = columnOf.get(j);
      const v = (r[j] ?? "").trim();
      if (!c || v === "") return;
      if (c.kind === "fixed") row.cells.set(c.name, v);
      else if (c.kind === "month") row.months.push({ month: c.month, amount: plainAmount(v) });
      else {
        const hit = registry.resolve(c.key, v);
        const code = "error" in hit ? byLabel.get(c.key)?.get(normTerm(v)) : hit.code;
        if (code) row.dimensionValues[c.key] = code;
        else row.problems.push({ column: header[j] ?? c.key, message: `${dims.get(c.key)?.label ?? c.key} "${v}" is not in the registry`, suggestion: nearestCode(v, candidates.get(c.key) ?? []) });
      }
    });
    return row;
  });

  // Existing budgets: by id, and by granularities (then dates).
  const ids = rows.map((r) => r.cells.get("envelope_id")).filter((v): v is string => v !== undefined && UUID.test(v));
  const parentIds = rows.map((r) => r.cells.get("parent_key")).filter((v): v is string => v !== undefined && UUID.test(v));
  const byId = new Map((await importEnvelopesById(tx, [...new Set([...ids, ...parentIds])])).map((e) => [e.id, e]));
  const tuples = rows.map((r) => r.dimensionValues);
  const byTuple = new Map<number, ImportEnvelope[]>();
  for (const e of await importEnvelopesByTuple(tx, workspaceId, tuples.filter((t) => Object.keys(t).length > 0))) {
    // index back to the row: tuples were filtered, so map by tuple
    const t = tupleKey(e.dimensionValues);
    rows.forEach((r, i) => {
      if (tupleKey(r.dimensionValues) === t) byTuple.set(i, [...(byTuple.get(i) ?? []).filter((x) => x.id !== e.id), e]);
    });
  }

  const lines: BudgetImportLine[] = [];
  const nodes: PlannedNode[] = [];
  const changes: PlannedChange[] = [];
  const seen = new Set<string>();
  const rowNode = new Map<string, { line: number; ref: string } | { envelopeId: string }>(); // key column → where it is

  for (const [i, r] of rows.entries()) {
    const get = (k: string) => r.cells.get(k);
    const problem = (column: string | null, message: string, suggestion: string | null = null) => r.problems.push({ column, message, suggestion });
    const currency = get("currency")?.toUpperCase() ?? null;
    const amountRaw = get("amount") !== undefined ? plainAmount(get("amount") as string) : null;
    const startDate = get("start_date") ?? null;
    const endDate = get("end_date") ?? null;
    if (!currency || !/^[A-Z]{3}$/.test(currency)) problem("currency", "currency must be a 3-letter ISO code");
    else if ((await rateOf(currency)) === null) problem("currency", `No FX rate ${currency}→${ws.reportingCurrency}`);
    if (!amountRaw || !MONEY.test(amountRaw)) problem("amount", "amount must be a plain number with at most 2 decimals, not negative");
    if (!startDate || !DATE.test(startDate)) problem("start_date", "start_date must be YYYY-MM-DD");
    if (!endDate || !DATE.test(endDate)) problem("end_date", "end_date must be YYYY-MM-DD");
    if (startDate && endDate && DATE.test(startDate) && DATE.test(endDate) && startDate > endDate) problem("end_date", "end_date is before start_date");
    for (const m of r.months) if (!MONEY.test(m.amount)) problem(m.month.slice(0, 7), `${m.month.slice(0, 7)} must be a plain number`);
    const amount = amountRaw && MONEY.test(amountRaw) ? new Decimal(amountRaw) : null;
    const phasing = r.months.length ? r.months.filter((m) => MONEY.test(m.amount)).map((m) => ({ month: m.month, amount: new Decimal(m.amount).toFixed(2) })) : undefined;
    if (amount && phasing && startDate && endDate && DATE.test(startDate) && DATE.test(endDate)) {
      try {
        checkPhasing(amount, phasing, { startDate, endDate });
      } catch (e) {
        problem(null, e instanceof DomainError ? e.message : String(e));
      }
    }

    // Which budget the row is.
    const idCell = get("envelope_id");
    let existing: ImportEnvelope | null = null;
    if (idCell) {
      existing = UUID.test(idCell) ? (byId.get(idCell) ?? null) : null;
      if (!existing) problem("envelope_id", `No live budget ${idCell}`);
      else for (const [k, v] of Object.entries(r.dimensionValues)) if (existing.dimensionValues[k] !== v) problem(header.find((h) => normTerm(h) === normTerm(k) || normTerm(h) === normTerm(dims.get(k)?.label ?? "")) ?? k, `envelope_id's ${k} is ${existing.dimensionValues[k] ?? "not set"}, not ${v}`);
    } else if (startDate && endDate) {
      existing = (byTuple.get(i) ?? []).find((e) => e.startDate === startDate && e.endDate === endDate) ?? null;
    }
    if (existing?.ended) problem(null, `${existing.name} has ended; reintroduce it instead`);
    if (existing?.status === "LOCKED") problem(null, `${existing.name} is in a closed period`);
    if (existing?.status === "PENDING") problem(null, `${existing.name} has a change waiting for approval; decide it first`);
    if (!idCell && Object.keys(r.dimensionValues).length === 0 && r.problems.every((p) => !p.message.includes("registry"))) problem(null, "A new budget needs at least one granularity");
    const dupKey = existing ? `id:${existing.id}` : `${tupleKey(r.dimensionValues)}|${startDate}|${endDate}`;
    if (seen.has(dupKey)) problem(null, "The same budget appears on an earlier line");
    seen.add(dupKey);

    // Scope: the caller may create here, or edit that budget.
    if (!auth.isOrgAdmin && r.problems.length === 0) {
      if (existing) {
        const target = (await envelopeScopeTargets(tx, [existing.id])).get(existing.id) ?? { dims: {} };
        if (!canInScope(auth.assignments, "envelope.edit_draft", target)) problem(null, `Outside your scope: you cannot edit ${existing.name}`);
      } else {
        try {
          const { valueIds } = await validateTuple(tx, workspaceId, r.dimensionValues);
          const pairs = Object.entries(valueIds).map(([k, valueId]) => ({ dimensionId: dims.get(k)?.id as string, valueId }));
          if (!canInScope(auth.assignments, "envelope.create", await scopeTargetForValues(tx, pairs))) problem(null, "Outside your scope: you cannot create a budget with these granularities");
        } catch (e) {
          problem(null, e instanceof DomainError ? e.message : String(e));
        }
      }
    } else if (!existing && r.problems.length === 0) {
      try {
        await validateTuple(tx, workspaceId, r.dimensionValues);
      } catch (e) {
        problem(null, e instanceof DomainError ? e.message : String(e));
      }
    }

    const name = get("name") ?? existing?.name ?? label(r.dimensionValues, order);
    const status: BudgetImportLine["status"] = r.problems.length ? "error" : existing ? (amount && existing.amount !== null && amount.equals(existing.amount) && !phasing ? "same" : "change") : "new";
    lines.push({ line: r.line, status, envelopeId: existing?.id ?? null, name, dimensionValues: r.dimensionValues, currency, amount: amount?.toFixed(2) ?? null, currentAmount: existing?.amount ?? null, startDate, endDate, parent: null, problems: r.problems });
    const key = get("key");
    if (status === "change" && existing && amount) changes.push({ line: r.line, envelope: existing, amount, phasing, rationale: get("rationale") });
    if (status === "new" && amount && currency && startDate && endDate) {
      const ref = `row:${r.line}`;
      nodes.push({ ref, kind: "leaf", line: r.line, name, dimensionValues: r.dimensionValues, currency, amount, startDate, endDate, phasing, rationale: get("rationale"), parent: null, depth: 0 });
      if (key) rowNode.set(key, { line: r.line, ref });
    } else if (existing && key) rowNode.set(key, { envelopeId: existing.id });
  }

  // Parents of the new rows: parent_key, else the hierarchy template.
  const planned = new Map<string, PlannedNode>();
  const coverTuples: Array<Record<string, string>> = [];
  const leaves = nodes.filter((n) => n.kind === "leaf");
  const prefixesOf = (d: Record<string, string>) => {
    const present = order.filter((k) => d[k] !== undefined);
    const out: Array<Record<string, string>> = [];
    for (let n = 1; n < present.length + 1; n += 1) {
      const t = Object.fromEntries(present.slice(0, n).map((k) => [k, d[k] as string]));
      if (Object.keys(t).length < Object.keys(d).length) out.push(t);
    }
    return out; // shortest first; never the leaf's own tuple
  };
  for (const leaf of leaves) for (const p of prefixesOf(leaf.dimensionValues)) coverTuples.push(p);
  const covering = new Map<string, ImportEnvelope[]>();
  for (const e of await importEnvelopesByTuple(tx, workspaceId, coverTuples)) covering.set(tupleKey(e.dimensionValues), [...(covering.get(tupleKey(e.dimensionValues)) ?? []).filter((x) => x.id !== e.id), e]);
  const lineOf = (n: PlannedNode) => lines.find((l) => l.line === n.line) as BudgetImportLine;

  for (const leaf of leaves) {
    const r = rows.find((x) => x.line === leaf.line) as Row;
    const pk = r.cells.get("parent_key");
    if (pk) {
      const target = UUID.test(pk) ? (byId.get(pk) ? { envelopeId: pk } : null) : (rowNode.get(pk) ?? null);
      if (target === null) lineOf(leaf).problems.push({ column: "parent_key", message: `parent_key "${pk}" is neither a row's key nor a live budget` });
      else if ("line" in target && target.line === leaf.line) lineOf(leaf).problems.push({ column: "parent_key", message: "A row cannot be its own parent" });
      else leaf.parent = "ref" in target ? { ref: target.ref } : { envelopeId: target.envelopeId };
      continue;
    }
    // Deepest prefix first: the first live budget that covers the dates is where the new branch hangs.
    const prefixes = prefixesOf(leaf.dimensionValues).reverse();
    let child: PlannedNode = leaf;
    for (const p of prefixes) {
      const live = (covering.get(tupleKey(p)) ?? []).find((e) => e.startDate <= leaf.startDate && e.endDate >= leaf.endDate);
      if (live) {
        child.parent = { envelopeId: live.id };
        break;
      }
      const ref = `parent:${tupleKey(p)}|${leaf.currency}|${leaf.startDate.slice(0, 4)}`;
      let node = planned.get(ref);
      if (!node) {
        node = { ref, kind: "parent", line: null, name: label(p, order), dimensionValues: p, currency: leaf.currency, amount: new Decimal(0), startDate: leaf.startDate, endDate: leaf.endDate, phasing: undefined, rationale: undefined, parent: null, depth: 0 };
        planned.set(ref, node);
        nodes.push(node);
      }
      child.parent = { ref };
      child = node;
    }
  }

  // Created parents hold the sum of what sits under them, span their children's dates, share one
  // currency. Only rows without problems count; a child whose parent row has a problem gets one too.
  const byRef = new Map(nodes.map((n) => [n.ref, n]));
  const depthOf = (n: PlannedNode, guard = 0): number => (n.parent && "ref" in n.parent && guard < 32 ? 1 + depthOf(byRef.get(n.parent.ref) as PlannedNode, guard + 1) : 0);
  for (const n of nodes) n.depth = depthOf(n);
  const bad = (n: PlannedNode) => n.line !== null && lineOf(n).problems.length > 0;
  for (let pass = 0; pass < 32; pass += 1) {
    let spread = false;
    for (const n of nodes) {
      if (n.kind !== "leaf" || bad(n) || !(n.parent && "ref" in n.parent)) continue;
      const up = byRef.get(n.parent.ref) as PlannedNode;
      if (up.kind === "leaf" && bad(up)) {
        lineOf(n).problems.push({ column: "parent_key", message: `Its parent (line ${up.line}) has a problem` });
        spread = true;
      }
    }
    if (!spread) break;
  }
  const aggregate = () => {
    for (const n of nodes) if (n.kind === "parent") Object.assign(n, { amount: new Decimal(0), startDate: "9999-12-31", endDate: "0000-01-01", used: false });
    for (const n of [...nodes].sort((a, b) => b.depth - a.depth)) {
      const counts = n.kind === "leaf" ? !bad(n) : (n as PlannedNode & { used?: boolean }).used === true;
      if (!counts || !(n.parent && "ref" in n.parent)) continue;
      const p = byRef.get(n.parent.ref) as PlannedNode & { used?: boolean };
      if (p.kind !== "parent") continue; // a row's own amount is its own
      if (p.used && p.currency !== n.currency && n.line !== null) {
        lineOf(n).problems.push({ column: "currency", message: `Budgets under ${p.name} use ${p.currency}; this one is ${n.currency}` });
        continue;
      }
      p.currency = n.currency;
      p.used = true;
      p.amount = p.amount.plus(n.amount);
      if (n.startDate < p.startDate) p.startDate = n.startDate;
      if (n.endDate > p.endDate) p.endDate = n.endDate;
    }
  };
  aggregate();
  aggregate(); // again without the rows the first pass found a mismatch on
  const usedParents = new Set(nodes.filter((n) => n.kind === "parent" && (n as PlannedNode & { used?: boolean }).used).map((n) => n.ref));
  for (const n of nodes) delete (n as PlannedNode & { used?: boolean }).used;

  // Existing parents: what the import adds under each must fit its budget.
  const added = new Map<string, Decimal>();
  const rep = (amount: Decimal, currency: string) => amount.mul(rates.get(currency) ?? 1);
  for (const n of nodes) {
    const counts = n.kind === "parent" ? usedParents.has(n.ref) : !bad(n);
    if (counts && n.parent && "envelopeId" in n.parent) added.set(n.parent.envelopeId, (added.get(n.parent.envelopeId) ?? new Decimal(0)).plus(rep(n.amount, n.currency)));
  }
  for (const c of changes) if (c.envelope.parentId) added.set(c.envelope.parentId, (added.get(c.envelope.parentId) ?? new Decimal(0)).plus(rep(c.amount, c.envelope.currency)).minus(c.envelope.amountReporting ?? 0));
  const parents = await importEnvelopesById(tx, [...added.keys()]);
  const children = await liveChildrenApproved(tx, [...added.keys()]);
  const overCap: BudgetImportOverCap[] = [];
  for (const p of parents) {
    if (p.allowOverAllocation || p.amountReporting === null) continue;
    const after = new Decimal(children.get(p.id) ?? 0).plus(added.get(p.id) ?? 0);
    if (after.gt(p.amountReporting)) overCap.push({ envelopeId: p.id, name: p.name, approved: new Decimal(p.amountReporting).toFixed(2), childrenAfter: after.toFixed(2) });
  }

  // Lines point at their parents; a line with a problem found late becomes an error.
  const nameOf = new Map<string, string>([...byId.values(), ...parents, ...[...covering.values()].flat()].map((e) => [e.id, e.name]));
  const where = (n: PlannedNode): BudgetImportLine["parent"] => {
    if (!n.parent) return null;
    if ("envelopeId" in n.parent) return { envelopeId: n.parent.envelopeId, name: nameOf.get(n.parent.envelopeId) ?? "" };
    return { envelopeId: null, name: (byRef.get(n.parent.ref) as PlannedNode).name };
  };
  for (const n of nodes) {
    if (n.line === null) continue;
    const l = lineOf(n);
    l.parent = where(n);
    if (l.problems.length) l.status = "error";
  }

  const ok = new Set(lines.filter((l) => l.status !== "error").map((l) => l.line));
  const keptNodes = nodes.filter((n) => (n.kind === "parent" ? usedParents.has(n.ref) : n.line !== null && ok.has(n.line)));
  const totals = {
    new: keptNodes.filter((n) => n.kind === "leaf").reduce((s, n) => s.plus(rep(n.amount, n.currency)), new Decimal(0)),
    change: changes.filter((c) => ok.has(c.line)).reduce((s, c) => s.plus(rep(c.amount, c.envelope.currency)).minus(c.envelope.amountReporting ?? 0), new Decimal(0)),
  };
  return { lines, nodes: keptNodes, changes: changes.filter((c) => ok.has(c.line)), overCap, unknownColumns, reporting: ws.reportingCurrency, totals, rates, names: nameOf };
}

/** The preview's view of the created parents. */
export function parentsOf(plan: ImportPlan): BudgetImportParent[] {
  const byRef = new Map(plan.nodes.map((n) => [n.ref, n]));
  return plan.nodes
    .filter((n) => n.kind === "parent")
    .sort((a, b) => a.depth - b.depth)
    .map((n) => ({
      name: n.name,
      dimensionValues: n.dimensionValues,
      currency: n.currency,
      amount: n.amount.toFixed(2),
      startDate: n.startDate,
      endDate: n.endDate,
      parent: n.parent === null ? null : "ref" in n.parent ? { envelopeId: null, name: (byRef.get(n.parent.ref) as PlannedNode).name } : { envelopeId: n.parent.envelopeId, name: plan.names.get(n.parent.envelopeId) ?? "" },
    }));
}
