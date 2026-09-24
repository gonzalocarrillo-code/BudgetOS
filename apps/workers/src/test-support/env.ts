import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Side effect: fills process.env from packages/db/.env (local Postgres port and roles) without overriding it. */
const path = join(dirname(fileURLToPath(import.meta.url)), "../../../../packages/db/.env");
if (existsSync(path)) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    const i = t.indexOf("=");
    if (t === "" || t.startsWith("#") || i === -1) continue;
    const key = t.slice(0, i).trim();
    if (process.env[key] === undefined) process.env[key] = t.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}
