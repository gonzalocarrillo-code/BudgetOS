/** Authentication for callers outside the Nest app (the MCP server): no Nest module needed. */
export { authenticate, authorize } from "./authenticate.js";
export type { AuthDeps } from "./authenticate.js";
export { AccessRepository } from "./access.repository.js";
export { JwtVerifier } from "./jwt-verifier.js";
export { MemoryRoleCache } from "./role-cache.js";
export type { AuthContext } from "../tenant.js";
