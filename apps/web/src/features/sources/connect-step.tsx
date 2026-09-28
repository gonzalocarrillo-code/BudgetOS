import { SourceConfig } from "@budget/domain";
import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { Database, FileSpreadsheet, FileUp, Snowflake } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";

/**
 * Step 1 of a new data source (product feedback 2026-09-28): where the data comes from. BigQuery
 * and Snowflake (the client's warehouse, read only), Google Sheets, or a CSV file. A warehouse or
 * sheet takes its connection (never credentials: those live in Secret Manager, named here) and the
 * columns of its table or view, so the columns can be mapped before the first run. The live
 * connection test comes with the connector's credentials setup.
 */

export type Connector = "bigquery" | "snowflake" | "sheets" | "csv";
export type WarehouseConfig = Exclude<SourceConfig, { kind: "csv" }>;

interface FieldDef {
  key: string;
  label: MessageKey;
  placeholder: string;
  optional?: boolean;
  hint?: MessageKey;
}
const FIELDS: Record<Exclude<Connector, "csv">, FieldDef[]> = {
  bigquery: [
    { key: "projectId", label: "sources.f.projectId", placeholder: "acme-analytics" },
    { key: "dataset", label: "sources.f.dataset", placeholder: "marketing" },
    { key: "table", label: "sources.f.table", placeholder: "daily_spend" },
    { key: "updatedAtColumn", label: "sources.f.updatedAtColumn", placeholder: "updated_at", optional: true, hint: "sources.f.updatedAtColumnHelp" },
    { key: "secretRef", label: "sources.f.secretRef", placeholder: "projects/acme/secrets/bq-reader", optional: true, hint: "sources.f.secretRefBqHelp" },
  ],
  snowflake: [
    { key: "account", label: "sources.f.account", placeholder: "acme-xy12345" },
    { key: "username", label: "sources.f.username", placeholder: "BUDGET_OS_READER" },
    { key: "warehouse", label: "sources.f.warehouse", placeholder: "REPORTING_WH" },
    { key: "database", label: "sources.f.database", placeholder: "MARKETING" },
    { key: "schema", label: "sources.f.schema", placeholder: "PUBLIC" },
    { key: "view", label: "sources.f.view", placeholder: "DAILY_SPEND" },
    { key: "secretRef", label: "sources.f.secretRef", placeholder: "projects/acme/secrets/snowflake-key", hint: "sources.f.secretRefHelp" },
  ],
  sheets: [
    { key: "spreadsheetId", label: "sources.f.spreadsheetId", placeholder: "1AbC…xyz", hint: "sources.f.spreadsheetIdHelp" },
    { key: "range", label: "sources.f.range", placeholder: "Spend!A1:H" },
    { key: "secretRef", label: "sources.f.secretRef", placeholder: "projects/acme/secrets/sheets-reader", optional: true, hint: "sources.f.secretRefSheetsHelp" },
  ],
};

const CARDS: Array<{ id: Connector; icon: typeof Database; title: MessageKey; body: MessageKey }> = [
  { id: "bigquery", icon: Database, title: "sources.connector.bigquery", body: "sources.card.bigquery" },
  { id: "snowflake", icon: Snowflake, title: "sources.connector.snowflake", body: "sources.card.snowflake" },
  { id: "sheets", icon: FileSpreadsheet, title: "sources.connector.sheets", body: "sources.card.sheets" },
  { id: "csv", icon: FileUp, title: "sources.connector.csv", body: "sources.card.csv" },
];

/** The columns typed or pasted: one per line or comma-separated, trimmed, without duplicates. */
export const parseColumns = (text: string): string[] => [...new Set(text.split(/[\n,;\t]+/).map((c) => c.trim()).filter(Boolean))];

export function ConnectStep({ onFile, onWarehouse }: { onFile: (f: File) => void; onWarehouse: (config: WarehouseConfig, columns: string[], label: string) => void }): ReactElement {
  const [connector, setConnector] = useState<Connector | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [columns, setColumns] = useState("");
  const field = "h-9 rounded-lg border border-input bg-card px-2.5 text-sm";

  const config = (): { ok: true; config: WarehouseConfig } | { ok: false; message: string } => {
    if (connector === null || connector === "csv") return { ok: false, message: t("sources.pickConnector") };
    const raw: Record<string, string> = { kind: connector };
    for (const f of FIELDS[connector]) if ((values[f.key] ?? "").trim()) raw[f.key] = (values[f.key] ?? "").trim();
    const parsed = SourceConfig.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const f = FIELDS[connector].find((x) => x.key === String(issue?.path[0] ?? ""));
      return { ok: false, message: f ? t("sources.fieldProblem", { field: t(f.label), problem: issue?.message ?? "" }) : (issue?.message ?? "") };
    }
    return { ok: true, config: parsed.data as WarehouseConfig };
  };
  const checked = config();
  const cols = parseColumns(columns);
  const why = !checked.ok ? checked.message : cols.length === 0 ? t("sources.needColumns") : null;
  const label = connector === "bigquery" ? (values["table"] ?? "") : connector === "snowflake" ? (values["view"] ?? "") : connector === "sheets" ? (values["range"] ?? "").split("!")[0] ?? "" : "";

  return (
    <div className="flex flex-col gap-4" data-testid="connect-step">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" role="radiogroup" aria-label={t("sources.connector")}>
        {CARDS.map((c) => {
          const Icon = c.icon;
          return (
            <button key={c.id} type="button" role="radio" aria-checked={connector === c.id} onClick={() => setConnector(c.id)} className={cn("flex flex-col items-start gap-1 rounded-xl border p-3 text-left", connector === c.id ? "border-primary bg-secondary" : "border-border hover:bg-accent/40")} data-testid={`connector-${c.id}`}>
              <span className="flex items-center gap-2 font-medium">
                <Icon className="size-4 text-primary" aria-hidden />
                {t(c.title)}
              </span>
              <span className="text-xs text-muted-foreground">{t(c.body)}</span>
            </button>
          );
        })}
      </div>

      {connector === "csv" ? (
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border px-6 py-10 text-center hover:bg-accent/40">
          <FileUp className="size-8 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium">{t("sources.chooseCsv")}</span>
          <span className="text-xs text-muted-foreground">{t("sources.chooseCsvHelp")}</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} data-testid="wizard-file" />
        </label>
      ) : null}

      {connector && connector !== "csv" ? (
        <div className="flex flex-col gap-4" data-testid="warehouse-form" data-connector={connector}>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS[connector].map((f) => (
              <Labeled key={f.key} label={`${t(f.label)}${f.optional ? ` ${t("sources.optional")}` : ""}`} hint={f.hint ? t(f.hint) : undefined}>
                <input className={cn(field, f.key === "secretRef" && "font-mono text-xs")} value={values[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} data-testid={`source-field-${f.key}`} />
              </Labeled>
            ))}
          </div>
          <Labeled label={t("sources.columnsLabel")} hint={t("sources.columnsHelp")}>
            <textarea className="min-h-24 rounded-lg border border-input bg-card px-2.5 py-2 font-mono text-xs" value={columns} onChange={(e) => setColumns(e.target.value)} placeholder={"date\ncountry\nplatform\ncampaign\nspend\ncurrency"} data-testid="source-columns" />
          </Labeled>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled reason={t("sources.testLater")} data-testid="source-test">
              {t("sources.testConnection")}
            </Button>
            <span className="text-xs text-muted-foreground">{t("sources.testLaterNote")}</span>
            {why ? (
              <Button className="ml-auto" disabled reason={why} data-testid="connect-next">{t("sources.next")}</Button>
            ) : (
              <Button className="ml-auto" onClick={() => checked.ok && onWarehouse(checked.config, cols, label)} data-testid="connect-next">
                {t("sources.next")}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Labeled({ label, hint, children }: { label: string; hint?: string | undefined; children: ReactNode }): ReactElement {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      {children}
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
