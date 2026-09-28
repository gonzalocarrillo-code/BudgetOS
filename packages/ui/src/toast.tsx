import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useSyncExternalStore, type ReactElement } from "react";
import { cn } from "./cn.js";
import { t } from "./i18n.js";

/**
 * Toasts (UX-007): what just happened, in the corner, for a few seconds. One queue for the app;
 * `toast.success` / `toast.error` from anywhere, `<Toaster/>` once in the shell. The region is a
 * polite live region, so screen readers hear it too. Written here rather than added as a
 * dependency: it is a store and a list (AGENTS §4).
 */
export type ToastKind = "success" | "error" | "info";
export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; onClick: () => void } | undefined;
}

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function dismissToast(id: number): void {
  items = items.filter((x) => x.id !== id);
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  emit();
}

function push(kind: ToastKind, message: string, opts: { action?: ToastItem["action"]; durationMs?: number } = {}): number {
  const id = ++seq;
  items = [...items.slice(-3), { id, kind, message, action: opts.action }];
  timers.set(id, setTimeout(() => dismissToast(id), opts.durationMs ?? (kind === "error" ? 8000 : 4500)));
  emit();
  return id;
}

export const toast = {
  success: (message: string, opts?: { action?: ToastItem["action"]; durationMs?: number }) => push("success", message, opts),
  error: (message: string, opts?: { action?: ToastItem["action"]; durationMs?: number }) => push("error", message, opts),
  info: (message: string, opts?: { action?: ToastItem["action"]; durationMs?: number }) => push("info", message, opts),
};

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
const snapshot = () => items;

const ICON = { success: CheckCircle2, error: XCircle, info: Info } as const;
const TONE = { success: "text-success-text", error: "text-danger-text", info: "text-info-text" } as const;

export function Toaster(): ReactElement {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" data-testid="toasts">
      {list.map((x) => {
        const Icon = ICON[x.kind];
        return (
          <div key={x.id} className="pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm shadow-lg" data-testid="toast" data-kind={x.kind}>
            <Icon className={cn("mt-0.5 size-4 shrink-0", TONE[x.kind])} aria-hidden />
            <p className="min-w-0 flex-1 break-words">{x.message}</p>
            {x.action ? (
              <button type="button" className="shrink-0 font-medium text-primary hover:underline" onClick={() => (x.action?.onClick(), dismissToast(x.id))}>
                {x.action.label}
              </button>
            ) : null}
            <button type="button" className="shrink-0 rounded text-muted-foreground hover:text-foreground" onClick={() => dismissToast(x.id)} aria-label={t("toast.dismiss")}>
              <X className="size-4" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
