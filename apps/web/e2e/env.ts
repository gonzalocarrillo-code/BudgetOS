import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Shared e2e settings: ports, the Identity Platform project the test tokens claim, and packages/db/.env. */
export const E2E_DIR = dirname(fileURLToPath(import.meta.url));
export const AUTH_DIR = join(E2E_DIR, ".auth");
export const KEY_FILE = join(AUTH_DIR, "signing-key.json");
export const STATE_FILE = join(AUTH_DIR, "state.json");
export const PORTS = { jwks: 4899, api: 3199, web: 5199 };
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
