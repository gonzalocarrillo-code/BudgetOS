import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { log } from "../log.js";
import { servePush } from "../push-server.js";
import { handleInApp } from "./in-app.js";
import { handleSlackEvent, slackConfigWarnings, slackFromEnv } from "./slack.js";

/**
 * Cloud Run service `notify-worker` (spec §19): push subscriber for the topics OUTBOX_TOPICS gives
 * the notify worker (@budget/domain). In-app and Slack are separate consumers: when Slack fails
 * the push answers 500, the redelivery skips in-app (already applied) and retries Slack.
 */
async function main(): Promise<void> {
  const url = process.env["APP_DATABASE_URL"];
  if (!url) throw new Error("APP_DATABASE_URL is required");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const slack = slackFromEnv();
  servePush("notify-worker", async (body) => {
    await handleInApp(prisma, body);
    await handleSlackEvent(prisma, slack, body);
  });
  log.info({ slack: slack !== null }, "notify-worker listening");
  for (const warning of slackConfigWarnings()) log.warn(warning);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    log.fatal({ err: error }, "notify-worker crashed");
    process.exit(1);
  });
}
