import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./lib/api.js";
import { onTokenChange } from "./lib/auth.js";
import { routeTree } from "./routeTree.gen.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2 } },
});
const router = createRouter({ routeTree, context: { queryClient }, defaultPreload: "intent" });

// Signing in or out: drop the previous caller's server state and re-run the route loaders.
onTokenChange(() => {
  queryClient.clear();
  void router.invalidate();
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
