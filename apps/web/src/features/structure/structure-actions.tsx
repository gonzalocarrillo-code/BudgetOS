import { Button } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { FolderInput, GitBranchPlus, Merge, Split } from "lucide-react";
import type { ReactElement } from "react";
import type { EnvelopeDetail } from "../../lib/queries.js";
import type { StructureOp } from "./structure-dialog.js";
const STRUCTURE_OPS: Array<{ op: StructureOp; label: "structure.addChild" | "structure.move" | "structure.split" | "structure.merge"; icon: typeof GitBranchPlus }> = [
  { op: "add_child", label: "structure.addChild", icon: GitBranchPlus },
  { op: "move", label: "structure.move", icon: FolderInput },
  { op: "split", label: "structure.split", icon: Split },
  { op: "merge", label: "structure.merge", icon: Merge },
];

/** Structure actions on the selected budget (T-031b): add child, move, split, merge. Each says why when it cannot run. */
export function StructureActions({ env, onPick, compact = false }: { env: EnvelopeDetail | null; onPick: (op: StructureOp) => void; compact?: boolean }): ReactElement {
  const reason = (op: StructureOp): string | null => {
    if (env === null) return t("structure.selectFirst");
    if (env.status === "LOCKED") return t("structure.locked");
    if (env.status === "ARCHIVED") return t("structure.archived");
    if ((op === "split" || op === "merge") && env.current === null) return t("structure.needsApproved");
    if ((op === "split" || op === "merge") && env.status === "PENDING") return t("structure.pending");
    return null;
  };
  return (
    <div className="inline-flex flex-wrap items-center gap-1" role="group" aria-label={t("structure.title")} data-testid={compact ? "drawer-structure-actions" : "structure-actions"} data-tour="structure-actions">
      {STRUCTURE_OPS.map(({ op, label, icon: Icon }) => {
        const why = reason(op);
        return why ? (
          <Button key={op} variant="outline" size="sm" disabled reason={why} data-testid={`structure-${op}`}>
            <Icon className="size-4" aria-hidden />
            {t(label)}
          </Button>
        ) : (
          <Button key={op} variant="outline" size="sm" onClick={() => onPick(op)} data-testid={`structure-${op}`}>
            <Icon className="size-4" aria-hidden />
            {t(label)}
          </Button>
        );
      })}
    </div>
  );
}
