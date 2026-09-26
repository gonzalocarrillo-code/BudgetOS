import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { can, sourcesQuery, type Source } from "../features/ops/queries.js";
import { MappingWizard, type Mapping } from "../features/sources/mapping-wizard.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/**
 * Data sources, set up (spec §18.5, §14): every connector with what it maps, and the mapping
 * wizard for a new CSV source or a changed mapping. Runs, coverage and unmatched spend are on
 * the Sources screen. Snowflake, Sheets and BigQuery need their credentials in Secret Manager.
 */
const AdminSourcesSearch = z.object({ wizard: z.string().optional() });
type AdminSourcesSearch = z.infer<typeof AdminSourcesSearch>;
export const Route = createFileRoute("/w/$ws/admin/sources")({ validateSearch: AdminSourcesSearch, component: AdminSources });

export const mappingSummary = (m: Source["mapping"]) => {
  const cols = Object.values(m.columns);
  const dims = cols.filter((c) => "dimension" in c).map((c) => String(c["dimension"]));
  return t("sources.summary", { kind: t(`sources.kind.${m.kind.replace("+", "_")}` as MessageKey), dims: dims.join(", ") || "—", n: cols.length });
};

function AdminSources(): ReactElement {
  const { ws } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const canManage = can(perms, me?.isOrgAdmin ?? false, "source.manage");
  const { data: sources = [], isPending, error } = useQuery({ ...sourcesQuery(ws), enabled: canManage });
  const set = (s: Partial<AdminSourcesSearch>) => void navigate({ search: (prev: AdminSourcesSearch) => ({ ...prev, ...s }) });
  const toggle = useMutation({
    mutationFn: async (s: Source) => unwrap(api.PATCH("/api/v1/sources/{id}", { params: { path: { id: s.id }, header: { "X-Workspace-Id": ws } }, body: { isActive: !s.isActive } as never })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["sources", ws] }),
  });
  const editing = search.wizard && search.wizard !== "new" ? sources.find((s) => s.id === search.wizard) : undefined;
  const blocked = canManage ? null : t("sources.noPermission");

  return (
    <Page
      title={t("admin.sources")}
      actions={
        blocked ? (
          <Button disabled reason={blocked} data-testid="source-new">
            <Plus className="size-4" aria-hidden />
            {t("sources.new")}
          </Button>
        ) : (
          <Button onClick={() => set({ wizard: "new" })} data-testid="source-new">
            <Plus className="size-4" aria-hidden />
            {t("sources.new")}
          </Button>
        )
      }
    >
      {search.wizard ? (
        <Card title={editing ? t("sources.editMapping", { name: editing.name }) : t("sources.new")}>
          <MappingWizard
            key={search.wizard}
            ws={ws}
            source={editing ? { id: editing.id, name: editing.name, mapping: editing.mapping as unknown as Mapping } : undefined}
            onCancel={() => set({ wizard: undefined })}
            onDone={async (id) => {
              await client.invalidateQueries({ queryKey: ["sources", ws] });
              await client.invalidateQueries({ queryKey: ["runs", ws] });
              void navigate({ to: "/w/$ws/sources", params: { ws }, search: { source: id } as never });
            }}
          />
        </Card>
      ) : null}
      <Card>
        {blocked ? <p className="text-sm text-muted-foreground">{blocked}</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
        {canManage && isPending ? <p className="text-sm text-muted-foreground">{t("shell.loading")}</p> : null}
        {canManage && !isPending && sources.length === 0 ? <p className="text-sm text-muted-foreground">{t("sources.none")}</p> : null}
        {sources.length ? (
          <table className="w-full text-sm" data-testid="admin-sources-table">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">{t("sources.name")}</th>
                <th className="py-2 pr-3 font-medium">{t("sources.connector")}</th>
                <th className="py-2 pr-3 font-medium">{t("sources.mapping")}</th>
                <th className="py-2 pr-3 font-medium">{t("sources.col.schedule")}</th>
                <th className="py-2 font-medium"><span className="sr-only">{t("alerts.col.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className={cn("border-t border-border", !s.isActive ? "text-muted-foreground" : "")} data-testid="admin-source-row">
                  <td className="py-2 pr-3 font-medium">
                    <Link to="/w/$ws/sources" params={{ ws }} search={{ source: s.id } as never} className="hover:text-primary">
                      {s.name}
                    </Link>
                  </td>
                  <td className="py-2 pr-3">{t(`sources.connector.${s.kind}` as MessageKey)}</td>
                  <td className="py-2 pr-3 text-xs">{mappingSummary(s.mapping)}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{s.schedule ?? "—"}</td>
                  <td className="py-2">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => set({ wizard: s.id })} data-testid="source-edit-mapping">
                        {t("sources.editMappingShort")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => toggle.mutate(s)} data-testid="source-toggle">
                        {t(s.isActive ? "sources.pause" : "sources.resume")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {toggle.error ? <p role="alert" className="text-sm text-destructive">{toggle.error.message}</p> : null}
      </Card>
    </Page>
  );
}
