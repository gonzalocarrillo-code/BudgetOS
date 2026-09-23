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
