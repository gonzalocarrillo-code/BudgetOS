import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn.js";

/** A grey placeholder shaped like the content that is loading (UX-007). */
export function Skeleton({ className }: { className?: string }): ReactElement {
  return <span aria-hidden className={cn("block animate-pulse rounded-md bg-muted", className)} data-testid="skeleton" />;
}

/** Rows of skeleton lines for a list or table that is loading. */
export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }): ReactElement {
  return (
    <div className={cn("flex flex-col gap-3 py-1", className)} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * An empty list is an invitation, not a blank (UX-007): an icon, what the space is for in one
 * sentence, and the one action that fills it.
 */
export function EmptyState({ icon: Icon, title, body, action, className, testId }: { icon: LucideIcon; title: string; body?: string; action?: ReactNode; className?: string; testId?: string }): ReactElement {
  return (
    <div className={cn("flex flex-col items-center gap-3 px-6 py-10 text-center", className)} data-testid={testId ?? "empty-state"}>
      <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="flex max-w-md flex-col gap-1">
        <p className="font-medium">{title}</p>
        {body ? <p className="text-sm text-muted-foreground">{body}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
