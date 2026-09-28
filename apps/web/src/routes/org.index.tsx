import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/org` opens on its workspaces. */
export const Route = createFileRoute("/org/")({
  beforeLoad: () => {
    throw redirect({ to: "/org/workspaces" });
  },
});
