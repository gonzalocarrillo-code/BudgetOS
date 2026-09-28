import type { TourStep } from "@budget/domain";
import { Button } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { useRef, useState, type ReactElement } from "react";
import { Card, Page } from "../components/page.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";
import { runTour, toursQuery, type Tour } from "../lib/tours.js";

/**
 * Admin › Tours (spec §27): each role's first-run tour, its steps' titles and text. Org admins edit
 * them (agencies add their own process notes); saving publishes a new version, so everyone in the
 * role sees it again. Preview runs it here. Step targets stay the screens' data-tour anchors.
 */
export const Route = createFileRoute("/w/$ws/admin/tours")({ component: ToursAdmin });

function ToursAdmin(): ReactElement {
  const { ws } = Route.useParams();
  const { data: me } = useQuery(meQuery);
  const isOrgAdmin = me?.isOrgAdmin ?? false;
  const { data: tours = [], isPending } = useQuery(toursQuery(ws, true));
  return (
    <Page title={t("admin.tours")}>
      <p className="-mt-2 max-w-3xl text-sm text-muted-foreground">{t("tours.admin.intro")}</p>
      {isPending ? <p className="text-sm text-muted-foreground">{t("shell.loading")}</p> : null}
      {tours.map((tour) => (
        <TourEditor key={`${tour.id}-${tour.version}`} ws={ws} tour={tour} blocked={isOrgAdmin ? null : t("tours.admin.orgAdminOnly")} />
      ))}
    </Page>
  );
}

function TourEditor({ ws, tour, blocked }: { ws: string; tour: Tour; blocked: string | null }): ReactElement {
  const client = useQueryClient();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const pathRef = useRef(path);
  pathRef.current = path;
  const [steps, setSteps] = useState<TourStep[]>(tour.steps);
  const dirty = JSON.stringify(steps) !== JSON.stringify(tour.steps);
  const save = useMutation({
    meta: { success: t("toast.tourSaved"), error: true },
    mutationFn: async () => unwrap(api.PATCH("/api/v1/tours/{id}", { params: { path: { id: tour.id }, header: { "X-Workspace-Id": ws } }, body: { steps } as never })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["tours", ws] }),
  });
  const set = (i: number, patch: Partial<TourStep>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const why = blocked ?? (!dirty ? t("tours.admin.noChanges") : steps.some((s) => !s.title.trim() || !s.description.trim()) ? t("tours.admin.needText") : save.isPending ? t("shell.loading") : null);
  const field = "w-full rounded-md border border-input bg-card px-2 py-1.5 text-sm outline-none focus:border-ring disabled:bg-muted";
  return (
    <Card title={`${tour.name} · ${t(`tours.role.${tour.role}` as MessageKey)}`}>
      <div className="flex flex-col gap-3" data-testid="tour-editor" data-role={tour.role}>
        <p className="text-xs text-muted-foreground">{t("tours.admin.version", { version: tour.version, source: t(tour.isDefault ? "tours.admin.default" : "tours.admin.custom") })}</p>
        <ol className="flex flex-col gap-2">
          {steps.map((s, i) => (
            <li key={`${s.element}-${i}`} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[2rem_1fr]">
              <span className="text-sm font-semibold text-muted-foreground">{i + 1}</span>
              <div className="flex flex-col gap-1.5">
                <span className="font-mono text-[11px] text-muted-foreground">
                  {s.path ?? "/"} · {s.element}
                </span>
                <input className={field} value={s.title} readOnly={blocked !== null} onChange={(e) => set(i, { title: e.target.value.slice(0, 120) })} aria-label={t("tours.admin.stepTitle", { n: i + 1 })} data-testid="tour-step-title" />
                <textarea className={`${field} h-16`} value={s.description} readOnly={blocked !== null} onChange={(e) => set(i, { description: e.target.value.slice(0, 600) })} aria-label={t("tours.admin.stepText", { n: i + 1 })} />
              </div>
            </li>
          ))}
        </ol>
        {save.error ? <p role="alert" className="text-sm text-destructive">{save.error.message}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => void runTour(ws, { ...tour, steps }, (p) => navigate({ to: `/w/$ws${p}` as "/w/$ws", params: { ws } }), () => pathRef.current)} data-testid="tour-preview">
            <Play className="size-4" aria-hidden /> {t("tours.admin.preview")}
          </Button>
          {why ? (
            <Button disabled reason={why} data-testid="tour-save">
              {t("tours.admin.save")}
            </Button>
          ) : (
            <Button onClick={() => save.mutate()} data-testid="tour-save">
              {t("tours.admin.save")}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
