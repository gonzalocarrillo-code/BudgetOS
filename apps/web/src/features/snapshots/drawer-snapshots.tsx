import { formatMoney } from "@budget/grid";
import { Button, Chip } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import { Camera } from "lucide-react";
import { useState, type ReactElement } from "react";
import type { EnvelopeDetail } from "../../lib/queries.js";
import { SaveSnapshotDialog } from "./save-snapshot-dialog.js";
import { savedOn, snapshotsQuery } from "./queries.js";

/** Details, while Budgets compares with a snapshot (H-007): what the snapshot held for this budget, and now. */
export function SnapshotCompareLine({ ws, env, compareTo }: { ws: string; env: EnvelopeDetail; compareTo: string }): ReactElement | null {
  const { data: held = [] } = useQuery(snapshotsQuery(ws, { envelopeId: env.id }));
  const { data: all = [] } = useQuery(snapshotsQuery(ws));
  const snapshot = all.find((s) => s.id === compareTo);
  if (!snapshot) return null;
  const row = held.find((s) => s.id === compareTo)?.row ?? null;
  const now = env.current ? formatMoney(env.current.amount, env.currency) : "—";
  return (
    <p className="rounded-lg bg-surface px-3 py-2 text-sm" data-testid="drawer-compare">
      {row ? t("snapshots.inSnapshot", { name: snapshot.name, then: formatMoney(row.amount, row.currency), now }) : t("snapshots.notInSnapshot", { name: snapshot.name })}
    </p>
  );
}

/** History (H-007): the snapshots that hold this budget, with what each kept; and saving one of its subtree. */
export function DrawerSnapshots({ ws, env }: { ws: string; env: EnvelopeDetail }): ReactElement {
  const { data: held = [] } = useQuery(snapshotsQuery(ws, { envelopeId: env.id }));
  const [saving, setSaving] = useState(false);
  const holding = held.filter((s) => s.row);
  return (
    <section className="flex flex-col gap-2" aria-labelledby="drawer-snapshots-title" data-testid="drawer-snapshots">
      <div className="flex items-center gap-2">
        <h3 id="drawer-snapshots-title" className="flex-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {t("snapshots.drawerTitle")}
        </h3>
        <Button size="sm" variant="outline" onClick={() => setSaving(true)} data-testid="drawer-save-snapshot">
          <Camera className="size-4" aria-hidden />
          {t("snapshots.saveOfBudget")}
        </Button>
      </div>
      {holding.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("snapshots.drawerEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {holding.map((s) => (
            <li key={s.id} className="flex items-center gap-2" data-testid="drawer-snapshot">
              <Chip tone={s.kind === "plan" ? "info" : s.kind === "close" ? "success" : "neutral"}>{t(`snapshots.kindShort.${s.kind}`)}</Chip>
              <span className="min-w-0 flex-1 truncate">
                {s.name} <span className="text-xs text-muted-foreground">{savedOn(s.asOf)}</span>
              </span>
              <span className="tabular">{s.row ? formatMoney(s.row.amount, s.row.currency) : "—"}</span>
            </li>
          ))}
        </ul>
      )}
      {saving ? <SaveSnapshotDialog ws={ws} budget={{ id: env.id, name: env.name }} onClose={() => setSaving(false)} onSaved={() => setSaving(false)} /> : null}
    </section>
  );
}
