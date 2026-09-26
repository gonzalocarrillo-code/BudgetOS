import { cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { NamingTemplate, NamingTemplateBuilder, type Kind } from "../features/registry/naming-template-builder.js";
import { can } from "../features/ops/queries.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/**
 * Naming templates (spec §24, T-036): how envelopes are shown (display name) and keyed for
 * matching actuals (match key). One active template of each kind; saving renames every envelope.
 */
const NamingSearch = z.object({ kind: z.enum(["display", "match_key"]).default("display") });
type NamingSearch = z.infer<typeof NamingSearch>;
export const Route = createFileRoute("/w/$ws/admin/naming")({ validateSearch: NamingSearch, component: NamingPage });

const templatesQuery = (ws: string) =>
  queryOptions({
    queryKey: ["naming-templates", ws],
    queryFn: async () => z.array(NamingTemplate).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/naming-templates", { params: { path: { ws } } }))),
  });

function NamingPage(): ReactElement {
  const { ws } = Route.useParams();
  const { kind } = Route.useSearch();
  const navigate = Route.useNavigate();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const blocked = can(perms, me?.isOrgAdmin ?? false, "registry.manage") ? null : t("naming.noPermission");
  const { data: templates, isPending } = useQuery(templatesQuery(ws));
  const [notice, setNotice] = useState<string | null>(null);
  const current = templates?.find((x) => x.kind === kind && x.isActive) ?? templates?.find((x) => x.kind === kind) ?? null;

  return (
    <Page title={t("admin.naming")}>
      <div role="tablist" className="inline-flex w-fit rounded-lg border border-border bg-card p-0.5">
        {(["display", "match_key"] as Kind[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={cn("h-8 rounded-md px-3 text-sm", kind === k ? "bg-primary text-primary-foreground" : "text-foreground/80 hover:bg-accent")} onClick={() => (setNotice(null), void navigate({ search: (prev: NamingSearch) => ({ ...prev, kind: k }) }))} data-testid={`naming-tab-${k}`}>
            {t(k === "display" ? "naming.tab.display" : "naming.tab.matchKey")}
          </button>
        ))}
      </div>
      {notice ? <p role="status" className="rounded-lg border border-success/40 bg-success/10 px-4 py-2 text-sm" data-testid="naming-notice">{notice}</p> : null}
      <Card>
        {isPending ? (
          <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
        ) : (
          <NamingTemplateBuilder
            key={`${kind}-${current?.id ?? "new"}-${current?.version ?? 0}`}
            ws={ws}
            kind={kind}
            current={current}
            blocked={blocked}
            onSaved={async (r) => {
              setNotice(r.queued ? t("naming.savedQueued") : t("naming.saved", { n: r.recomputed }));
              await client.invalidateQueries({ queryKey: ["naming-templates", ws] });
              await client.invalidateQueries({ queryKey: ["envelope", ws] });
            }}
          />
        )}
      </Card>
    </Page>
  );
}
