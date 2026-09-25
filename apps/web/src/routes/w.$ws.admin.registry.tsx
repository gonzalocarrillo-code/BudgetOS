import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { DimensionForm } from "../features/registry/dimension-form.js";
import { DimensionIcon } from "../features/registry/dimension-icon.js";
import { HierarchyBuilder } from "../features/registry/hierarchy-builder.js";
import { MetricLibrary } from "../features/registry/metric-library.js";
import { ValueTree } from "../features/registry/value-tree.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery, registryQuery, templatesQuery, type Dimension } from "../lib/queries.js";

/**
 * Registry admin (spec §18.5, plan §4.2 / 0.6): granularities are data. Add your own with an icon
 * from the library, nest their values (`Parent > Child`), say which granularities they nest
 * under, arrange the hierarchies the Explorer follows, and keep the metric library. A change is
 * live at once: filters, search qualifiers and the tree read the registry on every request.
 */
const RegistrySearch = z.object({ tab: z.enum(["granularities", "hierarchies", "metrics"]).default("granularities"), dim: z.string().optional() });
type RegistrySearch = z.infer<typeof RegistrySearch>;

export const Route = createFileRoute("/w/$ws/admin/registry")({ validateSearch: RegistrySearch, component: RegistryPage });

const TABS = [
  { id: "granularities", label: "registry.tab.granularities" },
  { id: "hierarchies", label: "registry.tab.hierarchies" },
  { id: "metrics", label: "registry.tab.metrics" },
] as const;

function RegistryPage(): ReactElement {
  const { ws } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const { data: dims = [] } = useQuery(registryQuery(ws));
  const { data: templates = [] } = useQuery(templatesQuery(ws));
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const isOrgAdmin = me?.isOrgAdmin ?? false;
  const canManage = perms.includes("registry.manage") || isOrgAdmin;
  const set = (s: Partial<RegistrySearch>) => void navigate({ search: (prev: RegistrySearch) => ({ ...prev, ...s }) });
  // Everything that reads the registry: the Explorer's filters and tree, ⌘K qualifiers.
  const refresh = async () => {
    await Promise.all([client.invalidateQueries({ queryKey: ["registry", ws] }), client.invalidateQueries({ queryKey: ["templates", ws] }), client.invalidateQueries({ queryKey: ["suggest", ws] })]);
  };
  const selected = search.dim === "new" ? null : (dims.find((d) => d.id === search.dim) ?? dims[0] ?? null);
  const creating = search.dim === "new" || (dims.length === 0 && canManage);
  const blockedFor = (d: Dimension | null) => (!canManage ? t("registry.blocked.role") : d && d.workspaceId === null && !isOrgAdmin ? t("registry.blocked.orgWide") : null);

  return (
    <Page title={t("admin.registry")}>
      <div role="tablist" className="inline-flex w-fit rounded-lg border border-border bg-card p-0.5">
        {TABS.map((x) => (
          <button key={x.id} type="button" role="tab" aria-selected={search.tab === x.id} className={cn("h-8 rounded-md px-3 text-sm", search.tab === x.id ? "bg-primary text-primary-foreground" : "text-foreground/80 hover:bg-accent")} onClick={() => set({ tab: x.id })} data-testid={`registry-tab-${x.id}`}>
            {t(x.label)}
          </button>
        ))}
      </div>
      {search.tab === "granularities" ? (
        <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
          <Card>
            <div className="flex flex-col gap-3">
              {canManage ? (
                <Button onClick={() => set({ dim: "new" })} data-testid="dim-new" data-tour="registry-new">
                  <Plus className="size-4" aria-hidden />
                  {t("registry.new")}
                </Button>
              ) : (
                <Button disabled reason={t("registry.blocked.role")} data-testid="dim-new">
                  <Plus className="size-4" aria-hidden />
                  {t("registry.new")}
                </Button>
              )}
              <DimensionList ws={ws} dims={dims} selectedId={creating ? null : (selected?.id ?? null)} onPick={(id) => set({ dim: id })} />
            </div>
          </Card>
          <div className="flex flex-col gap-5">
            {creating ? (
              <Card title={t("registry.form.newTitle")}>
                <DimensionForm key="new" ws={ws} dims={dims} dim={null} isOrgAdmin={isOrgAdmin} blocked={blockedFor(null)} onSaved={async (id) => (await refresh(), set({ dim: id }))} />
              </Card>
            ) : selected ? (
              <>
                <DimensionHeader ws={ws} dim={selected} blocked={blockedFor(selected)} onChanged={refresh} />
                <Card title={t("registry.values.title", { name: selected.label })}>
                  <ValueTree key={selected.id} ws={ws} dim={selected} blocked={blockedFor(selected)} onChanged={refresh} />
                </Card>
                <Card title={t("registry.settings")}>
                  <DimensionForm key={selected.id} ws={ws} dims={dims} dim={selected} isOrgAdmin={isOrgAdmin} blocked={blockedFor(selected)} onSaved={refresh} />
                </Card>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {search.tab === "hierarchies" ? (
        <Card>
          <HierarchyBuilder ws={ws} dims={dims} templates={templates} blocked={canManage ? null : t("registry.blocked.role")} onSaved={refresh} />
        </Card>
      ) : null}
      {search.tab === "metrics" ? (
        <Card>
          <MetricLibrary ws={ws} blocked={isOrgAdmin ? null : t("registry.blocked.metrics")} />
        </Card>
      ) : null}
    </Page>
  );
}

function DimensionList({ ws, dims, selectedId, onPick }: { ws: string; dims: Dimension[]; selectedId: string | null; onPick: (id: string) => void }): ReactElement {
  const groups = [
    { label: t("registry.list.workspace"), items: dims.filter((d) => d.workspaceId !== null) },
    { label: t("registry.list.org"), items: dims.filter((d) => d.workspaceId === null) },
  ].filter((g) => g.items.length);
  return (
    <nav aria-label={t("registry.tab.granularities")} className="flex flex-col gap-3" data-testid="dimension-list">
      {groups.map((g) => (
        <div key={g.label}>
          <p className="mb-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{g.label}</p>
          <ul className="flex flex-col gap-0.5">
            {g.items.map((d) => (
              <li key={d.id}>
                <button type="button" aria-current={selectedId === d.id} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm", selectedId === d.id ? "bg-primary text-primary-foreground" : "hover:bg-accent", !d.isActive ? "opacity-60" : "")} onClick={() => onPick(d.id)} data-testid="dimension-item" data-key={d.key}>
                  <DimensionIcon ws={ws} icon={d.icon} />
                  <span className="min-w-0 flex-1 truncate">{d.label}</span>
                  <span className={cn("text-xs", selectedId === d.id ? "text-primary-foreground/80" : "text-muted-foreground")}>{d.isActive ? d.values.filter((v) => v.isActive).length : t("registry.retired")}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function DimensionHeader({ ws, dim, blocked, onChanged }: { ws: string; dim: Dimension; blocked: string | null; onChanged: () => Promise<void> }): ReactElement {
  const toggle = useMutation({
    mutationFn: async () => unwrap(api.PATCH("/api/v1/dimensions/{id}", { params: { path: { id: dim.id }, header: { "X-Workspace-Id": ws } }, body: { isActive: !dim.isActive } as never })),
    onSuccess: onChanged,
  });
  const label = t(dim.isActive ? "registry.retireDim" : "registry.restoreDim");
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-5 py-4 shadow-xs" data-testid="dimension-header">
      <span className="inline-flex size-10 items-center justify-center rounded-lg bg-secondary text-secondary-foreground" aria-hidden>
        <DimensionIcon ws={ws} icon={dim.icon} className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold tracking-[-0.015em]">{dim.label}</h2>
        <p className="text-xs text-muted-foreground">
          <code>{dim.key}</code> · {t(dim.workspaceId === null ? "registry.list.org" : "registry.list.workspace")}
          {dim.allowedParents.length ? ` · ${t("registry.nestsUnder", { keys: dim.allowedParents.join(", ") })}` : ""}
          {dim.isRequiredForLeaf ? ` · ${t("registry.requiredShort")}` : ""}
          {!dim.isActive ? ` · ${t("registry.retired")}` : ""}
        </p>
        {dim.description ? <p className="mt-1 text-sm text-muted-foreground">{dim.description}</p> : null}
      </div>
      {toggle.error ? <p role="alert" className="text-xs text-destructive">{toggle.error.message}</p> : null}
      {blocked || toggle.isPending ? (
        <Button variant="outline" size="sm" disabled reason={blocked ?? t("shell.loading")}>
          {label}
        </Button>
      ) : (
        <Button variant={dim.isActive ? "outline" : "default"} size="sm" onClick={() => toggle.mutate()} data-testid="dim-toggle">
          {label}
        </Button>
      )}
    </div>
  );
}
