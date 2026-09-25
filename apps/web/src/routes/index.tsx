import { t } from "@budget/ui/i18n";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Page } from "../components/page.js";
import { getToken } from "../lib/auth.js";
import { meQuery, type Me } from "../lib/queries.js";

/** `/`: the caller's first workspace. */
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    if (!getToken()) return;
    const me: Me = await context.queryClient.ensureQueryData(meQuery);
    const first = me.workspaces[0];
    if (first) throw redirect({ to: "/w/$ws", params: { ws: first.workspaceId } });
  },
  component: () => (
    <Page title={t("app.name")}>
      <p className="text-sm text-muted-foreground">{t("error.noWorkspace")}</p>
    </Page>
  ),
});
