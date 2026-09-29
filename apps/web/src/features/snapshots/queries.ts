import { BaselineReport, BaselineRowsResponse, BaselinesResponse, BaselineView, type BaselineScope, type BaselineKind } from "@budget/domain";
import { t } from "@budget/ui/i18n";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../../lib/api.js";
import { meQuery } from "../../lib/queries.js";

/** Snapshots (Phase E, ADR-053): saved by hand, compared with in Budgets, Overview and Closures. */
export type Snapshot = BaselineView;

export const snapshotsQuery = (ws: string, opts: { includeArchived?: boolean; envelopeId?: string } = {}) =>
  queryOptions({
    queryKey: ["snapshots", ws, opts],
    queryFn: async () =>
      BaselinesResponse.parse(
        await unwrap(
          api.GET("/api/v1/workspaces/{ws}/baselines", {
            params: { path: { ws }, query: { ...(opts.includeArchived ? { includeArchived: "true" } : {}), ...(opts.envelopeId ? { envelopeId: opts.envelopeId } : {}) } as never },
          }),
        ),
      ).baselines,
  });

export const snapshotReportQuery = (ws: string, id: string, against?: string) =>
  queryOptions({
    queryKey: ["snapshot-report", ws, id, against ?? null],
    queryFn: async () =>
      BaselineReport.parse(await unwrap(api.GET("/api/v1/baselines/{id}/report", { params: { path: { id }, query: { ...(against ? { against } : {}) } as never, header: { "X-Workspace-Id": ws } } }))),
  });

export async function saveSnapshot(ws: string, body: { name: string; kind: BaselineKind; scope: BaselineScope; periodKey?: string; note?: string }): Promise<Snapshot> {
  return BaselineView.parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/baselines", { params: { path: { ws } }, body: body as never })));
}

export async function updateSnapshot(ws: string, id: string, body: { name?: string; archived?: boolean; note?: string | null }): Promise<Snapshot> {
  return BaselineView.parse(await unwrap(api.PATCH("/api/v1/baselines/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } }, body: body as never })));
}

/** Finance and admins save snapshots of the whole workspace or a filter; anyone who edits a budget, of its subtree. */
export function useCanSnapshotWorkspace(ws: string): boolean {
  const { data: me } = useQuery(meQuery);
  return me?.isOrgAdmin === true || (me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? []).includes("closure.close");
}

export const savedOn = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
export const snapshotLabel = (s: Snapshot) => t("snapshots.option", { name: s.name, date: savedOn(s.asOf) });

export const snapshotQuery = (ws: string, id: string) =>
  queryOptions({
    queryKey: ["snapshot", ws, id],
    queryFn: async () => BaselineView.parse(await unwrap(api.GET("/api/v1/baselines/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } } }))),
  });

export const snapshotRowsQuery = (ws: string, id: string, limit = 5000) =>
  queryOptions({
    queryKey: ["snapshot-rows", ws, id, limit],
    queryFn: async () => BaselineRowsResponse.parse(await unwrap(api.GET("/api/v1/baselines/{id}/rows", { params: { path: { id }, query: { limit } as never, header: { "X-Workspace-Id": ws } } }))),
  });

/** The snapshot as a file: fetched with the session's token, then handed to the browser as a download. */
export async function downloadSnapshotCsv(ws: string, id: string, name: string): Promise<void> {
  const csv = (await unwrap(api.GET("/api/v1/baselines/{id}/export.csv", { params: { path: { id }, header: { "X-Workspace-Id": ws } }, parseAs: "text" }))) as unknown as string;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `snapshot-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "snapshot"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
