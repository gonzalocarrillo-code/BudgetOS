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
    // SEED_SLUG (the persistent local stack): a fixed slug, seeded once and reused after.
    const slug = process.env["SEED_SLUG"] ?? `e2e-${randomUUID().slice(0, 8)}`;
    const golden = await seedGolden(app, owner, { slug });
    if (!process.env["SEED_SLUG"]) {
      // T-040: the specs' personas have seen their first-run tours (the tours spec launches them from Help).
      const users = await owner.user.findMany({ where: { orgId: golden.orgId }, select: { id: true } });
      const tours = await owner.tour.findMany({ where: { OR: [{ workspaceId: null }, { workspaceId: golden.workspaceId }] }, select: { id: true, version: true } });
      await owner.tourCompletion.createMany({ data: users.flatMap((u) => tours.map((t) => ({ userId: u.id, tourId: t.id, version: t.version }))), skipDuplicates: true });
    }
    // A reused local workspace may have no pending request left (someone decided it).
    const request = await owner.approvalRequest.findFirst({ where: { workspaceId: golden.workspaceId, status: "PENDING" }, select: { id: true }, orderBy: { requestedAt: "asc" } });
    process.stdout.write(`${JSON.stringify({ workspaceId: golden.workspaceId, orgId: golden.orgId, slug, approvalRequestId: request?.id ?? "" })}\n`);
  }
} finally {
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
}
