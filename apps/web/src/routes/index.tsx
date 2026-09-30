import { createFileRoute, redirect } from "@tanstack/react-router";
import { NoAccess } from "../components/denied.js";
import { getToken } from "../lib/auth.js";
import { meQuery, type Me } from "../lib/queries.js";

/** `/`: the caller's first workspace; for a superadmin without one, the org console. */
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    if (!getToken()) return;
    const me: Me = await context.queryClient.ensureQueryData(meQuery);
    const first = me.workspaces[0];
    if (first) throw redirect({ to: "/w/$ws", params: { ws: first.workspaceId } });
    // A superadmin with no workspace yet (a new deployment): the org console, to create one.
    if (me.isOrgAdmin) throw redirect({ to: "/org/workspaces" });
  },
  // Signed in with no role anywhere (UX-004): the same branded page, with what to do next.
  component: () => <NoAccess reason="none" />,
});
