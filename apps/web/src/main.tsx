import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./lib/api.js";
import { onTokenChange } from "./lib/auth.js";
import { parseSearch, stringifySearch } from "./lib/search-params.js";
import { routeTree } from "./routeTree.gen.js";
import "./styles.css";

/**
 * Mutations report through toasts when they say so (UX-007): `meta.success` is the message on
 * success; `meta.error` toasts the failure for screens that show no inline error.
 */
const mutationCache = new MutationCache({
  onSuccess: (_data, _vars, _ctx, mutation) => {
    const message = mutation.meta?.success;
    if (message) toast.success(message);
  },
  onError: (error, _vars, _ctx, mutation) => {
    if (mutation.meta?.error) toast.error(t("toast.failed", { message: error instanceof Error ? error.message : String(error) }));
  },
});
const queryClient = new QueryClient({
  mutationCache,
  defaultOptions: { queries: { retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2 } },
});
const router = createRouter({ routeTree, context: { queryClient }, defaultPreload: "intent", parseSearch, stringifySearch });

// Signing in or out: drop the previous caller's server state and re-run the route loaders.
onTokenChange(() => {
  queryClient.clear();
  void router.invalidate();
});

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: { success?: string; error?: boolean };
  }
}

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
