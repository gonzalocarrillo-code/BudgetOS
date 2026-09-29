import { cn } from "@budget/ui";
import type { ReactElement, ReactNode } from "react";

/**
 * A page: its title, then content in white rounded cards on the surface (ADR-021). Only the shell's
 * <main> scrolls, and the title row with the page's actions stays at its top (UX-002).
 */
/**
 * HO-016: `stickyOnPhone={false}` lets the title row scroll away below 768 px (a header with several
 * controls would cover a third of a phone); `readable` sets the smallest text to 12 px (the root is
 * 14 px, so `text-xs` would be 10.5 px) for the screens people read at a glance.
 */
export function Page({ title, actions, children, stickyOnPhone = true, readable = false }: { title: string; actions?: ReactNode; children?: ReactNode; stickyOnPhone?: boolean; readable?: boolean }): ReactElement {
  return (
    <section className={cn("flex min-w-0 flex-col gap-5 px-6 pb-6", readable && "[--text-xs:12px]")}>
      <div className={cn(stickyOnPhone ? "sticky top-0" : "md:sticky md:top-0", "z-20 -mx-6 flex flex-wrap items-center gap-3 border-b border-border/0 bg-surface/95 px-6 pb-3 pt-6 backdrop-blur supports-[backdrop-filter]:bg-surface/80")} data-testid="page-header">
        <h1 className="text-[22px] font-semibold leading-7 tracking-[-0.02em]" data-testid="page-title">
          {title}
        </h1>
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A card: a title with what acts on it (`actions`, right side of the header), then its content. */
export function Card({ title, children, tour, actions, testId, className }: { title?: ReactNode; children: ReactNode; tour?: string; actions?: ReactNode; testId?: string; className?: string }): ReactElement {
  return (
    <div className={cn("min-w-0 rounded-xl border border-border bg-card shadow-xs", className)} {...(tour ? { "data-tour": tour } : {})} {...(testId ? { "data-testid": testId } : {})}>
      {title ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-4">
          <div className="text-[15px] font-semibold">{title}</div>
          {actions ? <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{actions}</div> : null}
        </div>
      ) : null}
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}
