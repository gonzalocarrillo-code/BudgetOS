import { Button, Logo, Textarea } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useState, type FormEvent, type ReactElement } from "react";
import { SESSION, setToken } from "../lib/auth.js";

/**
 * Log in to Budget OS (UX-005, ADR-067). Deployed, "Continue with Google" starts Budget OS's own
 * Google sign-in for any Google account; who gets in is then the app's users and roles. Locally
 * (no session mode) the developer path pastes a token.
 */
export function SignIn({ expired = false }: { expired?: boolean }): ReactElement {
  const [value, setValue] = useState("");
  // Back where the person was after signing in; the callback's error, if Google or the check refused.
  const next = typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search.replace(/[?&]login_error=[^&]*/, "")}`;
  const loginError = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("login_error");
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
        {loginError ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-text" data-testid="sign-in-error">
            {loginError}
          </p>
        ) : null}
        {SESSION ? (
          <a href={`/auth/login?next=${encodeURIComponent(next)}`} className="inline-flex h-11 w-full items-center justify-center gap-3 rounded-lg border border-border bg-card text-sm font-medium shadow-xs hover:bg-accent" data-testid="sign-in-google">
            <GoogleMark />
            {t("auth.google")}
          </a>
        ) : (
          <Button type="button" variant="outline" disabled reason={t("auth.googleSoon")} className="w-full">
            {t("auth.google")}
          </Button>
        )}
        {SESSION ? null : (
        <details className="group rounded-lg border border-border px-3 py-2 text-sm" open>
          <summary className="cursor-pointer select-none font-medium text-muted-foreground group-open:text-foreground">{t("auth.developer")}</summary>
          <p className="mt-2 text-muted-foreground">{t("auth.body")}</p>
          <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t("auth.token")}
              <Textarea className="min-h-24 font-mono text-xs" value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
            {value.trim() ? <Button type="submit">{t("auth.submit")}</Button> : <Button type="submit" disabled reason={t("auth.token")}>{t("auth.submit")}</Button>}
          </form>
        </details>
        )}
      </div>
      <p className="text-xs text-muted-foreground" data-testid="sign-in-copyright">{t("auth.copyright", { year: new Date().getFullYear() })}</p>
    </main>
  );
}

/** Google's "G", as its sign-in guidelines ask for next to "Continue with Google". */
function GoogleMark(): ReactElement {
  return (
    <svg viewBox="0 0 48 48" className="size-5" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
