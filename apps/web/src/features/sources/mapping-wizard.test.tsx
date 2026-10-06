import "../../test/dom-polyfills.js";
import { t } from "@budget/ui/i18n";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, renderWithQuery } from "../../test/render.js";
import { MappingWizard } from "./mapping-wizard.js";

// Same approach as structure-dialog.test.tsx: mock the typed client, let the real `mapping.ts`
// guesser and the real `@budget/domain` SourceMapping validation run against it.
const { GET, POST } = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a) },
  unwrap: vi.fn(async (p: Promise<unknown>) => p),
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

const CSV = "date,country,spend\n2026-01-01,US,100.00\n2026-01-02,BR,50.00\n";

/** The Next/Save button's tooltip reason, or null when the button is not disabled. */
function reasonOf(testId: string): string | null {
  const button = screen.getByTestId(testId);
  return button.closest("[data-disabled-reason]")?.getAttribute("data-disabled-reason") ?? null;
}

beforeEach(() => {
  GET.mockReset();
  POST.mockReset();
  GET.mockImplementation(async (path: string) => {
    if (path === "/api/v1/workspaces/{ws}/dimensions") return [{ id: "d1", key: "country", label: "Country", icon: "flag", values: [] }];
    if (path === "/api/v1/workspaces/{ws}/mapping-synonyms") return { columns: [], metrics: [], ratioWords: [] };
    throw new Error(`unmocked GET ${path}`);
  });
  POST.mockImplementation(async (path: string) => {
    if (path === "/api/v1/workspaces/{ws}/mapping-profiles/match") return { profile: null, fit: null };
    if (path === "/api/v1/workspaces/{ws}/mapping-preview") return { rowsChecked: 0, rowsRejected: 0, problems: [], columns: [], rejects: [] };
    if (path === "/api/v1/workspaces/{ws}/mapping-suggestions") {
      return {
        model: "gpt-test",
        mapping: {
          kind: "spend",
          columns: {
            date: { role: "period_date", format: "yyyy-MM-dd" },
            country: { dimension: "country" },
            spend: { role: "amount", currency: "EUR" },
          },
        },
      };
    }
    throw new Error(`unmocked POST ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MappingWizard", () => {
  it("moves from connect to columns to save, disabling Next until the amount has a currency, and applies an AI suggestion", async () => {
    const user = userEvent.setup();
    const client = createTestQueryClient();
    renderWithQuery(<MappingWizard ws="ws-1" onDone={vi.fn()} onCancel={vi.fn()} />, client);

    // The registry has to be loaded before the file is read, or "country" won't be guessed as a dimension.
    await waitFor(() => expect(client.getQueryData(["registry", "ws-1"])).toBeDefined());

    expect(screen.getByTestId("mapping-wizard").getAttribute("data-step")).toBe("1");
    await user.click(screen.getByTestId("connector-csv"));
    const file = new File([CSV], "spend.csv", { type: "text/csv" });
    await user.upload(screen.getByTestId("wizard-file"), file);

    await waitFor(() => expect(screen.getByTestId("mapping-wizard").getAttribute("data-step")).toBe("2"));

    // date → period_date and country → dimension are guessed; spend → amount, but with no currency
    // column and no inline currency the mapping is incomplete (packages/domain/src/sources.ts).
    await waitFor(() => expect(reasonOf("wizard-next")).toBe("The amount needs a currency, inline or from a currency column"));

    await user.click(screen.getByTestId("wizard-ai"));
    await waitFor(() => expect(screen.getByTestId("wizard-ai-note")).toBeTruthy());
    expect(screen.getByTestId("wizard-ai-note").textContent).toBe(t("sources.ai.applied", { model: "gpt-test" }));
    // The suggestion's inline currency is now on the amount column's own field.
    expect((screen.getByTestId("wizard-currency") as HTMLInputElement).value).toBe("EUR");

    // A complete mapping has nothing left to fix: Next is enabled.
    await waitFor(() => expect(reasonOf("wizard-next")).toBeNull());
    expect(screen.getByTestId("wizard-ok")).toBeTruthy();

    await user.click(screen.getByTestId("wizard-next"));
    expect(screen.getByTestId("mapping-wizard").getAttribute("data-step")).toBe("3");
  });

  it("disables Next with a reason when a required mapping (one period_date column) is missing", async () => {
    const user = userEvent.setup();
    const client = createTestQueryClient();
    renderWithQuery(<MappingWizard ws="ws-1" onDone={vi.fn()} onCancel={vi.fn()} />, client);
    await waitFor(() => expect(client.getQueryData(["registry", "ws-1"])).toBeDefined());

    await user.click(screen.getByTestId("connector-csv"));
    // No column name here looks like a date, so nothing is guessed as period_date.
    const file = new File(["country,spend\nUS,100.00\n", ], "no-date.csv", { type: "text/csv" });
    await user.upload(screen.getByTestId("wizard-file"), file);

    await waitFor(() => expect(screen.getByTestId("mapping-wizard").getAttribute("data-step")).toBe("2"));
    await waitFor(() => expect(reasonOf("wizard-next")).toBe("Map exactly one period_date column"));
  });
});
