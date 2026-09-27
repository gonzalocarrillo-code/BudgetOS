import { PolicyConditions } from "@budget/domain";
import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { conditionsMatch, type DiffFacts } from "./policy-matcher.js";

/** Product feedback 6 (ADR-040): a policy can say who is asking — roles (direct or via groups) or people. */

const facts = (requester?: DiffFacts["requester"]): DiffFacts => ({
  entityType: "envelope_version",
  amountAbs: new Decimal(5000),
  deltaAbs: new Decimal(500),
  deltaPct: new Decimal("0.1"),
  isOverAllocation: false,
  level: 3,
  dimensionValues: { region: "EMEA" },
  daysRemaining: 90,
  ...(requester ? { requester } : {}),
});
const U1 = "01a0e0da-e7e9-7f9a-9212-1c166382caf1";
const U2 = "01a0e0da-e7e9-7f9a-9212-1c166382caf2";

describe("requester conditions", () => {
  const finance = PolicyConditions.parse({ requester: { roles: ["FINANCE"] } });
  it("match the requester's roles, or their id", () => {
    expect(conditionsMatch(finance, facts({ userId: U1, roles: ["FINANCE", "PLANNER"] }))).toBe(true);
    expect(conditionsMatch(finance, facts({ userId: U1, roles: ["PLANNER"] }))).toBe(false);
    const person = PolicyConditions.parse({ requester: { userIds: [U2] } });
    expect(conditionsMatch(person, facts({ userId: U2, roles: [] }))).toBe(true);
    expect(conditionsMatch(person, facts({ userId: U1, roles: ["FINANCE"] }))).toBe(false);
  });

  it("never match when nobody is named as asking (a re-route after a move)", () => {
    expect(conditionsMatch(finance, facts())).toBe(false);
  });

  it("combine with the other conditions (all must hold) and inside `any`", () => {
    const smallByFinance = PolicyConditions.parse({ requester: { roles: ["FINANCE"] }, amountAbs: { lt: 1000 } });
    expect(conditionsMatch(smallByFinance, facts({ userId: U1, roles: ["FINANCE"] }))).toBe(false);
    const either = PolicyConditions.parse({ any: [{ requester: { roles: ["WORKSPACE_ADMIN"] } }, { deltaPct: { lt: 0.2 } }] });
    expect(conditionsMatch(either, facts({ userId: U1, roles: ["PLANNER"] }))).toBe(true);
  });

  it("need roles or people", () => {
    expect(PolicyConditions.safeParse({ requester: {} }).success).toBe(false);
    expect(PolicyConditions.safeParse({ requester: { roles: ["NOT_A_ROLE"] } }).success).toBe(false);
  });
});
