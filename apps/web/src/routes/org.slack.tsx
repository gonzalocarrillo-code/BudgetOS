import { Button, cn, Input } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Copy, Link2, Send, Unlink, XCircle } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { api, unwrap } from "../lib/api.js";

/**
 * Org console › Slack (R11-002, R11-003): the organization's connection to Slack, set up once by a
 * superadmin. Linking the bot's Slack team links every workspace of the org: /budget, buttons and
 * DMs work in all of them. Each workspace then picks its own channels in its Settings › Slack.
 */
export const Route = createFileRoute("/org/slack")({ component: OrgSlackPage });

const OrgSlack = z.object({
  secrets: z.object({ botToken: z.boolean(), signingSecret: z.boolean() }),
  team: z.object({ id: z.string(), name: z.string().nullable(), linkedAt: z.string().nullable(), linkedBy: z.string().nullable() }).nullable(),
  urls: z.object({ interactions: z.string(), commands: z.string() }),
  manifest: z.record(z.string(), z.unknown()),
  workspaces: z.array(z.object({ id: z.string(), name: z.string(), defaultChannel: z.string().nullable(), alertChannel: z.string().nullable() })),
});
type OrgSlack = z.infer<typeof OrgSlack>;
const KEY = ["org-slack"];

function OrgSlackPage(): ReactElement {
  const { data, isPending, error } = useQuery({ queryKey: KEY, queryFn: async () => OrgSlack.parse(await unwrap(api.GET("/api/v1/org/integrations/slack", {}))) });
  return (
    <Page title={t("org.slack.title")}>
      <p className="-mt-2 max-w-3xl text-sm text-muted-foreground">{t("org.slack.intro")}</p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      {isPending || !data ? <p className="text-sm text-muted-foreground">{t("shell.loading")}</p> : <Body data={data} />}
    </Page>
  );
}

function Status({ ok, label, testId }: { ok: boolean; label: string; testId?: string }): ReactElement {
  return (
    <li className="flex items-center gap-2 text-sm" data-ok={ok} data-testid={testId}>
      {ok ? <CheckCircle2 className="size-4 text-success" aria-hidden /> : <XCircle className="size-4 text-muted-foreground" aria-hidden />}
      {label}
    </li>
  );
}

function Body({ data }: { data: OrgSlack }): ReactElement {
  const client = useQueryClient();
  const [channel, setChannel] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: async (body: { link?: true; unlink?: true }) => unwrap(api.PATCH("/api/v1/org/integrations/slack", { body: body as never })),
    onSuccess: async (_r, body) => {
      await client.invalidateQueries({ queryKey: KEY });
      await client.invalidateQueries({ queryKey: ["slack"] });
      setNotice(body.link ? t("org.slack.linkedNotice") : t("org.slack.unlinkedNotice"));
    },
  });
  const test = useMutation({
    mutationFn: async () => unwrap(api.POST("/api/v1/org/integrations/slack/test", { body: { channel: channel.trim() } as never })),
    onSuccess: () => setNotice(t("slack.testQueued", { channel: channel.trim() })),
  });
  const secretsOk = data.secrets.botToken && data.secrets.signingSecret;
  const linkWhy = !secretsOk ? t("org.slack.needSecrets") : change.isPending ? t("shell.loading") : null;
  const testWhy = !data.team ? t("org.slack.linkFirst") : !/^[#@]?[A-Za-z0-9._-]{1,80}$/.test(channel.trim()) ? t("slack.needChannel") : test.isPending ? t("shell.loading") : null;
  const copy = (text: string) => void navigator.clipboard?.writeText(text);
  const withChannels = data.workspaces.filter((w) => w.defaultChannel || w.alertChannel).length;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_26rem]">
      <div className="flex flex-col gap-5">
        <Card title={t("slack.connection")}>
          <div className="flex flex-col gap-3" data-testid="org-slack-status">
            <ul className="flex flex-col gap-1.5">
              <Status ok={data.secrets.botToken} label={t("org.slack.botToken")} />
              <Status ok={data.secrets.signingSecret} label={t("org.slack.signingSecret")} />
              <Status ok={data.team !== null} label={data.team ? t("slack.linked", { team: data.team.name ?? data.team.id }) : t("slack.notLinked")} testId="org-slack-team" />
            </ul>
            {data.team?.linkedBy ? (
              <p className="text-xs text-muted-foreground">{t("org.slack.linkedBy", { who: data.team.linkedBy, date: data.team.linkedAt ? new Date(data.team.linkedAt).toLocaleDateString("en", { dateStyle: "medium" }) : "—" })}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {linkWhy ? (
                <Button size="sm" disabled reason={linkWhy}>
                  <Link2 className="size-4" aria-hidden />
                  {data.team ? t("slack.relink") : t("slack.link")}
                </Button>
              ) : (
                <Button size="sm" onClick={() => change.mutate({ link: true })} data-testid="org-slack-link">
                  <Link2 className="size-4" aria-hidden />
                  {data.team ? t("slack.relink") : t("slack.link")}
                </Button>
              )}
              {data.team ? (
                <Button size="sm" variant="ghost" onClick={() => change.mutate({ unlink: true })} data-testid="org-slack-unlink">
                  <Unlink className="size-4" aria-hidden />
                  {t("org.slack.unlink")}
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{t("org.slack.linkHelp")}</p>
            {change.error ? (
              <p role="alert" className="text-sm text-destructive">
                {change.error.message}
              </p>
            ) : null}
            {notice ? (
              <p role="status" className="text-sm text-success" data-testid="org-slack-notice">
                {notice}
              </p>
            ) : null}
          </div>
        </Card>

        <Card title={t("slack.test")}>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t("slack.testChannel")}
              <Input className="w-56" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="#general" data-testid="org-slack-test-channel" />
            </label>
            {testWhy ? (
              <Button variant="outline" disabled reason={testWhy}>
                <Send className="size-4" aria-hidden />
                {t("slack.sendTest")}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => test.mutate()} data-testid="org-slack-send-test">
                <Send className="size-4" aria-hidden />
                {t("slack.sendTest")}
              </Button>
            )}
          </div>
          {test.error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {test.error.message}
            </p>
          ) : null}
        </Card>

        <Card title={t("org.slack.workspaces", { count: withChannels, total: data.workspaces.length })}>
          {data.workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("org.slack.noWorkspaces")}</p>
          ) : (
            <table className="w-full text-sm" data-testid="org-slack-workspaces">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2 font-medium">{t("org.slack.workspace")}</th>
                  <th className="py-1 pr-2 font-medium">{t("slack.defaultChannel")}</th>
                  <th className="py-1 font-medium">{t("slack.alertChannel")}</th>
                </tr>
              </thead>
              <tbody>
                {data.workspaces.map((w) => (
                  <tr key={w.id} className="border-t border-border">
                    <td className="py-1.5 pr-2">
                      <Link to="/w/$ws/admin/slack" params={{ ws: w.id }} className="hover:text-primary">
                        {w.name}
                      </Link>
                    </td>
                    <td className={cn("py-1.5 pr-2", !w.defaultChannel && "text-muted-foreground")}>{w.defaultChannel ?? t("org.slack.noChannel")}</td>
                    <td className={cn("py-1.5", !w.alertChannel && "text-muted-foreground")}>{w.alertChannel ?? t("org.slack.noChannel")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs text-muted-foreground">{t("org.slack.workspacesHelp")}</p>
        </Card>
      </div>

      <Card title={t("slack.setup")}>
        <ol className="flex list-decimal flex-col gap-3 pl-4 text-sm" data-testid="org-slack-setup">
          <li>
            {t("slack.step1")}
            <div className="mt-1.5 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => copy(JSON.stringify(data.manifest, null, 2))} data-testid="org-slack-copy-manifest">
                <Copy className="size-4" aria-hidden />
                {t("slack.copyManifest")}
              </Button>
            </div>
          </li>
          <li>{t("slack.step2")}</li>
          <li>{t("org.slack.step3")}</li>
          <li>
            {t("slack.step4")}
            <UrlRow label={t("slack.interactionsUrl")} url={data.urls.interactions} onCopy={copy} />
            <UrlRow label={t("slack.commandsUrl")} url={data.urls.commands} onCopy={copy} />
          </li>
          <li>{t("org.slack.step5")}</li>
        </ol>
      </Card>
    </div>
  );
}

function UrlRow({ label, url, onCopy }: { label: string; url: string; onCopy: (s: string) => void }): ReactElement {
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 text-xs" title={url}>
        {url}
      </code>
      <button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => onCopy(url)} aria-label={t("slack.copy")}>
        <Copy className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
