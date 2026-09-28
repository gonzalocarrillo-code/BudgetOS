import type { ReactElement, ReactNode } from "react";

/** A page: its title, then content in white rounded cards on the surface (ADR-021). */
export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }): ReactElement {
  return (
    <section className="flex min-w-0 flex-col gap-5 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[22px] font-semibold leading-7 tracking-[-0.02em]" data-testid="page-title">
          {title}
        </h1>
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Card({ title, children, tour }: { title?: string; children: ReactNode; tour?: string }): ReactElement {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card shadow-xs" {...(tour ? { "data-tour": tour } : {})}>
      {title ? <div className="border-b border-border px-5 py-4 text-[15px] font-semibold">{title}</div> : null}
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}
