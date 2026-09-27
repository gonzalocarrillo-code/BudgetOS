import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { CircleHelp } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { runTour, toursQuery, tourRunning, type Tour } from "../../lib/tours.js";

/**
 * First-run tours and the Help menu (spec §27, plan §11.7 "re-launchable from Help"). The first
 * tour the caller's roles have not completed starts once per session after sign-in; Help lists
 * every tour for their roles and starts any of them again.
 */
const started = new Set<string>();

export function TourLauncher({ ws }: { ws: string }): ReactElement {
  const client = useQueryClient();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const pathRef = useRef(path);
  pathRef.current = path;
  const { data: pending = [] } = useQuery(toursQuery(ws, false));
  const { data: all = [] } = useQuery(toursQuery(ws, true));
  const [open, setOpen] = useState(false);

  const start = (tour: Tour) => {
    started.add(tour.id);
    setOpen(false);
    void runTour(ws, tour, (p) => navigate({ to: `/w/$ws${p}` as "/w/$ws", params: { ws } }), () => pathRef.current).then(() => client.invalidateQueries({ queryKey: ["tours", ws] }));
  };

  // Starting a tour is UI, not fetching: once the pending list arrives, run the first new one.
  useEffect(() => {
    const next = pending.find((x) => !started.has(x.id));
    if (next && !tourRunning()) start(next);
  }, [pending]);

  return (
    <div className="relative">
      <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" data-testid="help-menu">
        <CircleHelp className="size-4" aria-hidden />
        {t("tour.help")}
      </Button>
      {open ? (
        <div role="menu" className="absolute right-0 top-10 z-40 w-72 rounded-xl border border-border bg-card p-2 shadow-lg" data-testid="help-tours">
          <p className="px-2 pb-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{t("tour.tours")}</p>
          {all.length === 0 ? <p className="px-2 py-1.5 text-sm text-muted-foreground">{t("tour.none")}</p> : null}
          {all.map((x) => (
            <button key={x.id} type="button" role="menuitem" className={cn("flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent")} onClick={() => start(x)} data-testid="tour-start" data-role={x.role}>
              <span>{x.name}</span>
              <span className="text-xs text-muted-foreground">{x.completed ? t("tour.completed") : t("tour.new")}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
