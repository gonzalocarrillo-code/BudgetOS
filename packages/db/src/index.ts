export type { AuditEventInput, KpiFactRow, OutboxInput, SpendFactRow } from "./facts.types.js";
export {
  dimensionValuePaths,
  insertRewriteAudits,
  rewriteMergedValue,
  upsertDimensionValue,
} from "./registry.js";
export type { DimensionValuePathRow, UpsertDimensionValueInput } from "./registry.js";
export { DEFAULT_DIMENSIONS, DEFAULT_HIERARCHY } from "../seed/defaults.registry.js";
export type { RegistryDimensionSeed, RegistryValueSeed } from "../seed/defaults.registry.js";
export { audit, bumpDataVersion, outbox } from "./sql.js";
export type { Tx } from "./sql.js";
export { eligibleApproverSql, lockApprovalRequest, lockParentCap } from "./approvals.js";
export type { LockedRequestRow } from "./approvals.js";
export { DEFAULT_POLICIES } from "../seed/defaults.policies.js";
export type { DefaultPolicySeed } from "../seed/defaults.policies.js";
export { lockEnvelope } from "./envelopes.js";
export type { LockedEnvelopeRow } from "./envelopes.js";
export { withTenant } from "./tenant.js";
export type { TenantContext } from "./tenant.js";
