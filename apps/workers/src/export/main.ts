import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { objectStoreFromEnv } from "../ingest/object-store.js";
import { log } from "../log.js";
import { servePush } from "../push-server.js";
import { handleExportRequested } from "./export.js";

/** Cloud Run service `export-worker` (spec §19): push subscriber for export.requested. */
function main(): void {
  const url = process.env["APP_DATABASE_URL"];
  if (!url) throw new Error("APP_DATABASE_URL is required");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const store = objectStoreFromEnv();
  servePush("export-worker", (body) => handleExportRequested(prisma, store, body));
  log.info("export-worker listening");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    log.fatal({ err: error }, "export-worker crashed");
    process.exit(1);
  }
}
