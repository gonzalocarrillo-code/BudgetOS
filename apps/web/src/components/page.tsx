import { t, type MessageKey } from "@budget/ui/i18n";
import type { ReactElement, ReactNode } from "react";

/** A page: its title, then content in white rounded cards on the surface (ADR-021). */
export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }): ReactElement {
  return (
    <section className="flex flex-col gap-5 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-[22px] font-semibold leading-7 tracking-[-0.02em]" data-testid="page-title">
          {title}
        </h1>
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }): ReactElement {
  return (
    <div className="rounded-xl border border-border bg-card shadow-xs">
      {title ? <div className="border-b border-border px-5 py-4 text-[15px] font-semibold">{title}</div> : null}
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

/** A §18.1 route whose screen is built by a later task: the route, auth and shell are real. */
export function Pending({ title, task }: { title: MessageKey; task: string }): ReactElement {
  return (
    <Page title={t(title)}>
      <Card>
        <p className="text-sm text-muted-foreground" data-testid="page-pending">
          {t("page.pending", { task })}
        </p>
      </Card>
    </Page>
  );
}
