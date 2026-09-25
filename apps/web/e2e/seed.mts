import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { seedGolden } from "../../api/src/seed/golden.js";
import { cleanupGolden } from "../../api/src/test-support/golden-cleanup.js";
import { dbEnv } from "./env.js";

/** `tsx e2e/seed.mts` prints the seeded golden workspace as JSON; `… cleanup <state json>` removes it. */
const env = dbEnv();
const owner = new PrismaClient({ datasources: { db: { url: env["DATABASE_URL"] ?? "" } } });
const app = new PrismaClient({ datasources: { db: { url: env["APP_DATABASE_URL"] ?? "" } } });
try {
  if (process.argv[2] === "cleanup") {
    const state = JSON.parse(process.argv[3] ?? "{}") as { workspaceId: string };
    await cleanupGolden(owner, { workspaceId: state.workspaceId } as Parameters<typeof cleanupGolden>[1]);
  } else {
    const slug = `e2e-${randomUUID().slice(0, 8)}`;
    const golden = await seedGolden(app, owner, { slug });
    const request = await owner.approvalRequest.findFirstOrThrow({ where: { workspaceId: golden.workspaceId, status: "PENDING" }, select: { id: true } });
    process.stdout.write(`${JSON.stringify({ workspaceId: golden.workspaceId, orgId: golden.orgId, slug, approvalRequestId: request.id })}\n`);
  }
} finally {
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
}
