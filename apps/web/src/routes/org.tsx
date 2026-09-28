import { t } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, type ErrorComponentProps } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { NoAccess, RouteFailure } from "../components/denied.js";
import { OrgShell } from "../components/org-shell.js";
import { SignIn } from "../components/sign-in.js";
import { ApiError } from "../lib/api.js";
import { getToken } from "../lib/auth.js";
import { meQuery, type Me } from "../lib/queries.js";

/** `/org` (ADR-052): the org console, superadmins only. */
export const Route = createFileRoute("/org")({
  beforeLoad: async ({ context }) => {
    if (!getToken()) throw new ApiError(401, "UNAUTHENTICATED", t("auth.title"));
    const me: Me = await context.queryClient.ensureQueryData(meQuery);
    if (!me.isOrgAdmin) throw new ApiError(403, "FORBIDDEN", t("org.onlySuperadmins"));
    return { me };
  },
  component: OrgLayout,
  errorComponent: OrgError,
});

function OrgLayout(): ReactElement {
  const { me: loaded } = Route.useRouteContext();
  const { data: me = loaded } = useQuery(meQuery);
  return (
    <OrgShell me={me}>
      <Outlet />
    </OrgShell>
  );
}

function OrgError({ error }: ErrorComponentProps): ReactElement {
  if (error instanceof ApiError && error.status === 401) return <SignIn expired />;
  if (error instanceof ApiError && error.status === 403) return <NoAccess />;
  return <RouteFailure message={error instanceof Error ? error.message : String(error)} />;
}
