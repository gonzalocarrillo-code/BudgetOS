import type { BaselineKind, BaselineScope, FilterGroupT } from "@budget/domain";
import { Button, FormField, Input, Modal, Select, Textarea } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { saveSnapshot, useCanSnapshotWorkspace, type Snapshot } from "./queries.js";

type ScopeChoice = "workspace" | "filter" | "budget";

/**
 * Save a snapshot by hand (H-002, ADR-053): a name, a kind, and what it keeps: the whole workspace,
 * the budgets the current filter shows, or one budget and everything under it. Nothing is captured
 * automatically; this is the only way a snapshot is made.
 */
export function SaveSnapshotDialog({
  ws,
  budget,
  filter,
  periodKey,
  onSaved,
  onClose,
}: {
  ws: string;
  /** The selected budget, when there is one (the drawer passes it). */
  budget?: { id: string; name: string } | null;
  /** The Budgets filter, when it narrows anything. */
  filter?: FilterGroupT | null;
  periodKey?: string | null;
  onSaved: (s: Snapshot) => void;
  onClose: () => void;
}): ReactElement {
  const client = useQueryClient();
  const canWorkspace = useCanSnapshotWorkspace(ws);
  const choices: ScopeChoice[] = [...(canWorkspace ? (["workspace"] as const) : []), ...(canWorkspace && filter && filter.children.length ? (["filter"] as const) : []), ...(budget ? (["budget"] as const) : [])];
  const [scope, setScope] = useState<ScopeChoice>(budget && !canWorkspace ? "budget" : (choices[0] ?? "budget"));
  const [name, setName] = useState("");
  const [kind, setKind] = useState<BaselineKind>("plan");
  const [period, setPeriod] = useState(periodKey ?? "");
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: async () => {
      const body: BaselineScope = scope === "budget" && budget ? { envelopeId: budget.id } : scope === "filter" && filter ? { filter } : {};
      return saveSnapshot(ws, { name: name.trim(), kind, scope: body, ...(period.trim() ? { periodKey: period.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
    },
    onSuccess: async (s) => {
      await client.invalidateQueries({ queryKey: ["snapshots", ws] });
      onSaved(s);
    },
  });
  const why = choices.length === 0 ? t("snapshots.onlyFinance") : !name.trim() ? t("snapshots.needName") : save.isPending ? t("shell.loading") : null;
  const label = (c: ScopeChoice) => (c === "workspace" ? t("snapshots.scope.workspace") : c === "filter" ? t("snapshots.scope.filter") : t("snapshots.scope.budget", { name: budget?.name ?? "" }));
  return (
    <Modal onClose={onClose} labelledBy="snapshot-title" testId="snapshot-dialog">
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-border bg-card p-6 shadow-lg">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 id="snapshot-title" className="text-lg font-semibold tracking-[-0.015em]">
              {t("snapshots.title")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("snapshots.help")}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("drawer.close")}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        <FormField label={t("snapshots.name")}>{(ids) => <Input {...ids} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("snapshots.namePlaceholder")} autoFocus data-testid="snapshot-name" />}</FormField>
        <FormField label={t("snapshots.kind")}>
          {(ids) => (
            <Select {...ids} value={kind} onChange={(e) => setKind(e.target.value as BaselineKind)} data-testid="snapshot-kind">
              {(["plan", "close", "other"] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`snapshots.kind.${k}`)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <fieldset className="flex flex-col gap-1.5 text-sm">
          <legend className="mb-1 font-medium">{t("snapshots.scope")}</legend>
          {choices.map((c) => (
            <label key={c} className="flex items-center gap-2">
              <input type="radio" name="snapshot-scope" checked={scope === c} onChange={() => setScope(c)} data-testid={`snapshot-scope-${c}`} />
              {label(c)}
            </label>
          ))}
          {!canWorkspace ? <p className="text-xs text-muted-foreground">{t("snapshots.onlyFinance")}</p> : null}
        </fieldset>
        <FormField label={t("snapshots.period")} help={t("snapshots.periodHint")}>
          {(ids) => <Input {...ids} value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-Q4" data-testid="snapshot-period" />}
        </FormField>
        <FormField label={t("snapshots.note")}>{(ids) => <Textarea {...ids} rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-testid="snapshot-note" />}</FormField>
        {save.error ? <p role="alert" className="text-sm text-destructive">{save.error.message}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("threads.cancel")}
          </Button>
          {why ? (
            <Button disabled reason={why} data-testid="snapshot-save">
              {t("snapshots.save")}
            </Button>
          ) : (
            <Button onClick={() => save.mutate()} data-testid="snapshot-save">
              {t("snapshots.save")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
