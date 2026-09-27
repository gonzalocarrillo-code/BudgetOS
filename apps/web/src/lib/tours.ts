import { TourStep } from "@budget/domain";
import { t } from "@budget/ui/i18n";
import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { z } from "zod";
import { api, unwrap } from "./api.js";

/**
 * Guided tours (spec §27, plan §11.7) on driver.js (MIT). A tour's steps point at `[data-tour="…"]`
 * elements; a step with a `path` other than the current page navigates there first and waits for
 * its element. Finishing the last step (or closing on it) records completion for that version, so
 * the first-run tour does not come back until an admin publishes a new version.
 */

export const Tour = z.object({ id: z.string().uuid(), role: z.string(), name: z.string(), steps: z.array(TourStep), version: z.number(), completed: z.boolean(), isDefault: z.boolean() }).passthrough();
export type Tour = z.infer<typeof Tour>;

export const toursQuery = (ws: string, all: boolean) => ({
  queryKey: ["tours", ws, all],
  queryFn: async () => z.array(Tour).parse(await unwrap(api.GET("/api/v1/tours", { params: { header: { "X-Workspace-Id": ws }, query: (all ? { all: "true" } : {}) as never } }))),
});

let running: Driver | null = null;
export const tourRunning = () => running !== null;

async function waitFor(selector: string, ms = 8000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (document.querySelector(selector)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Runs a tour. `go(path)` navigates within the workspace (a TanStack navigate). Resolves when the
 * tour ends; `finished` is true when the user reached the last step.
 */
export async function runTour(ws: string, tour: Tour, go: (path: string) => Promise<void> | void, currentPath: () => string): Promise<{ finished: boolean }> {
  if (running) running.destroy();
  const base = `/w/${ws}`;
  const at = async (i: number) => {
    const step = tour.steps[i];
    if (!step) return;
    if (step.path && !currentPath().endsWith(`${base}${step.path}`.replace(/\/$/, ""))) await go(step.path);
    await waitFor(step.element);
  };
  await at(0);
  return new Promise((resolve) => {
    let finished = false;
    const d = driver({
      showProgress: true,
      allowClose: true,
      overlayOpacity: 0.45,
      stagePadding: 6,
      stageRadius: 10,
      popoverClass: "bt-tour",
      progressText: t("tour.progress"),
      nextBtnText: t("tour.next"),
      prevBtnText: t("tour.back"),
      doneBtnText: t("tour.done"),
      steps: tour.steps.map((s) => ({ element: s.element, popover: { title: s.title, description: s.description } })),
      onNextClick: (_el, _step, { state }) => {
        const i = state.activeIndex ?? 0;
        if (i >= tour.steps.length - 1) {
          finished = true;
          d.destroy();
          return;
        }
        void at(i + 1).then(() => d.moveNext());
      },
      onPrevClick: (_el, _step, { state }) => {
        const i = state.activeIndex ?? 0;
        if (i > 0) void at(i - 1).then(() => d.movePrevious());
      },
      onDestroyed: () => {
        running = null;
        if (finished) void unwrap(api.POST("/api/v1/tours/{id}/complete", { params: { path: { id: tour.id }, header: { "X-Workspace-Id": ws } }, body: { version: tour.version } as never })).finally(() => resolve({ finished }));
        else resolve({ finished });
      },
    });
    running = d;
    d.drive();
  });
}
