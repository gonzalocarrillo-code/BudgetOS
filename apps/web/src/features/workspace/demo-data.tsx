import { Button } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card } from "../../components/page.js";
import { api, unwrap } from "../../lib/api.js";
import { meQuery } from "../../lib/queries.js";

/**
 * Settings › General › Demo data (T-040, R11-004): how many demo budgets and targets this workspace
 * still holds, and removing them in one step. A workspace admin's job, so it lives in the
 * workspace; creating workspaces from templates is the org console's.
 */
export function DemoData({ ws }: { ws: string }): ReactElement {
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const { data: demo } = useQuery({ queryKey: ["demo-data", ws], queryFn: async () => z.object({ envelopes: z.number(), targets: z.number() }).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/demo-data", { params: { path: { ws } } }))) });
  const [confirm, setConfirm] = useState(false);
  const purge = useMutation({
    meta: { success: t("toast.demoRemoved") },
    mutationFn: async () => unwrap(api.POST("/api/v1/workspaces/{ws}/demo-data/purge", { params: { path: { ws } } })),
    onSuccess: async () => {
      setConfirm(false);
      await client.invalidateQueries();
    },
  });
  const canPurge = me?.isOrgAdmin === true || perms.includes("user.manage");
  const purgeWhy = !canPurge ? t("templates.purgeNoPermission") : (demo?.envelopes ?? 0) === 0 ? t("templates.noDemo") : purge.isPending ? t("shell.loading") : null;
  return (
    <Card title={t("templates.demo")}>
      <div className="flex flex-col gap-3 text-sm" data-testid="demo-panel" id="demo-data">
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
        {purge.error ? (
          <p role="alert" className="text-sm text-destructive">
            {purge.error.message}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
