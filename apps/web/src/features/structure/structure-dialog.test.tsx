import "../../test/dom-polyfills.js";
import { t } from "@budget/ui/i18n";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvelopeDetail } from "../../lib/queries.js";
import { renderWithQuery } from "../../test/render.js";
import { StructureDialog } from "./structure-dialog.js";

// The component only ever calls `api.GET`/`api.POST` (and `queries.ts`'s helpers, which call the
// same `api`); mocking this one module is enough to control every network call it makes, per
// AGENTS.md ("mock the typed client, not fetch"). `unwrap` is made a passthrough so a mocked
// GET/POST can resolve straight to the domain object the real server would have handed it.
const { GET, POST } = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a) },
  unwrap: vi.fn(async (p: Promise<unknown>) => p),
}));

const ENV: EnvelopeDetail = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Brazil Meta",
  status: "ACTIVE",
  currency: "USD",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  dimensionValues: {},
  current: { id: "22222222-2222-2222-2222-222222222222", versionNo: 1, amount: "1000.00", status: "APPROVED" },
  draft: null,
  tags: [],
  parentId: null,
  rowVersion: 1,
  currentVersionId: "22222222-2222-2222-2222-222222222222",
  draftVersionId: null,
  openRequest: null,
  draftPolicy: null,
  structure: { parent: null, children: [], siblings: [] },
  ended: null,
  pendingKind: null,
  lineage: { continues: null, continuedBy: [] },
};

/** The commit `Button`'s tooltip reason (set by `@budget/ui`'s `data-disabled-reason`), or null when it is not disabled. */
function commitReason(): string | null {
  const button = screen.getByTestId("structure-commit");
  return button.closest("[data-disabled-reason]")?.getAttribute("data-disabled-reason") ?? null;
}

beforeEach(() => {
  GET.mockReset();
  POST.mockReset();
  GET.mockImplementation(async (path: string) => {
    if (path === "/api/v1/workspaces/{ws}/dimensions") return [];
    throw new Error(`unmocked GET ${path}`);
  });
  POST.mockImplementation(async (path: string, opts: { body?: { op?: string } }) => {
    if (path === "/api/v1/envelopes/structure/preview") {
      return { ok: true, op: opts.body?.op ?? "add_child", currency: "USD", amount: "250.00", parent: null, previousParent: null, routing: { kind: "immediate" as const, policy: null, steps: [] } };
    }
    if (path === "/api/v1/envelopes/{id}/children") {
      return { requestId: null, autoApproved: true, envelopeId: "33333333-3333-3333-3333-333333333333" };
    }
    throw new Error(`unmocked POST ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StructureDialog — add_child", () => {
  it("disables the commit button with the next missing field, as the form fills in", async () => {
    const user = userEvent.setup();
    renderWithQuery(<StructureDialog ws="ws-1" op="add_child" env={ENV} onDone={vi.fn()} onClose={vi.fn()} />);

    // Nothing filled in yet: the reason names the first missing field.
    expect(commitReason()).toBe(t("structure.needName"));

    await user.type(screen.getByTestId("child-name"), "Brazil Meta · 2");
    expect(commitReason()).toBe(t("structure.needAmount"));

    // An amount with more than two decimals is still not a valid amount.
    await user.type(screen.getByTestId("child-amount"), "123.456");
    expect(commitReason()).toBe(t("structure.needAmount"));
  });

  it("submits the add-child payload the preview approved, and reports the result", async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<StructureDialog ws="ws-1" op="add_child" env={ENV} onDone={onDone} onClose={vi.fn()} />);

    await user.type(screen.getByTestId("child-name"), "Brazil Meta · 2");
    await user.type(screen.getByTestId("child-amount"), "250.00");

    // The body only settles (and the preview is fetched) 350ms after the last keystroke.
    await waitFor(() => expect(commitReason()).toBeNull(), { timeout: 2000 });
    expect(screen.getByTestId("structure-preview").getAttribute("data-ok")).toBe("true");

    await user.click(screen.getByTestId("structure-commit"));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone.mock.calls[0]?.[0]).toEqual({ op: "add_child", requestId: null, autoApproved: true, newIds: ["33333333-3333-3333-3333-333333333333"] });

    const call = POST.mock.calls.find((args: unknown[]) => args[0] === "/api/v1/envelopes/{id}/children");
    expect(call).toBeDefined();
    const opts = (call as unknown[])[1] as { params: { path: { id: string } }; body: unknown };
    expect(opts).toMatchObject({ params: { path: { id: ENV.id } } });
    expect(opts.body).toEqual({
      name: "Brazil Meta · 2",
      amount: "250.00",
      dimensionValues: {},
      rationale: t("structure.defaultReason.add_child", { name: ENV.name }),
    });
  });
});

describe("StructureDialog — move", () => {
  it("requires a new parent before it will commit", async () => {
    renderWithQuery(<StructureDialog ws="ws-1" op="move" env={ENV} onDone={vi.fn()} onClose={vi.fn()} />);
    expect(commitReason()).toBe(t("structure.needParent"));
  });
});
