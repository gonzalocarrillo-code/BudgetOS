import { Button, Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { CircleHelp, Compass, Keyboard, X } from "lucide-react";
import { useRef, type ReactElement } from "react";
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

export function TourLauncher({ ws, onShortcuts }: { ws: string; onShortcuts?: () => void }): ReactElement {
  const start = useStartTour(ws);
  const { data: all = [] } = useQuery(toursQuery(ws, true));
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t("tour.help")} data-testid="help-menu">
          <CircleHelp className="size-4" aria-hidden />
          <span className="hidden xl:inline">{t("tour.help")}</span>
        </Button>
      </MenuTrigger>
      <MenuContent className="w-72" data-testid="help-tours">
        <MenuLabel>{t("tour.tours")}</MenuLabel>
        {all.length === 0 ? <p className="px-2.5 py-1.5 text-sm text-muted-foreground">{t("tour.none")}</p> : null}
        {all.map((x) => (
          <MenuItem key={x.id} onSelect={() => start(x)} className="justify-between" data-testid="tour-start" data-role={x.role}>
            <span>{x.name}</span>
            <span className="text-xs text-muted-foreground">{x.completed ? t("tour.completed") : x.dismissed ? t("tour.skipped") : t("tour.new")}</span>
          </MenuItem>
        ))}
        {onShortcuts ? (
          <>
            <MenuSeparator />
            <MenuItem onSelect={onShortcuts} data-testid="help-shortcuts">
              <Keyboard className="size-4 text-muted-foreground" aria-hidden />
              {t("shortcuts.title")}
              <Kbd className="ml-auto">?</Kbd>
            </MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
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
