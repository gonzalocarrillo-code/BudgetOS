import { t, type MessageKey } from "@budget/ui/i18n";
import type { ReactElement, ReactNode } from "react";

export function Page({ title, children }: { title: string; children?: ReactNode }): ReactElement {
  return (
    <section className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight" data-testid="page-title">
        {title}
      </h1>
      {children}
    </section>
  );
}

/** A §18.1 route whose screen is built by a later task: the route, auth and shell are real. */
export function Pending({ title, task }: { title: MessageKey; task: string }): ReactElement {
  return (
    <Page title={t(title)}>
      <p className="text-sm text-muted-foreground" data-testid="page-pending">
        {t("page.pending", { task })}
      </p>
    </Page>
  );
}
