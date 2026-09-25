import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { useSyncExternalStore, type ReactElement } from "react";
import { SignIn } from "../components/sign-in.js";
import { getToken, onTokenChange } from "../lib/auth.js";

export interface RouterContext {
  queryClient: QueryClient;
}

/** Root (spec §18.1): without a token the app is the sign-in screen; the shell lives in w.$ws. */
function Root(): ReactElement {
  const token = useSyncExternalStore(onTokenChange, getToken, () => null);
  return token ? <Outlet /> : <SignIn />;
}

export const Route = createRootRouteWithContext<RouterContext>()({ component: Root });
