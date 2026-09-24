import { z } from "zod";

export const RoleEnum = z.enum(["VIEWER", "PLANNER", "BUDGET_OWNER", "APPROVER", "FINANCE", "DATA_ADMIN", "WORKSPACE_ADMIN", "ORG_ADMIN"]);
export type Role =
  | "VIEWER"
  | "PLANNER"
  | "BUDGET_OWNER"
  | "APPROVER"
  | "FINANCE"
  | "DATA_ADMIN"
  | "WORKSPACE_ADMIN"
  | "ORG_ADMIN";
export type Action =
  | "envelope.read"
  | "envelope.create"
  | "envelope.edit_draft"
  | "envelope.submit"
  | "envelope.move"
  | "envelope.bulk"
  | "target.read"
  | "target.edit_draft"
  | "target.submit"
  | "approval.decide"
  | "approval.force"
  | "registry.manage"
  | "policy.manage"
  | "rule.manage"
  | "tag.create"
  | "tag.apply"
  | "thread.comment"
  | "thread.resolve"
  | "closure.close"
  | "closure.restate"
  | "source.manage"
  | "export.run"
  | "view.share_workspace"
  | "user.manage";

const ALL: Action[] = [
  "envelope.read",
  "envelope.create",
  "envelope.edit_draft",
  "envelope.submit",
  "envelope.move",
  "envelope.bulk",
  "target.read",
  "target.edit_draft",
  "target.submit",
  "approval.decide",
  "approval.force",
  "registry.manage",
  "policy.manage",
  "rule.manage",
  "tag.create",
  "tag.apply",
  "thread.comment",
  "thread.resolve",
  "closure.close",
  "closure.restate",
  "source.manage",
  "export.run",
  "view.share_workspace",
  "user.manage",
];
const READ: Action[] = ["envelope.read", "target.read", "export.run", "tag.apply", "thread.comment"];
const PLAN: Action[] = [
  ...READ,
  "envelope.create",
  "envelope.edit_draft",
  "envelope.submit",
  "envelope.move",
  "envelope.bulk",
  "target.edit_draft",
  "target.submit",
  "thread.resolve",
];

export const permissions: Record<Role, ReadonlySet<Action>> = {
  VIEWER: new Set(READ),
  PLANNER: new Set(PLAN),
  BUDGET_OWNER: new Set([...PLAN, "approval.decide", "rule.manage"]),
  APPROVER: new Set([...READ, "approval.decide", "thread.resolve"]),
  FINANCE: new Set([...READ, "approval.decide", "closure.close", "thread.resolve"]),
  DATA_ADMIN: new Set([...READ, "source.manage"]),
  WORKSPACE_ADMIN: new Set(ALL.filter((action) => action !== "approval.force")),
  ORG_ADMIN: new Set(ALL),
};

export function can(roles: Role[], action: Action): boolean {
  return roles.some((role) => permissions[role].has(action));
}

// ---------------------------------------------------------------------------------------------
// Dimension scopes (plan §7.2). A RoleAssignment.scope is a FilterGroup restricted to dimension
// predicates with eq / in / descends_from, or {} for the whole workspace.
// ---------------------------------------------------------------------------------------------

const ScopePredicate = z.object({
  field: z.object({ kind: z.literal("dimension"), key: z.string().min(1) }),
  op: z.enum(["eq", "in", "descends_from"]),
  value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
});
type ScopePredicateT = z.infer<typeof ScopePredicate>;
interface ScopeGroupT {
  logic: "and" | "or";
  not?: boolean | undefined;
  children: Array<ScopePredicateT | ScopeGroupT>;
}
const ScopeGroup: z.ZodType<ScopeGroupT> = z.lazy(() =>
  z.object({
    logic: z.enum(["and", "or"]),
    not: z.boolean().optional(),
    children: z.array(z.union([ScopePredicate, ScopeGroup])).max(50),
  }),
);
export const ScopeFilter = z.union([ScopeGroup, z.object({}).strict()]);
export type ScopeFilter = ScopeGroupT | Record<string, never>;

/** Envelope dimension codes, plus each value's ancestry (root … value) for descends_from. */
export interface ScopeTarget {
  dims: Record<string, string>;
  ancestors?: Record<string, string[]>;
}

export interface ScopedRole {
  role: Role;
  scope: ScopeFilter;
}

export function matchesScope(scope: ScopeFilter, target: ScopeTarget): boolean {
  if (!("children" in scope) || scope.children.length === 0) return true;
  return evalGroup(scope as ScopeGroupT, target);
}

function evalGroup(g: ScopeGroupT, t: ScopeTarget): boolean {
  if (g.children.length === 0) return !g.not;
  const results = g.children.map((c) => ("field" in c ? evalPredicate(c, t) : evalGroup(c, t)));
  const v = g.logic === "and" ? results.every(Boolean) : results.some(Boolean);
  return g.not ? !v : v;
}

function evalPredicate(p: ScopePredicateT, t: ScopeTarget): boolean {
  const code = t.dims[p.field.key];
  if (code === undefined) return false;
  const wanted = Array.isArray(p.value) ? p.value : [p.value];
  switch (p.op) {
    case "eq":
    case "in":
      return wanted.includes(code);
    case "descends_from": {
      const chain = t.ancestors?.[p.field.key] ?? [code];
      return wanted.some((w) => chain.includes(w));
    }
  }
}

/** True when one assignment both grants the action and has a scope covering the target. */
export function canInScope(assignments: ScopedRole[], action: Action, target: ScopeTarget): boolean {
  return assignments.some((a) => permissions[a.role].has(action) && matchesScope(a.scope, target));
}

/**
 * Approver eligibility for a step (spec §5.4): has the step's role, the scope matches, and
 * blockSelfApproval ⇒ not the version author. Same rule as SQL eligible_approver().
 */
export function eligibleApprover(args: {
  assignments: ScopedRole[];
  stepRole: Role;
  target: ScopeTarget;
  userId: string;
  authorId: string;
  blockSelfApproval: boolean;
}): boolean {
  if (args.blockSelfApproval && args.userId === args.authorId) return false;
  return args.assignments.some((a) => a.role === args.stepRole && matchesScope(a.scope, args.target));
}
