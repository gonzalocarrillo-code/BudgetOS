import { Button, Logo } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronRight, LockKeyhole, LogOut, TriangleAlert } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { clearToken } from "../lib/auth.js";
import { meQuery } from "../lib/queries.js";

/**
 * A page outside any workspace the caller can use (UX-004): the brand, the reason, a way to one of
 * their own workspaces and to sign out. It is a boundary, not an error, so it says so.
 */
function Frame({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex h-16 items-center justify-between border-b border-border bg-card px-4">
        <Link to="/" aria-label={t("shell.homeLink")}>
          <Logo size={26} />
        </Link>
        <Button variant="ghost" size="sm" onClick={() => clearToken()}>
          <LogOut className="size-4" aria-hidden />
          {t("shell.signOut")}
        </Button>
      </header>
      <main className="flex flex-1 items-start justify-center p-6 pt-[12vh]">{children}</main>
    </div>
  );
}

export function NoAccess({ reason = "workspace" }: { reason?: "workspace" | "none" }): ReactElement {
  const { data: me } = useQuery(meQuery);
  const workspaces = me?.workspaces ?? [];
  return (
    <Frame>
      <div className="flex w-full max-w-lg flex-col gap-5 rounded-2xl border border-border bg-card p-8 shadow-sm" data-testid="no-access">
        <span className="grid size-11 place-items-center rounded-xl bg-info-soft text-info-text">
          <LockKeyhole className="size-5" aria-hidden />
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[22px] font-semibold leading-7 tracking-[-0.02em]" data-testid="page-title">{t(reason === "none" ? "denied.none.title" : "denied.title")}</h1>
          <p className="text-sm text-muted-foreground">{t(reason === "none" ? "denied.none.body" : "denied.body")}</p>
        </div>
        {workspaces.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{t("denied.yours")}</p>
            <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
              {workspaces.map((w) => (
                <li key={w.workspaceId}>
                  <Link to="/w/$ws/home" params={{ ws: w.workspaceId }} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent" data-testid="denied-workspace">
                    <span className="grid size-7 place-items-center rounded-lg bg-secondary text-xs font-semibold text-secondary-foreground">{w.name.slice(0, 1).toUpperCase()}</span>
                    <span className="flex-1 font-medium">{w.name}</span>
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {me ? <p className="text-xs text-muted-foreground">{t("denied.signedInAs", { email: me.user.email })}</p> : null}
      </div>
    </Frame>
  );
}

export function RouteFailure({ message }: { message: string }): ReactElement {
  const router = useRouter();
  return (
    <Frame>
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-border bg-card p-8 shadow-sm">
        <span className="grid size-11 place-items-center rounded-xl bg-danger-soft text-danger-text">
          <TriangleAlert className="size-5" aria-hidden />
        </span>
        <h1 className="text-[22px] font-semibold leading-7 tracking-[-0.02em]" data-testid="page-title">{t("error.title")}</h1>
        <p className="text-sm text-muted-foreground" data-testid="route-error">{message}</p>
        <div>
          <Button onClick={() => void router.invalidate()}>{t("error.retry")}</Button>
        </div>
      </div>
    </Frame>
  );
}
