import { Button } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useState, type FormEvent, type ReactElement } from "react";
import { setToken } from "../lib/auth.js";

/** No token in this tab: Identity Platform sign-in (the GCP phase), or paste a token locally. */
export function SignIn({ expired = false }: { expired?: boolean }): ReactElement {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) setToken(value);
  };
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6" data-testid="sign-in">
      <h1 className="text-2xl font-semibold tracking-tight">{t("auth.title")}</h1>
      {expired ? <p className="text-sm text-destructive">{t("auth.expired")}</p> : null}
      <p className="text-sm text-muted-foreground">{t("auth.body")}</p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("auth.token")}
          <textarea className="min-h-24 rounded-md border border-input bg-background p-2 font-mono text-xs" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {value.trim() ? <Button type="submit">{t("auth.submit")}</Button> : <Button type="submit" disabled reason={t("auth.token")}>{t("auth.submit")}</Button>}
      </form>
    </main>
  );
}
