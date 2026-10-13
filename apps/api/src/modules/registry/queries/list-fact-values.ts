import { DomainError, FactValuesQuery, type FactValuesResponse } from "@budget/domain";
import { listFactDimensionValues, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseInput } from "../../../common/parse-input.js";
import { orgAdminCtx, type AuthContext } from "../../../common/tenant.js";
import { loadDimensions } from "../dimensions.js";

/**
 * GET /workspaces/:ws/dimensions/:key/fact-values (EX-9, ADR-0094): one page of a data-derived
 * dimension's values — the distinct values on the workspace's live facts, with spend, first/last
 * seen and source systems. The registry page, filter bar, rule forms and ⌘K all read it. A key that
 * is not a data-derived dimension of the workspace is NOT_FOUND.
 */
export async function listFactValues(prisma: PrismaClient, auth: AuthContext, workspaceId: string, key: string, raw: unknown): Promise<FactValuesResponse> {
  const query = parseInput(FactValuesQuery, raw);
  return withTenant(prisma, { ...orgAdminCtx(auth), workspaceId }, async (tx) => {
    const dimension = (await loadDimensions(tx, auth.user.orgId, workspaceId)).find((d) => d.key === key);
    if (dimension === undefined || dimension.valuesSource !== "facts") {
      throw new DomainError("NOT_FOUND", `${key} is not a granularity whose values come from the data`, { dimension: key });
    }
    const page = await listFactDimensionValues(tx, { workspaceId, key, q: query.q, limit: query.limit, offset: query.offset, includeDemo: query.includeDemo === "true" });
    return { key, valuesSource: "facts", ...page };
  });
}
