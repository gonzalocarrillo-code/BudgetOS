import { Button } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useState, type ReactElement, type ReactNode } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/** Settings › Workspace (product feedback 2026-09-28): its name, and what identifies it. */
export const Route = createFileRoute("/w/$ws/admin/workspace")({ component: WorkspacePage });

const General = z.object({ id: z.string(), name: z.string(), slug: z.string(), reportingCurrency: z.string(), fiscalYearStartMonth: z.number(), createdAt: z.string() });

function WorkspacePage(): ReactElement {
  const { ws } = Route.useParams();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const canManage = me?.isOrgAdmin === true || (me?.workspaces.find((w) => w.workspaceId === ws)?.permissions.includes("user.manage") ?? false);
  const { data } = useQuery({ queryKey: ["workspace-general", ws], queryFn: async () => General.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/general", { params: { path: { ws } } }))) });
  const [name, setName] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: async (n: string) => unwrap(api.PATCH("/api/v1/workspaces/{ws}/general", { params: { path: { ws } }, body: { name: n } as never })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["workspace-general", ws] });
      await client.invalidateQueries({ queryKey: ["me"] });
      await client.invalidateQueries({ queryKey: ["home", ws] });
      setName(null);
      setSaved(true);
    },
  });
  const value = name ?? data?.name ?? "";
  const why = !canManage ? t("workspace.noPermission") : !value.trim() ? t("workspace.needName") : value.trim() === data?.name ? t("workspace.unchanged") : save.isPending ? t("shell.loading") : null;
  const month = data ? new Date(Date.UTC(2026, data.fiscalYearStartMonth - 1, 1)).toLocaleDateString("en", { month: "long", timeZone: "UTC" }) : "—";
  return (
    <Page title={t("admin.workspace")}>
      <div className="grid max-w-3xl gap-5">
        <Card title={t("workspace.name")}>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!why) save.mutate(value.trim());
            }}
          >
            <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm font-medium">
              {t("workspace.nameLabel")}
              <input className="h-9 rounded-lg border border-input bg-card px-2.5 text-sm font-normal" value={value} onChange={(e) => (setName(e.target.value), setSaved(false))} readOnly={!canManage} title={canManage ? undefined : t("workspace.noPermission")} data-testid="workspace-name-input" />
            </label>
            {why ? (
              <Button type="button" disabled reason={why}>{t("workspace.save")}</Button>
            ) : (
              <Button type="submit" data-testid="workspace-save">{t("workspace.save")}</Button>
            )}
          </form>
          {save.error ? <p role="alert" className="mt-2 text-sm text-destructive">{save.error.message}</p> : null}
          {saved ? <p role="status" className="mt-2 text-sm text-success" data-testid="workspace-saved">{t("workspace.saved")}</p> : null}
        </Card>
        <Card title={t("workspace.details")}>
          <dl className="grid grid-cols-[12rem_1fr] gap-y-2 text-sm" data-testid="workspace-details">
            <Row label={t("workspace.currency")}>{data?.reportingCurrency ?? "—"}</Row>
            <Row label={t("workspace.fiscalStart")}>
              {month} ·{" "}
              <Link to="/w/$ws/admin/periods" params={{ ws }} className="text-primary hover:underline">{t("workspace.changeFiscal")}</Link>
            </Row>
            <Row label={t("workspace.slug")}>
              <code className="text-xs">{data?.slug ?? "—"}</code>
            </Row>
            <Row label={t("workspace.id")}>
              <code className="text-xs">{data?.id ?? "—"}</code>
            </Row>
            <Row label={t("workspace.created")}>{data ? new Date(data.createdAt).toLocaleDateString() : "—"}</Row>
          </dl>
        </Card>
      </div>
    </Page>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
