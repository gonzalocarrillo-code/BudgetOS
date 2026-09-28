import { Button } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LayoutTemplate, Trash2 } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/**
 * Admin › Workspace templates (spec §27, plan §11.7 "Templates"): start a new workspace from a
 * template — registry, a hierarchy, approval policies, pacing rules, a sample view and a tour per
 * role — optionally with demo data; and remove this workspace's demo data in one click.
 */
export const Route = createFileRoute("/w/$ws/admin/templates")({ component: TemplatesAdmin });

const Template = z.object({ id: z.string().uuid(), key: z.string(), name: z.string(), description: z.string().nullable(), builtIn: z.boolean(), counts: z.record(z.string(), z.number()) });

function TemplatesAdmin(): ReactElement {
  const { ws } = Route.useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const isOrgAdmin = me?.isOrgAdmin ?? false;
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const { data: templates = [] } = useQuery({ queryKey: ["workspace-templates"], enabled: isOrgAdmin, queryFn: async () => z.array(Template).parse(await unwrap(api.GET("/api/v1/workspace-templates", {}))) });
  const { data: demo } = useQuery({ queryKey: ["demo-data", ws], queryFn: async () => z.object({ envelopes: z.number(), targets: z.number() }).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/demo-data", { params: { path: { ws } } }))) });
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [withDemo, setWithDemo] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const chosen = templateId || templates[0]?.id || "";
  const create = useMutation({
    mutationFn: async () => z.object({ id: z.string(), elapsedMs: z.number() }).passthrough().parse(await unwrap(api.POST("/api/v1/workspaces", { body: { name, templateId: chosen, withDemoData: withDemo } as never }))),
    onSuccess: async (w) => {
      await client.invalidateQueries({ queryKey: ["me"] });
      void navigate({ to: "/w/$ws/home", params: { ws: w.id } });
    },
  });
  const purge = useMutation({
    meta: { success: t("toast.demoRemoved") },
    mutationFn: async () => unwrap(api.POST("/api/v1/workspaces/{ws}/demo-data/purge", { params: { path: { ws } } })),
    onSuccess: async () => {
      setConfirm(false);
      await client.invalidateQueries();
    },
  });
  const createWhy = !isOrgAdmin ? t("templates.orgAdminOnly") : !name.trim() ? t("templates.needName") : !chosen ? t("templates.needTemplate") : create.isPending ? t("templates.creating") : null;
  const canPurge = isOrgAdmin || perms.includes("user.manage");
  const purgeWhy = !canPurge ? t("templates.purgeNoPermission") : (demo?.envelopes ?? 0) === 0 ? t("templates.noDemo") : purge.isPending ? t("shell.loading") : null;
  const field = "h-9 w-full rounded-md border border-input bg-card px-3 text-sm outline-none focus:border-ring";

  return (
    <Page title={t("admin.templates")}>
      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card title={t("templates.new")}>
          <div className="flex flex-col gap-4" data-testid="workspace-create">
            <div className="grid gap-3 sm:grid-cols-2">
              {templates.map((tp) => (
                <label key={tp.id} className={`flex cursor-pointer flex-col gap-1 rounded-xl border p-4 ${chosen === tp.id ? "border-primary bg-secondary" : "border-border hover:bg-accent/50"}`} data-testid="template-card">
                  <span className="flex items-center gap-2 font-semibold">
                    <input type="radio" name="template" checked={chosen === tp.id} onChange={() => setTemplateId(tp.id)} />
                    <LayoutTemplate className="size-4 text-primary" aria-hidden /> {tp.name}
                  </span>
                  <span className="text-xs text-muted-foreground">{tp.description}</span>
                  <span className="text-xs text-muted-foreground">{t("templates.counts", { dimensions: tp.counts["dimensions"] ?? 0, policies: tp.counts["policies"] ?? 0, rules: tp.counts["rules"] ?? 0, tours: tp.counts["tours"] ?? 0 })}</span>
                </label>
              ))}
              {!isOrgAdmin ? <p className="text-sm text-muted-foreground">{t("templates.orgAdminOnly")}</p> : null}
            </div>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">{t("templates.name")}</span>
              <input className={field} value={name} onChange={(e) => setName(e.target.value.slice(0, 120))} placeholder={t("templates.namePlaceholder")} data-testid="workspace-name" />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={withDemo} onChange={(e) => setWithDemo(e.target.checked)} data-testid="workspace-demo" />
              {t("templates.withDemo")}
            </label>
            {create.error ? <p role="alert" className="text-sm text-destructive">{create.error.message}</p> : null}
            <div className="flex justify-end">
              {createWhy ? (
                <Button disabled reason={createWhy} data-testid="workspace-create-submit">
                  {t("templates.create")}
                </Button>
              ) : (
                <Button onClick={() => create.mutate()} data-testid="workspace-create-submit">
                  {t("templates.create")}
                </Button>
              )}
            </div>
          </div>
        </Card>
        <Card title={t("templates.demo")}>
          <div className="flex flex-col gap-3 text-sm" data-testid="demo-panel">
            <p className="text-muted-foreground" data-testid="demo-count">
              {(demo?.envelopes ?? 0) > 0 ? t("templates.demoCount", { envelopes: demo?.envelopes ?? 0, targets: demo?.targets ?? 0 }) : t("templates.noDemo")}
            </p>
            {confirm ? (
              <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <p>{t("templates.purgeConfirm")}</p>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
                    {t("experiments.cancel")}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => purge.mutate()} data-testid="demo-purge-confirm">
                    {t("templates.purge")}
                  </Button>
                </div>
              </div>
            ) : purgeWhy ? (
              <Button variant="outline" disabled reason={purgeWhy} data-testid="demo-purge">
                <Trash2 className="size-4" aria-hidden /> {t("templates.purge")}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setConfirm(true)} data-testid="demo-purge">
                <Trash2 className="size-4" aria-hidden /> {t("templates.purge")}
              </Button>
            )}
            {purge.error ? <p role="alert" className="text-sm text-destructive">{purge.error.message}</p> : null}
          </div>
        </Card>
      </div>
    </Page>
  );
}
