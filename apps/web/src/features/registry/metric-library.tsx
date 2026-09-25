import { Button } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";
import { toKey } from "./values.js";

export const Metric = z.object({ id: z.string(), key: z.string(), label: z.string(), numerator: z.string(), denominator: z.string().nullable(), multiplier: z.string(), direction: z.string(), format: z.string(), unit: z.string().nullable(), isActive: z.boolean() });
export type Metric = z.infer<typeof Metric>;

export const metricsQuery = (ws: string) =>
  queryOptions({
    queryKey: ["metrics", ws],
    queryFn: async () => z.array(Metric).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/metrics", { params: { path: { ws } } }))),
  });

const source = (s: string) => (s === "spend" ? t("registry.metrics.spend") : s === "budget" ? t("registry.metrics.budget") : s.replace(/^kpi:/, ""));
/** "spend ÷ conversions", "clicks ÷ impressions × 100". */
export const formula = (m: Pick<Metric, "numerator" | "denominator" | "multiplier">) => `${source(m.numerator)}${m.denominator ? ` ÷ ${source(m.denominator)}` : ""}${m.multiplier !== "1" ? ` × ${m.multiplier}` : ""}`;

/**
 * MetricLibrary (spec §18.5, plan §4.8): the org's metrics, derived at query time from facts
 * (never stored). Adding one is the org admin's; `blocked` is why the caller cannot.
 */
export function MetricLibrary({ ws, blocked }: { ws: string; blocked: string | null }): ReactElement {
  const { data: metrics = [], refetch } = useQuery(metricsQuery(ws));
  const [label, setLabel] = useState("");
  const [numerator, setNumerator] = useState("spend");
  const [denominator, setDenominator] = useState("kpi:conversions");
  const [multiplier, setMultiplier] = useState("1");
  const [direction, setDirection] = useState("lower_is_better");
  const [format, setFormat] = useState("currency");
  const key = toKey(label);
  const create = useMutation({
    mutationFn: async () => unwrap(api.POST("/api/v1/workspaces/{ws}/metrics", { params: { path: { ws } }, body: { key, label: label.trim(), numerator, denominator: denominator || null, multiplier, direction, format } as never })),
    onSuccess: async () => {
      setLabel("");
      await refetch();
    },
  });
  const valid = /^(spend|budget|kpi:[a-z][a-z0-9_]{0,62})$/;
  const why = blocked ?? (!key ? t("registry.form.needLabel") : !valid.test(numerator) || (denominator !== "" && !valid.test(denominator)) ? t("registry.metrics.badSource") : !/^\d{1,12}(\.\d{1,6})?$/.test(multiplier) ? t("registry.metrics.badMultiplier") : create.isPending ? t("shell.loading") : null);
  const field = "h-9 rounded-lg border border-input bg-card px-2 text-sm outline-none focus:border-ring";
  return (
    <div className="flex flex-col gap-5" data-testid="metric-library">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-2 pr-3 font-medium">{t("registry.metrics.metric")}</th>
              <th className="py-2 pr-3 font-medium">{t("registry.metrics.formula")}</th>
              <th className="py-2 pr-3 font-medium">{t("registry.metrics.better")}</th>
              <th className="py-2 font-medium">{t("registry.metrics.format")}</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.id} className="border-t border-border" data-testid="metric-row">
                <td className="py-2 pr-3">
                  <span className="font-medium">{m.label}</span> <code className="text-xs text-muted-foreground">{m.key}</code>
                </td>
                <td className="py-2 pr-3 font-mono text-xs">{formula(m)}</td>
                <td className="py-2 pr-3">{t(m.direction === "lower_is_better" ? "registry.metrics.lower" : "registry.metrics.higher")}</td>
                <td className="py-2">{m.format}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-3"
        aria-label={t("registry.metrics.new")}
        onSubmit={(e) => {
          e.preventDefault();
          if (!why) create.mutate();
        }}
      >
        <p className="text-sm font-medium sm:col-span-3">{t("registry.metrics.new")}</p>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("registry.form.label")}
          <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Cost per lead" data-testid="metric-label" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("registry.metrics.numerator")}
          <input className={field} value={numerator} onChange={(e) => setNumerator(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("registry.metrics.denominator")}
          <input className={field} value={denominator} onChange={(e) => setDenominator(e.target.value)} placeholder="kpi:leads" data-testid="metric-denominator" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("registry.metrics.multiplier")}
          <input className={field} value={multiplier} onChange={(e) => setMultiplier(e.target.value)} inputMode="decimal" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("registry.metrics.better")}
          <select className={field} value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="lower_is_better">{t("registry.metrics.lower")}</option>
            <option value="higher_is_better">{t("registry.metrics.higher")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("registry.metrics.format")}
          <select className={field} value={format} onChange={(e) => setFormat(e.target.value)}>
            {["currency", "number", "percent", "ratio"].map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted-foreground sm:col-span-2">
          {key ? t("registry.metrics.preview", { key, formula: formula({ numerator, denominator: denominator || null, multiplier }) }) : t("registry.metrics.help")}
        </p>
        {create.error ? <p role="alert" className="text-sm text-destructive sm:col-span-3">{create.error.message}</p> : null}
        <div className="flex justify-end">
          {why ? (
            <Button disabled reason={why} data-testid="metric-create">
              {t("registry.metrics.add")}
            </Button>
          ) : (
            <Button type="submit" data-testid="metric-create">
              {t("registry.metrics.add")}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
