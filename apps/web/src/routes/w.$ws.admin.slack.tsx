import { Button, cn, Input } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Send, XCircle } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/**
 * Settings › Slack (ADR-046, R11-003): where this workspace's alerts and approvals post, and a
 * test. The connection is the organization's (Org console › Slack): once it is linked, every
 * workspace answers to that Slack team; this page only routes. Alerts carry Acknowledge / Snooze / Resolve, approval
 * requests Approve / Reject, and /budget answers alerts, search and budget questions — each as the
 * Slack user's Budget OS account (matched by email), with that account's permissions.
 */
export const Route = createFileRoute("/w/$ws/admin/slack")({ component: SlackPage });

const SEVERITIES = ["critical", "warning", "info", "data"] as const;
const Settings = z.object({
  connected: z.boolean(),
  team: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  settings: z.object({ defaultChannel: z.string().optional(), alertChannel: z.string().optional(), alertSeverities: z.array(z.string()).default(["critical"]), approvals: z.boolean().default(true), dms: z.boolean().default(true) }),
});
type Settings = z.infer<typeof Settings>;

function SlackPage(): ReactElement {
  const { ws } = Route.useParams();
  const { data: me } = useQuery(meQuery);
  const canManage = me?.isOrgAdmin === true || (me?.workspaces.find((w) => w.workspaceId === ws)?.permissions.includes("user.manage") ?? false);
  const { data, isPending, error } = useQuery({ queryKey: ["slack", ws], queryFn: async () => Settings.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/integrations/slack", { params: { path: { ws } } }))) });
  return (
    <Page title={t("slack.title")}>
      <p className="-mt-2 max-w-3xl text-sm text-muted-foreground">{t("slack.intro")}</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      {isPending || !data ? <p className="text-sm text-muted-foreground">{t("shell.loading")}</p> : <SlackBody ws={ws} data={data} canManage={canManage} isOrgAdmin={me?.isOrgAdmin === true} />}
    </Page>
  );
}

function SlackBody({ ws, data, canManage, isOrgAdmin }: { ws: string; data: Settings; canManage: boolean; isOrgAdmin: boolean }): ReactElement {
  const client = useQueryClient();
  const s = data.settings;
  const [defaultChannel, setDefaultChannel] = useState(s.defaultChannel ?? "");
  const [alertChannel, setAlertChannel] = useState(s.alertChannel ?? "");
  const [severities, setSeverities] = useState<string[]>(s.alertSeverities);
  const [approvals, setApprovals] = useState(s.approvals);
  const [dms, setDms] = useState(s.dms);
  const [testChannel, setTestChannel] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    meta: { success: t("toast.slackSaved") },
    mutationFn: async (body: Record<string, unknown>) => unwrap(api.PATCH("/api/v1/workspaces/{ws}/integrations/slack", { params: { path: { ws } }, body: body as never })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["slack", ws] });
      setNotice(t("slack.saved"));
    },
  });
  const test = useMutation({
    meta: { success: t("toast.slackTest") },
    mutationFn: async () => unwrap(api.POST("/api/v1/workspaces/{ws}/integrations/slack/test", { params: { path: { ws } }, body: (testChannel.trim() ? { channel: testChannel.trim() } : {}) as never })),
    onSuccess: (r) => setNotice(t("slack.testQueued", { channel: String((r as unknown as { channel?: string } | undefined)?.channel ?? "") })),
  });
  const noManage = canManage ? null : t("slack.noPermission");
  const field = "";
  const channelOk = (c: string) => c.trim() === "" || /^[#@]?[A-Za-z0-9._-]{1,80}$/.test(c.trim());
  const saveWhy = noManage ?? (!channelOk(defaultChannel) || !channelOk(alertChannel) ? t("slack.badChannel") : save.isPending ? t("shell.loading") : null);
  const testWhy = noManage ?? (!data.connected ? t("slack.notConnectedShort") : !testChannel.trim() && !s.defaultChannel ? t("slack.needChannel") : test.isPending ? t("shell.loading") : null);

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm shadow-xs" data-testid="slack-status" data-connected={data.connected}>
          {data.connected ? <CheckCircle2 className="size-4 text-success" aria-hidden /> : <XCircle className="size-4 text-muted-foreground" aria-hidden />}
          <span className="flex-1">{data.connected ? t("slack.connectedTo", { team: data.team?.name ?? data.team?.id ?? "Slack" }) : t("slack.notConnectedOrg")}</span>
          {isOrgAdmin ? (
            <Link to="/org/slack" className="font-medium text-primary hover:underline" data-testid="slack-open-org">
              {t("slack.openOrgSlack")} →
            </Link>
          ) : null}
        </div>

        <Card title={t("slack.routing")}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!saveWhy) save.mutate({ defaultChannel: defaultChannel.trim() || null, alertChannel: alertChannel.trim() || null, alertSeverities: severities, approvals, dms });
            }}
            data-testid="slack-routing"
          >
            <Field label={t("slack.defaultChannel")} hint={t("slack.defaultChannelHelp")}>
              <Input className={field} value={defaultChannel} onChange={(e) => setDefaultChannel(e.target.value)} placeholder="#budget-ops" data-testid="slack-default-channel" />
            </Field>
            <Field label={t("slack.alertChannel")} hint={t("slack.alertChannelHelp")}>
              <Input className={field} value={alertChannel} onChange={(e) => setAlertChannel(e.target.value)} placeholder="#budget-alerts" data-testid="slack-alert-channel" />
            </Field>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm font-medium">{t("slack.severities")}</legend>
              <div className="flex flex-wrap gap-3">
                {SEVERITIES.map((sev) => (
                  <label key={sev} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={severities.includes(sev)} onChange={(e) => setSeverities((x) => (e.target.checked ? [...x, sev] : x.filter((y) => y !== sev)))} data-testid={`slack-sev-${sev}`} />
                    {t(`alerts.severity.${sev}` as MessageKey)}
                  </label>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">{t("slack.severitiesHelp")}</span>
            </fieldset>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={approvals} onChange={(e) => setApprovals(e.target.checked)} data-testid="slack-approvals" />
              {t("slack.approvals")}
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={dms} onChange={(e) => setDms(e.target.checked)} data-testid="slack-dms" />
              <span>
                {t("slack.dms")}
                <span className="block text-xs text-muted-foreground">{t("slack.dmsHelp")}</span>
              </span>
            </label>
            {save.error ? <p role="alert" className="text-sm text-destructive">{save.error.message}</p> : null}
            {notice ? <p role="status" className="text-sm text-success" data-testid="slack-notice">{notice}</p> : null}
            <div className="flex justify-end">
              {saveWhy ? (
                <Button disabled reason={saveWhy}>{t("slack.save")}</Button>
              ) : (
                <Button type="submit" data-testid="slack-save">{t("slack.save")}</Button>
              )}
            </div>
          </form>
        </Card>

        <Card title={t("slack.test")}>
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t("slack.testChannel")}>
              <Input className={cn(field, "w-56")} value={testChannel} onChange={(e) => setTestChannel(e.target.value)} placeholder={s.defaultChannel ?? "#budget-ops"} data-testid="slack-test-channel" />
            </Field>
            {testWhy ? (
              <Button variant="outline" disabled reason={testWhy}>
                <Send className="size-4" aria-hidden />
                {t("slack.sendTest")}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => test.mutate()} data-testid="slack-send-test">
                <Send className="size-4" aria-hidden />
                {t("slack.sendTest")}
              </Button>
            )}
          </div>
          {test.error ? <p role="alert" className="mt-2 text-sm text-destructive">{test.error.message}</p> : null}
        </Card>
      </div>

    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactElement {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      {children}
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
