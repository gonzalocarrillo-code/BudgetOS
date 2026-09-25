import { newId } from "@budget/domain";
import { withTenant } from "@budget/db";
import { exportTable, toCsv, uploadBucket, type ObjectStore } from "@budget/workers";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../../common/tenant.js";
import { scopedQuery } from "../../query/queries/run-query.js";

/**
 * The MCP `export_csv` tool (spec §16): a CSV of the whole query, cut to the caller's read scope,
 * written to the object store and returned as a 1-hour download URL. Nothing is written to the
 * database (no export_job): the file is the only output, so the MCP server stays read-only.
 */
export const EXPORT_LINK_TTL_SECONDS = 3600;

export async function exportCsvLink(prisma: PrismaClient, store: ObjectStore, auth: AuthContext, raw: unknown, now: Date = new Date()) {
  const q = scopedQuery(auth, raw);
  const tenant = { workspaceId: q.workspaceId, orgId: auth.user.orgId };
  const built = await withTenant(prisma, auth.ctx, (tx) => exportTable(tx, tenant, q, now.toISOString().slice(0, 10)), { isolation: "RepeatableRead", timeoutMs: 120_000 });
  const uri = `gs://${uploadBucket()}/exports/${q.workspaceId}/mcp-${newId()}.csv`;
  await store.write(uri, toCsv(built.table), "text/csv; charset=utf-8");
  return {
    downloadUrl: await store.downloadUrl(uri, "budget-os-export.csv", EXPORT_LINK_TTL_SECONDS),
    expiresInSeconds: EXPORT_LINK_TTL_SECONDS,
    rowCount: built.table.rows.length,
    period: built.period,
    dataVersion: built.dataVersion,
  };
}
