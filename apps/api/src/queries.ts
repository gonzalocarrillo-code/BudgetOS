/**
 * Read-only entry points for callers outside the Nest app (the MCP server, spec §16). Only
 * `queries/` modules and read helpers are exported here; nothing reachable from this file may
 * import a `commands/` module (apps/mcp/src/readonly.test.ts walks the import graph).
 */
export { listApprovals } from "./modules/approvals/queries/approvals.js";
export { getMe } from "./modules/auth/queries/get-me.js";
export { closureByPeriod, closureReport, listClosures } from "./modules/closures/queries/closures.js";
export { getEnvelope } from "./modules/envelopes/queries/get-envelope.js";
export { getTimeline } from "./modules/envelopes/queries/timeline.js";
export { EXPORT_LINK_TTL_SECONDS, exportCsvLink } from "./modules/exports/queries/export-link.js";
export { listAlerts, pacingView } from "./modules/pacing/queries.js";
export { runQuery, scopedQuery } from "./modules/query/queries/run-query.js";
export { describeRegistry } from "./modules/registry/queries/list-registry.js";
export { search } from "./modules/search/search.js";
export { envelopeTargets, listTargets } from "./modules/targets/queries/targets.js";
export { listTags, listThreads } from "./modules/threads/queries.js";
