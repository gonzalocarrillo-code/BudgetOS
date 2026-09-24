import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { log } from "../log.js";
import { servePush } from "../push-server.js";
import { handleSearchEvent, reindexWorkspace } from "./indexer.js";

/**
 * Cloud Run service `search-indexer` (spec §12.1): Pub/Sub push from the outbox publisher.
 * `tsx src/search-indexer/main.ts reindex --workspace <id> --org <id>` re-indexes one workspace.
 */
async function main(): Promise<void> {
  const url = process.env["APP_DATABASE_URL"];
  if (!url) throw new Error("APP_DATABASE_URL is required");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const args = process.argv.slice(2);
  if (args[0] === "reindex") {
    const arg = (flag: string) => args[args.indexOf(flag) + 1];
    const workspaceId = arg("--workspace");
    const orgId = arg("--org");
    if (!workspaceId || !orgId) throw new Error("reindex needs --workspace <id> --org <id>");
    const counts = await reindexWorkspace(prisma, { workspaceId, orgId });
    log.info({ workspaceId, counts }, "reindex done");
    await prisma.$disconnect();
    return;
  }
  servePush("search-indexer", (body) => handleSearchEvent(prisma, body));
  log.info("search-indexer listening");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    log.fatal({ err: error }, "search-indexer crashed");
    process.exit(1);
  });
}
