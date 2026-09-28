import { t } from "@budget/ui/i18n";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import { Page } from "../components/page.js";
import { SETTINGS_GROUPS, canSee } from "../components/shell.js";
import { useQuery } from "@tanstack/react-query";
import { meQuery } from "../lib/queries.js";

/** Settings (product feedback 2026-09-28): the workspace's less-visited admin pages, in one place. */
export const Route = createFileRoute("/w/$ws/admin/settings")({ component: SettingsHub });

function SettingsHub(): ReactElement {
  const { ws } = Route.useParams();
  const { data: me } = useQuery(meQuery);
  const groups = me ? SETTINGS_GROUPS.map((g) => ({ ...g, pages: g.pages.filter((p) => canSee(p, me, ws)) })).filter((g) => g.pages.length > 0) : [];
  return (
    <Page title={t("admin.settings")}>
      <p className="-mt-2 text-sm text-muted-foreground">{t("settings.intro")}</p>
      <div className="flex flex-col gap-6" data-testid="settings-hub">
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={`settings-${g.id}`} className="flex flex-col gap-2">
            <h2 id={`settings-${g.id}`} className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {t(g.label)}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {g.pages.map((p) => {
                const Icon = p.icon;
                return (
                  <li key={p.to}>
                    <Link to={p.to} params={{ ws }} className="flex h-full items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-xs hover:border-primary/50 hover:bg-accent/40" data-testid="settings-card">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-primary">
                        <Icon className="size-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{t(p.label)}</span>
                        <span className="mt-0.5 block text-sm text-muted-foreground">{t(p.description)}</span>
                      </span>
                      <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </Page>
  );
}
