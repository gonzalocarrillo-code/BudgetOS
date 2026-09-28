import { Button, Logo } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useState, type FormEvent, type ReactElement } from "react";
import { setToken } from "../lib/auth.js";

/**
 * No token in this tab: Identity Platform sign-in (the GCP phase), or paste a token locally. The
 * page carries the BudgetOS identity (UX-005); the token field is the developer path until Google
 * sign-in is connected, so it sits behind a disclosure.
 */
export function SignIn({ expired = false }: { expired?: boolean }): ReactElement {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) setToken(value);
  };
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-background p-6" data-testid="sign-in">
      <Logo size={36} />
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-border bg-card p-8 shadow-sm">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[22px] font-semibold leading-7 tracking-[-0.02em]">{t("auth.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("auth.tagline")}</p>
        </div>
        {expired ? <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-text">{t("auth.expired")}</p> : null}
        <Button type="button" variant="outline" disabled reason={t("auth.googleSoon")} className="w-full">
          {t("auth.google")}
        </Button>
        <details className="group rounded-lg border border-border px-3 py-2 text-sm" open>
          <summary className="cursor-pointer select-none font-medium text-muted-foreground group-open:text-foreground">{t("auth.developer")}</summary>
          <p className="mt-2 text-muted-foreground">{t("auth.body")}</p>
          <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t("auth.token")}
              <textarea className="min-h-24 rounded-lg border border-input bg-card p-2 font-mono text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
            {value.trim() ? <Button type="submit">{t("auth.submit")}</Button> : <Button type="submit" disabled reason={t("auth.token")}>{t("auth.submit")}</Button>}
          </form>
        </details>
      </div>
      <p className="text-xs text-muted-foreground">{t("auth.footer")}</p>
    </main>
  );
}
