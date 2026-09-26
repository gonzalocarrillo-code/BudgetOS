import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Shared e2e settings: ports, the Identity Platform project the test tokens claim, and packages/db/.env. */
export const E2E_DIR = dirname(fileURLToPath(import.meta.url));
/** E2E_PROFILE=local is the persistent localhost stack (`pnpm dev:local`): its own key, workspace and ports. */
export const LOCAL = process.env["E2E_PROFILE"] === "local";
export const AUTH_DIR = join(E2E_DIR, LOCAL ? ".auth-local" : process.env["E2E_PORT_OFFSET"] ? `.auth-${process.env["E2E_PORT_OFFSET"]}` : ".auth");
export const KEY_FILE = join(AUTH_DIR, "signing-key.json");
export const STATE_FILE = join(AUTH_DIR, "state.json");
/** E2E_PORT_OFFSET shifts every port, so Playwright can run beside a running `e2e:stack`. */
const OFFSET = Number(process.env["E2E_PORT_OFFSET"] ?? 0);
export const PORTS = LOCAL ? { jwks: 4800, api: 3000, web: 5173, worker: 4700 } : { jwks: 4899 + OFFSET, api: 3199 + OFFSET, web: 5199 + OFFSET, worker: 4799 + OFFSET };
/** Where the persistent stack keeps the long-lived persona tokens it prints. */
export const TOKENS_FILE = join(AUTH_DIR, "tokens.json");
export const PROJECT = "budget-os-e2e";
export const ISSUER = `https://securetoken.google.com/${PROJECT}`;

export function dbEnv(): Record<string, string> {
  const file = join(E2E_DIR, "../../../packages/db/.env");
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m?.[1]) out[m[1]] = m[2] ?? "";
  }
  return out;
}

export interface E2EState {
  workspaceId: string;
  orgId: string;
  slug: string;
  approvalRequestId: string;
}
