import { Button, Menu, MenuContent, MenuItem, MenuTrigger } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { FolderInput, GitBranchPlus, Merge, Split, ChevronDown, Network, Flag, RotateCcw } from "lucide-react";
import type { ReactElement } from "react";
import type { EnvelopeDetail } from "../../lib/queries.js";
import type { StructureOp } from "./structure-dialog.js";
const STRUCTURE_OPS: Array<{ op: StructureOp; label: "structure.addChild" | "structure.move" | "structure.split" | "structure.merge" | "structure.end" | "structure.reintroduce"; icon: typeof GitBranchPlus }> = [
  { op: "add_child", label: "structure.addChild", icon: GitBranchPlus },
  { op: "move", label: "structure.move", icon: FolderInput },
  { op: "split", label: "structure.split", icon: Split },
  { op: "merge", label: "structure.merge", icon: Merge },
  { op: "end", label: "structure.end", icon: Flag },
  { op: "reintroduce", label: "structure.reintroduce", icon: RotateCcw },
];

/** Structure actions on the selected budget (T-031b, H-011, H-012): add child, move, split, merge, end, reintroduce. Each says why when it cannot run. */
export function StructureActions({ env, onPick, compact = false }: { env: EnvelopeDetail | null; onPick: (op: StructureOp) => void; compact?: boolean }): ReactElement {
  const reason = (op: StructureOp): string | null => {
    if (env === null) return t("structure.selectFirst");
    if (env.status === "LOCKED") return t("structure.locked");
    if (env.status === "ARCHIVED") return t("structure.archived");
    if (op === "reintroduce") return env.ended ? null : t("structure.notEnded");
    if (env.ended) return t("structure.ended");
    if ((op === "split" || op === "merge") && env.current === null) return t("structure.needsApproved");
    if (op === "end" && env.current === null) return t("structure.needsApprovedEnd");
    if ((op === "split" || op === "merge" || op === "end") && env.status === "PENDING") return t("structure.pending");
    if (op === "end" && env.structure.children.some((c) => !c.ended)) return t("structure.hasChildren");
    return null;
  };
  // The drawer shows what can apply to this budget: Reintroduce once it has ended, the rest before.
  const drawerOps = STRUCTURE_OPS.filter(({ op }) => (env?.ended ? op === "reintroduce" : op !== "reintroduce"));
  // DS-005: the toolbar offers one "Structure" menu; the drawer keeps the buttons beside the budget.
  if (!compact) {
    return (
      <Menu>
        <MenuTrigger asChild>
          <Button variant="outline" size="sm" data-testid="structure-actions" data-tour="structure-actions">
            <Network className="size-4" aria-hidden />
            {t("structure.title")}
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
          </Button>
        </MenuTrigger>
        <MenuContent align="start" className="w-72">
          {env === null ? <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{t("structure.selectFirst")}</p> : null}
          {STRUCTURE_OPS.map(({ op, label, icon: Icon }) => {
            const why = reason(op);
            // A disabled item says why in its own text (the rule's `reason` is for buttons with a tooltip).
            return (
              <MenuItem key={op} {...(why ? { disabled: true } : {})} onSelect={() => onPick(op)} className="items-start" data-testid={`structure-${op}`}>
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0">
                  <span className="block">{t(label)}</span>
                  {why && env !== null ? <span className="block text-xs text-muted-foreground">{why}</span> : null}
                </span>
              </MenuItem>
            );
          })}
        </MenuContent>
      </Menu>
    );
  }
  return (
    <div className="inline-flex flex-wrap items-center gap-1" role="group" aria-label={t("structure.title")} data-testid="drawer-structure-actions" data-tour="structure-actions">
      {drawerOps.map(({ op, label, icon: Icon }) => {
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
