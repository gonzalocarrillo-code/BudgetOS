/**
 * Default approval policies (spec §9.2, plan §8.1). Conditions are in reporting currency.
 *
 * Priority order differs from the plan's YAML listing on purpose: first match wins, so the
 * over-allocation / major policy is checked before "Standard" (otherwise an over-allocating change
 * under 250k would route to Standard), and the auto-approve and minor templates exclude
 * over-allocation so they can never wave one through.
 */
export interface DefaultPolicySeed {
  name: string;
  priority: number;
  conditions: Record<string, unknown>;
  chain: Array<{ role: string; minApprovals?: number; timeoutHours?: number; escalateTo?: string }>;
  allowExternalEvidence: boolean;
  blockSelfApproval: boolean;
}

export const DEFAULT_POLICIES: readonly DefaultPolicySeed[] = [
  {
    name: "Auto-approve minor",
    priority: 1,
    conditions: { deltaPct: { lt: 0.02 }, deltaAbs: { lt: 1000 }, isOverAllocation: false },
    chain: [],
    allowExternalEvidence: false,
    blockSelfApproval: true,
  },
  {
    name: "Minor adjustment",
    priority: 10,
    conditions: { deltaPct: { lt: 0.05 }, amountAbs: { lt: 10000 }, isOverAllocation: false },
    chain: [{ role: "BUDGET_OWNER", minApprovals: 1, timeoutHours: 48 }],
    allowExternalEvidence: false,
    blockSelfApproval: true,
  },
  {
    name: "Major / over-allocation",
    priority: 20,
    conditions: { any: [{ amountAbs: { gte: 250000 } }, { isOverAllocation: true }] },
    chain: [
      { role: "BUDGET_OWNER", minApprovals: 1, timeoutHours: 48 },
      { role: "FINANCE", minApprovals: 2, timeoutHours: 72 },
    ],
    allowExternalEvidence: false,
    blockSelfApproval: true,
  },
  {
    name: "Standard",
    priority: 30,
    conditions: { amountAbs: { lt: 250000 } },
    chain: [
      { role: "BUDGET_OWNER", minApprovals: 1, timeoutHours: 48 },
      { role: "APPROVER", minApprovals: 1, timeoutHours: 72, escalateTo: "FINANCE" },
    ],
    allowExternalEvidence: true,
    blockSelfApproval: true,
  },
  {
    name: "Default",
    priority: 999,
    conditions: {},
    chain: [{ role: "BUDGET_OWNER", minApprovals: 1, timeoutHours: 48 }],
    allowExternalEvidence: false,
    blockSelfApproval: true,
  },
];
