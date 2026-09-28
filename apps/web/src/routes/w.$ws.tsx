import { t } from "@budget/ui/i18n";
import { Outlet, createFileRoute, type ErrorComponentProps } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { NoAccess, RouteFailure } from "../components/denied.js";
import { Shell } from "../components/shell.js";
import { SignIn } from "../components/sign-in.js";
import { ApiError } from "../lib/api.js";
import { getToken } from "../lib/auth.js";
import { meQuery, registryQuery, type Me } from "../lib/queries.js";

/** `/w/$ws` (spec §18.1): loads /me and the registry into the route context, renders the shell. */
export const Route = createFileRoute("/w/$ws")({
  beforeLoad: async ({ context, params }) => {
    // Signed out: the root shows the sign-in screen; do not call the API without a token.
    if (!getToken()) throw new ApiError(401, "UNAUTHENTICATED", t("auth.title"));
    const me: Me = await context.queryClient.ensureQueryData(meQuery);
    const workspace = me.workspaces.find((w) => w.workspaceId === params.ws);
    if (!workspace) throw new ApiError(403, "FORBIDDEN", t("error.forbidden"));
    return { me, workspace };
  },
  loader: async ({ context, params }) => ({ registry: await context.queryClient.ensureQueryData(registryQuery(params.ws)) }),
  component: WorkspaceLayout,
  errorComponent: WorkspaceError,
});

function WorkspaceLayout(): ReactElement {
  const { ws } = Route.useParams();
  const { me: loaded } = Route.useRouteContext();
  // Live after the first load: a renamed person or a new workspace shows without a reload.
  const { data: me = loaded } = useQuery(meQuery);
  // Keeps the registry fresh after the loader (a new dimension shows up without a reload).
  useQuery(registryQuery(ws));
  return (
    <Shell me={me} ws={ws}>
      <Outlet />
    </Shell>
  );
}

function WorkspaceError({ error }: ErrorComponentProps): ReactElement {
  if (error instanceof ApiError && error.status === 401) return <SignIn expired />;
  // UX-004: a workspace the caller cannot use is a boundary with a way out, not an error.
  if (error instanceof ApiError && error.status === 403) return <NoAccess />;
  return <RouteFailure message={error instanceof Error ? error.message : String(error)} />;
}
