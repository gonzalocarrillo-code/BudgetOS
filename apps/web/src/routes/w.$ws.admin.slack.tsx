import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Copy, Link2, Send, XCircle } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/**
 * Admin › Slack (product feedback 2026-09-28, ADR-046): connect the Budget OS bot, choose where
 * alerts and approvals post, send a test. Alerts carry Acknowledge / Snooze / Resolve, approval
 * requests Approve / Reject, and /budget answers alerts, search and budget questions — each as the
 * Slack user's Budget OS account (matched by email), with that account's permissions.
 */
export const Route = createFileRoute("/w/$ws/admin/slack")({ component: SlackPage });

const SEVERITIES = ["critical", "warning", "info", "data"] as const;
const Settings = z.object({
  connected: z.object({ botToken: z.boolean(), signingSecret: z.boolean() }),
  settings: z.object({ teamId: z.string().optional(), teamName: z.string().optional(), defaultChannel: z.string().optional(), alertChannel: z.string().optional(), alertSeverities: z.array(z.string()).default(["critical"]), approvals: z.boolean().default(true) }),
  urls: z.object({ interactions: z.string(), commands: z.string() }),
  manifest: z.record(z.string(), z.unknown()),
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
      {isPending || !data ? <p className="text-sm text-muted-foreground">{t("shell.loading")}</p> : <SlackBody ws={ws} data={data} canManage={canManage} />}
    </Page>
  );
}

function Status({ ok, label }: { ok: boolean; label: string }): ReactElement {
  return (
    <li className="flex items-center gap-2 text-sm" data-ok={ok}>
      {ok ? <CheckCircle2 className="size-4 text-success" aria-hidden /> : <XCircle className="size-4 text-muted-foreground" aria-hidden />}
      {label}
    </li>
  );
}

function SlackBody({ ws, data, canManage }: { ws: string; data: Settings; canManage: boolean }): ReactElement {
  const client = useQueryClient();
  const s = data.settings;
  const [defaultChannel, setDefaultChannel] = useState(s.defaultChannel ?? "");
  const [alertChannel, setAlertChannel] = useState(s.alertChannel ?? "");
  const [severities, setSeverities] = useState<string[]>(s.alertSeverities);
  const [approvals, setApprovals] = useState(s.approvals);
  const [testChannel, setTestChannel] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const connected = data.connected.botToken && data.connected.signingSecret;
  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) => unwrap(api.PATCH("/api/v1/workspaces/{ws}/integrations/slack", { params: { path: { ws } }, body: body as never })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["slack", ws] });
      setNotice(t("slack.saved"));
    },
  });
  const test = useMutation({
    mutationFn: async () => unwrap(api.POST("/api/v1/workspaces/{ws}/integrations/slack/test", { params: { path: { ws } }, body: (testChannel.trim() ? { channel: testChannel.trim() } : {}) as never })),
    onSuccess: (r) => setNotice(t("slack.testQueued", { channel: String((r as unknown as { channel?: string } | undefined)?.channel ?? "") })),
  });
  const noManage = canManage ? null : t("slack.noPermission");
  const field = "h-9 rounded-lg border border-input bg-card px-2 text-sm";
  const channelOk = (c: string) => c.trim() === "" || /^[#@]?[A-Za-z0-9._-]{1,80}$/.test(c.trim());
  const saveWhy = noManage ?? (!channelOk(defaultChannel) || !channelOk(alertChannel) ? t("slack.badChannel") : save.isPending ? t("shell.loading") : null);
  const linkWhy = noManage ?? (!data.connected.botToken ? t("slack.needToken") : save.isPending ? t("shell.loading") : null);
  const testWhy = noManage ?? (!data.connected.botToken ? t("slack.needToken") : !testChannel.trim() && !s.defaultChannel ? t("slack.needChannel") : test.isPending ? t("shell.loading") : null);
  const copy = (text: string) => void navigator.clipboard?.writeText(text);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_24rem]">
      <div className="flex flex-col gap-5">
        <Card title={t("slack.connection")}>
          <div className="flex flex-col gap-3" data-testid="slack-status">
            <ul className="flex flex-col gap-1.5">
              <Status ok={data.connected.botToken} label={t("slack.botToken")} />
              <Status ok={data.connected.signingSecret} label={t("slack.signingSecret")} />
              <Status ok={Boolean(s.teamId)} label={s.teamId ? t("slack.linked", { team: s.teamName ?? s.teamId }) : t("slack.notLinked")} />
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              {linkWhy ? (
                <Button size="sm" disabled reason={linkWhy}>
                  <Link2 className="size-4" aria-hidden />
                  {s.teamId ? t("slack.relink") : t("slack.link")}
                </Button>
              ) : (
                <Button size="sm" onClick={() => save.mutate({ link: true })} data-testid="slack-link">
                  <Link2 className="size-4" aria-hidden />
                  {s.teamId ? t("slack.relink") : t("slack.link")}
                </Button>
              )}
              {!connected ? <span className="text-xs text-muted-foreground">{t("slack.setupFirst")}</span> : null}
            </div>
          </div>
        </Card>

        <Card title={t("slack.routing")}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!saveWhy) save.mutate({ defaultChannel: defaultChannel.trim() || null, alertChannel: alertChannel.trim() || null, alertSeverities: severities, approvals });
            }}
            data-testid="slack-routing"
          >
            <Field label={t("slack.defaultChannel")} hint={t("slack.defaultChannelHelp")}>
              <input className={field} value={defaultChannel} onChange={(e) => setDefaultChannel(e.target.value)} placeholder="#budget-ops" data-testid="slack-default-channel" />
            </Field>
            <Field label={t("slack.alertChannel")} hint={t("slack.alertChannelHelp")}>
              <input className={field} value={alertChannel} onChange={(e) => setAlertChannel(e.target.value)} placeholder="#budget-alerts" data-testid="slack-alert-channel" />
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
              <input className={cn(field, "w-56")} value={testChannel} onChange={(e) => setTestChannel(e.target.value)} placeholder={s.defaultChannel ?? "#budget-ops"} data-testid="slack-test-channel" />
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

      <Card title={t("slack.setup")}>
        <ol className="flex list-decimal flex-col gap-3 pl-4 text-sm" data-testid="slack-setup">
          <li>
            {t("slack.step1")}
            <div className="mt-1.5 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => copy(JSON.stringify(data.manifest, null, 2))} data-testid="slack-copy-manifest">
                <Copy className="size-4" aria-hidden />
                {t("slack.copyManifest")}
              </Button>
            </div>
          </li>
          <li>{t("slack.step2")}</li>
          <li>
            {t("slack.step3")}
            <code className="mt-1 block rounded bg-surface px-2 py-1 text-xs">SLACK_BOT_TOKEN · SLACK_SIGNING_SECRET · API_PUBLIC_URL · APP_BASE_URL</code>
          </li>
          <li>
            {t("slack.step4")}
            <UrlRow label={t("slack.interactionsUrl")} url={data.urls.interactions} onCopy={copy} />
            <UrlRow label={t("slack.commandsUrl")} url={data.urls.commands} onCopy={copy} />
          </li>
          <li>{t("slack.step5")}</li>
        </ol>
        <p className="mt-3 text-xs text-muted-foreground">{t("slack.localNote")}</p>
      </Card>
    </div>
  );
}

function UrlRow({ label, url, onCopy }: { label: string; url: string; onCopy: (s: string) => void }): ReactElement {
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 text-xs" title={url}>{url}</code>
      <button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => onCopy(url)} aria-label={t("slack.copy")}>
        <Copy className="size-3.5" aria-hidden />
      </button>
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
