import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { CircleHelp, Compass, X } from "lucide-react";
import { useRef, useState, type ReactElement } from "react";
import { markTour, runTour, toursQuery, type Tour } from "../../lib/tours.js";

/**
 * Tours (spec §27, plan §11.7 "re-launchable from Help"). They never start by themselves (UX-001:
 * an auto-started tour navigated people away from the page they asked for): Home shows an
 * invitation for the first tour the caller's roles have not finished or skipped, and Help lists
 * every tour for their roles.
 */
function useStartTour(ws: string) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const pathRef = useRef(path);
  pathRef.current = path;
  return (tour: Tour) =>
    void runTour(ws, tour, (p) => navigate({ to: `/w/$ws${p}` as "/w/$ws", params: { ws } }), () => pathRef.current).then(() => client.invalidateQueries({ queryKey: ["tours", ws] }));
}

export function TourLauncher({ ws }: { ws: string }): ReactElement {
  const start = useStartTour(ws);
  const { data: all = [] } = useQuery(toursQuery(ws, true));
  const [open, setOpen] = useState(false);
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
            <button key={x.id} type="button" role="menuitem" className={cn("flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent")} onClick={() => (setOpen(false), start(x))} data-testid="tour-start" data-role={x.role}>
              <span>{x.name}</span>
              <span className="text-xs text-muted-foreground">{x.completed ? t("tour.completed") : x.dismissed ? t("tour.skipped") : t("tour.new")}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Home's invitation to the first tour the caller has neither finished nor skipped at its version. */
export function TourInvite({ ws }: { ws: string }): ReactElement | null {
  const client = useQueryClient();
  const start = useStartTour(ws);
  const { data: pending = [] } = useQuery(toursQuery(ws, false));
  const skip = useMutation({ mutationFn: (tour: Tour) => markTour(ws, tour, true), onSuccess: () => client.invalidateQueries({ queryKey: ["tours", ws] }) });
  const tour = pending[0];
  if (!tour) return null;
  return (
    <div role="region" aria-label={t("tour.invite.label")} className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/25 bg-secondary px-4 py-3 text-sm" data-testid="tour-invite" data-role={tour.role}>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-card text-primary">
        <Compass className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{t("tour.invite.title", { name: tour.name })}</span>
        <span className="block text-muted-foreground">{t("tour.invite.body", { steps: tour.steps.length })}</span>
      </span>
      <Button size="sm" onClick={() => start(tour)} data-testid="tour-invite-start">
        {t("tour.invite.start")}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => skip.mutate(tour)} data-testid="tour-invite-skip">
        <X className="size-4" aria-hidden />
        {t("tour.invite.skip")}
      </Button>
    </div>
  );
}
