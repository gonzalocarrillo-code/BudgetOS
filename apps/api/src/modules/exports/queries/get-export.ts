import { DomainError, type ExportJobView } from "@budget/domain";
import { withTenant } from "@budget/db";
import type { ObjectStore } from "@budget/workers";
import type { ExportJob, PrismaClient } from "@prisma/client";
import { parseId } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

export const DOWNLOAD_TTL_SECONDS = 15 * 60;

export function exportView(j: ExportJob, downloadUrl: string | null): ExportJobView {
  return {
    id: j.id,
    workspaceId: j.workspaceId,
    kind: j.kind as ExportJobView["kind"],
    status: j.status as ExportJobView["status"],
    filename: j.filename,
    rowCount: j.rowCount,
    error: j.error,
    createdAt: j.createdAt.toISOString(),
    completedAt: j.completedAt?.toISOString() ?? null,
    downloadUrl,
    expiresInSeconds: downloadUrl === null ? null : DOWNLOAD_TTL_SECONDS,
  };
}

/** GET /exports/:jobId: the caller's own job (org admins see any in the workspace); a download URL once done. */
export async function getExport(prisma: PrismaClient, store: ObjectStore, auth: AuthContext, rawId: string): Promise<ExportJobView> {
  const job = await withTenant(prisma, auth.ctx, (tx) => tx.exportJob.findUnique({ where: { id: parseId(rawId) } }));
  if (job === null || (job.createdBy !== auth.user.id && !auth.isOrgAdmin)) throw new DomainError("NOT_FOUND", "Export not found");
  const url = job.status === "done" && job.objectUri ? await store.downloadUrl(job.objectUri, `${job.filename}.${job.kind}`, DOWNLOAD_TTL_SECONDS) : null;
  return exportView(job, url);
}
