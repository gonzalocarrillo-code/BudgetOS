import { describe, expect, it } from "vitest";
import {
  ScopeFilter,
  can,
  canInScope,
  eligibleApprover,
  matchesScope,
  type Action,
  type Role,
} from "./permissions.js";

/**
 * T-009 done-when: every role × action. The grid is written out by hand from spec §5.4 and
 * cross-checked against plan §7.1 (columns noted per action), so a change to the permission
 * table in code has to be a deliberate change here too.
 */
const ACTIONS: Action[] = [
  "envelope.read", //        plan: Read
  "envelope.create", //      plan: Set budgets (draft)
  "envelope.edit_draft", //  plan: Set budgets (draft)
  "envelope.submit", //      plan: Submit for approval
  "envelope.move",
  "envelope.bulk",
  "target.read",
  "target.edit_draft",
  "target.submit",
  "approval.decide", //      plan: Approve
  "approval.force", //       plan §7.3 break-glass, Org Admin only
  "registry.manage", //      plan: Manage registry / policies
  "policy.manage",
  "rule.manage",
  "tag.create",
  "tag.apply",
  "thread.comment",
  "thread.resolve",
  "closure.close", //        plan: Close periods
  "closure.restate",
  "source.manage", //        plan: Connect sources
  "export.run", //           plan: Export
  "view.share_workspace",
  "user.manage",
];

//                        r c e s m b | r e s | d f | g p u | c a | c r | c r | s x v u
const GRID: Record<Role, string> = {
  VIEWER: /*          */ "Y . . . . . | Y . . | . . | . . . | . Y | Y . | . . | . Y . .",
  PLANNER: /*         */ "Y Y Y Y Y Y | Y Y Y | . . | . . . | . Y | Y Y | . . | . Y . .",
  BUDGET_OWNER: /*    */ "Y Y Y Y Y Y | Y Y Y | Y . | . . Y | . Y | Y Y | . . | . Y . .",
  APPROVER: /*        */ "Y . . . . . | Y . . | Y . | . . . | . Y | Y Y | . . | . Y . .",
  FINANCE: /*         */ "Y . . . . . | Y . . | Y . | . . . | . Y | Y Y | Y . | . Y . .",
  DATA_ADMIN: /*      */ "Y . . . . . | Y . . | . . | . . . | . Y | Y . | . . | Y Y . .",
  WORKSPACE_ADMIN: /* */ "Y Y Y Y Y Y | Y Y Y | Y . | Y Y Y | Y Y | Y Y | Y Y | Y Y Y Y",
  ORG_ADMIN: /*       */ "Y Y Y Y Y Y | Y Y Y | Y Y | Y Y Y | Y Y | Y Y | Y Y | Y Y Y Y",
};

const ROLES = Object.keys(GRID) as Role[];
const cells = (row: string) => row.replace(/\|/g, "").trim().split(/\s+/);

describe("permission matrix: every role × action", () => {
  it("grid has one cell per action", () => {
    for (const role of ROLES) expect(cells(GRID[role])).toHaveLength(ACTIONS.length);
  });

  const pairs = ROLES.flatMap((role) => ACTIONS.map((action, i) => [role, action, cells(GRID[role])[i] === "Y"] as const));
  it.each(pairs)("%s %s → %s", (role, action, allowed) => {
    expect(can([role], action)).toBe(allowed);
  });

  it("roles combine as a union", () => {
    expect(can(["VIEWER", "DATA_ADMIN"], "source.manage")).toBe(true);
    expect(can(["PLANNER", "APPROVER"], "approval.decide")).toBe(true);
    expect(can([], "envelope.read")).toBe(false);
  });
});

describe("matchesScope", () => {
  const latamMeta: ScopeFilter = {
    logic: "and",
    children: [
      { field: { kind: "dimension", key: "region" }, op: "descends_from", value: "latam" },
      { field: { kind: "dimension", key: "platform" }, op: "in", value: ["meta"] },
    ],
  };
  const br = { dims: { region: "br", platform: "meta" }, ancestors: { region: ["latam", "br"], platform: ["meta"] } };

  it("empty scope is the whole workspace", () => {
    expect(matchesScope({}, br)).toBe(true);
    expect(matchesScope({ logic: "and", children: [] }, br)).toBe(true);
  });
  it("descends_from uses the value's ancestry, eq/in use the value itself", () => {
    expect(matchesScope(latamMeta, br)).toBe(true);
    expect(matchesScope(latamMeta, { ...br, dims: { region: "br", platform: "google" } })).toBe(false);
    expect(matchesScope(latamMeta, { dims: { region: "de", platform: "meta" }, ancestors: { region: ["emea", "de"] } })).toBe(false);
    expect(matchesScope({ logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "latam" }] }, br)).toBe(false);
  });
  it("descends_from without ancestry matches only the value itself", () => {
    const f: ScopeFilter = { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "descends_from", value: "br" }] };
    expect(matchesScope(f, { dims: { region: "br" } })).toBe(true);
    expect(matchesScope(f, { dims: { region: "br_sp" } })).toBe(false);
  });
  it("or / not groups", () => {
    const f: ScopeFilter = {
      logic: "or",
      children: [
        { field: { kind: "dimension", key: "region" }, op: "eq", value: "de" },
        { logic: "and", not: true, children: [{ field: { kind: "dimension", key: "platform" }, op: "eq", value: "meta" }] },
      ],
    };
    expect(matchesScope(f, br)).toBe(false);
    expect(matchesScope(f, { dims: { region: "br", platform: "google" } })).toBe(true);
  });
  it("a missing dimension never matches a predicate on it", () => {
    expect(matchesScope(latamMeta, { dims: { platform: "meta" } })).toBe(false);
  });
  it("ScopeFilter accepts only dimension eq / in / descends_from", () => {
    expect(ScopeFilter.safeParse(latamMeta).success).toBe(true);
    expect(ScopeFilter.safeParse({}).success).toBe(true);
    expect(ScopeFilter.safeParse({ logic: "and", children: [{ field: { kind: "measure", key: "budget" }, op: "gt", value: 1 }] }).success).toBe(false);
    expect(ScopeFilter.safeParse({ logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "contains", value: "x" }] }).success).toBe(false);
  });
});

describe("canInScope", () => {
  const target = { dims: { region: "br" }, ancestors: { region: ["latam", "br"] } };
  const latam: ScopeFilter = { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "descends_from", value: "latam" }] };
  const emea: ScopeFilter = { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "descends_from", value: "emea" }] };

  it("needs a role that grants the action and whose scope matches", () => {
    expect(canInScope([{ role: "BUDGET_OWNER", scope: latam }], "approval.decide", target)).toBe(true);
    expect(canInScope([{ role: "BUDGET_OWNER", scope: emea }], "approval.decide", target)).toBe(false);
    expect(canInScope([{ role: "VIEWER", scope: {} }, { role: "BUDGET_OWNER", scope: emea }], "approval.decide", target)).toBe(false);
    expect(canInScope([{ role: "VIEWER", scope: latam }, { role: "APPROVER", scope: {} }], "approval.decide", target)).toBe(true);
  });
  it("a scope on one role does not widen another role", () => {
    expect(canInScope([{ role: "PLANNER", scope: emea }, { role: "VIEWER", scope: latam }], "envelope.edit_draft", target)).toBe(false);
  });
});

describe("separation of duties", () => {
  const target = { dims: { region: "br" }, ancestors: { region: ["latam", "br"] } };
  const me = "01927a00-0000-7000-8000-000000000001";
  const author = "01927a00-0000-7000-8000-000000000002";
  const base = { stepRole: "APPROVER" as Role, target, userId: me, authorId: author, blockSelfApproval: true };

  it("a user cannot approve a version they authored", () => {
    expect(eligibleApprover({ ...base, assignments: [{ role: "APPROVER", scope: {} }], authorId: me })).toBe(false);
  });
  it("the policy may turn self-approval blocking off", () => {
    expect(eligibleApprover({ ...base, assignments: [{ role: "APPROVER", scope: {} }], authorId: me, blockSelfApproval: false })).toBe(true);
  });
  it("needs the step's role, in scope", () => {
    expect(eligibleApprover({ ...base, assignments: [{ role: "APPROVER", scope: {} }] })).toBe(true);
    expect(eligibleApprover({ ...base, assignments: [{ role: "FINANCE", scope: {} }] })).toBe(false);
    expect(
      eligibleApprover({
        ...base,
        assignments: [{ role: "APPROVER", scope: { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "de" }] } }],
      }),
    ).toBe(false);
  });
  it("org admin's force approval is a separate action, not step eligibility", () => {
    expect(eligibleApprover({ ...base, assignments: [{ role: "ORG_ADMIN", scope: {} }] })).toBe(false);
    expect(can(["ORG_ADMIN"], "approval.force")).toBe(true);
  });
});
