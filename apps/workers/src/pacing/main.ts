import { pathToFileURL } from "node:url";
import { withTenant } from "@budget/db";
import { PrismaClient } from "@prisma/client";
import { log } from "../log.js";
import { evaluateWorkspace } from "./evaluate.js";

/**
 * Cloud Run Job `pacing` (spec §11), triggered every 15 minutes by Cloud Scheduler (phase 20).
 * RLS keeps `organization` closed to budget_app, so the job cannot discover orgs: the scheduler
 * passes them in PACING_ORG_IDS (comma-separated), like escalateOverdue (ADR-012). Workspaces of
 * each org are listed with the org-scoped admin bypass; each is evaluated in its own transaction.
 */
export async function runPacing(prisma: PrismaClient, orgIds: readonly string[], today: string, now: Date = new Date()) {
  const out: Array<{ workspaceId: string; opened: number; resolved: number; reopened: number }> = [];
  for (const orgId of orgIds) {
    const workspaces = await withTenant(prisma, { workspaceId: null, orgId, userId: null, isOrgAdmin: true, actorType: "system", requestId: `pacing-${today}-${orgId}` }, (tx) =>
      tx.workspace.findMany({ where: { orgId }, select: { id: true }, orderBy: { id: "asc" } }),
    );
    for (const ws of workspaces) {
      try {
        const r = await evaluateWorkspace(prisma, { workspaceId: ws.id, orgId }, today, now);
        out.push({ workspaceId: ws.id, opened: r.opened.length, resolved: r.resolved.length, reopened: r.reopened.length });
      } catch (error) {
        // One workspace failing does not stop the others; the next run retries it.
        log.error({ err: error, workspaceId: ws.id, orgId }, "pacing evaluation failed");
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const url = process.env["APP_DATABASE_URL"];
  if (!url) throw new Error("APP_DATABASE_URL is required");
  const orgIds = (process.env["PACING_ORG_IDS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (orgIds.length === 0) throw new Error("PACING_ORG_IDS is required (comma-separated org ids)");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const now = new Date();
    const result = await runPacing(prisma, orgIds, now.toISOString().slice(0, 10), now);
    log.info({ workspaces: result.length }, "pacing job finished");
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    log.fatal({ err: error }, "pacing job crashed");
    process.exit(1);
  });
}
