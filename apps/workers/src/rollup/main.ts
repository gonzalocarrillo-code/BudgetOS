import { pathToFileURL } from "node:url";
import { parseEnv, WorkerEnv } from "@budget/domain";
import { PrismaClient } from "@prisma/client";
import { log } from "../log.js";
import { servePush } from "../push-server.js";
import { handleRollupEvent, rebuildWorkspace } from "./rollup.js";

/**
 * Cloud Run service `rollup-worker` (spec §19): push subscriber for budget.changed, facts.loaded,
 * registry.changed, naming.changed, and the status-only approval.changed, period.closing, period.closed,
 * period.closure_failed and period.restated (ADR-044, W3-1). `tsx src/rollup/main.ts rebuild --workspace <id> --org <id>` rebuilds one workspace.
 */
async function main(): Promise<void> {
  const env = parseEnv(WorkerEnv, process.env);
  const url = env.APP_DATABASE_URL;
  if (!url) throw new Error("APP_DATABASE_URL is required");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const args = process.argv.slice(2);
  if (args[0] === "rebuild") {
    const arg = (flag: string) => args[args.indexOf(flag) + 1];
    const workspaceId = arg("--workspace");
    const orgId = arg("--org");
    if (!workspaceId || !orgId) throw new Error("rebuild needs --workspace <id> --org <id>");
    await rebuildWorkspace(prisma, { workspaceId, orgId });
    await prisma.$disconnect();
    return;
  }
  servePush("rollup-worker", (body) => handleRollupEvent(prisma, body));
  log.info("rollup-worker listening");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    log.fatal({ err: error }, "rollup-worker crashed");
    process.exit(1);
  });
}
