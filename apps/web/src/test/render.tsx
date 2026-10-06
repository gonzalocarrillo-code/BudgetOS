import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

/** A query client with no retries and no caching between tests, so a mocked failure surfaces at once. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/** Renders `ui` inside the same `QueryClientProvider` every screen gets in the app. */
export function renderWithQuery(ui: ReactElement, client: QueryClient = createTestQueryClient()): RenderResult & { client: QueryClient } {
  const result = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { ...result, client };
}
