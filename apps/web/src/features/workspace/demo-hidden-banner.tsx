import { t } from "@budget/ui/i18n";
import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import type { ReactElement } from "react";

/**
 * HF-1 (audit T-5 follow-up): T-5 excludes demo money from every total by default once the
 * workspace has a real budget, but that exclusion must never be silent (the Sandbox bug: a demo
 * root hiding the one real budget under it, with nothing saying why). Shown on Home, Overview and
 * Budgets whenever GET /demo-data says `hidden`; `showing` is this visit's own `demo=true` toggle.
 */
export function DemoHiddenBanner({ ws, count, showing, onToggle }: { ws: string; count: number; showing: boolean; onToggle: (show: boolean) => void }): ReactElement {
  return (
    <div role="status" className="flex items-center gap-3 rounded-lg border border-primary/30 bg-secondary px-4 py-2.5 text-sm" data-testid="demo-hidden">
      <Sparkles className="size-4 text-primary" aria-hidden />
      <span className="flex-1">{showing ? t("demo.shownBanner") : t("demo.hiddenBanner", { count })}</span>
      {showing ? (
        <button type="button" className="font-medium text-primary hover:underline" onClick={() => onToggle(false)} data-testid="demo-hide">
          {t("demo.hide")}
        </button>
      ) : (
        <button type="button" className="font-medium text-primary hover:underline" onClick={() => onToggle(true)} data-testid="demo-show">
          {t("demo.show")}
        </button>
      )}
      <Link to="/w/$ws/admin/workspace" params={{ ws }} hash="demo-data" className="font-medium text-primary hover:underline">
        {t("home.demoManage")}
      </Link>
    </div>
  );
}
