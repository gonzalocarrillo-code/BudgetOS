import "../../test/dom-polyfills.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "../../test/render.js";
import { FilterBar } from "../explorer/filter-bar.js";
import { FactValues } from "./fact-values.js";

/**
 * EX-9 (ADR-0094): campaign is "From your spend data". The registry shows its values read-only
 * (name, spend, first/last seen, source; no add/edit controls) and the filter bar searches them on
 * the server instead of reading registry values.
 */

const { GET } = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: { GET: (...a: unknown[]) => GET(...a) },
  unwrap: vi.fn(async (p: Promise<unknown>) => p),
}));

const WS = "01927a00-0000-7000-8000-0000000000a1";
const campaign = { id: "d5", key: "campaign", label: "Campaign", isActive: true, icon: "tag", description: null, dataType: "TEXT", color: null, allowedParents: [], isRequiredForLeaf: false, workspaceId: null, valuesSource: "facts" as const, values: [] };
const item = (code: string, spend: string) => ({ code, spend, currency: "USD", firstSeen: "2026-02-03", lastSeen: "2026-03-15", sourceSystems: ["bigquery"] });

beforeEach(() => {
  GET.mockImplementation(async (path: string, init: { params: { query?: { q?: string; offset?: number } } }) => {
    if (path !== "/api/v1/workspaces/{ws}/dimensions/{key}/fact-values") throw new Error(`unexpected GET ${path}`);
    const q = init.params.query?.q ?? "";
    const items = [item("Summer_Launch", "250.00"), item("Spring_Sale", "100.30")].filter((i) => i.code.toLowerCase().includes(q.toLowerCase()));
    return { key: "campaign", valuesSource: "facts", items, total: items.length, limit: 50, offset: init.params.query?.offset ?? 0 };
  });
});
afterEach(() => {
  cleanup();
  GET.mockReset();
});

describe("FactValues (EX-9)", () => {
  it("lists the campaigns in the spend data, read-only, and searches on the server", async () => {
    const onSearch = vi.fn();
    const { rerender, client } = renderWithQuery(<FactValues ws={WS} dim={campaign} q="" page={0} onSearch={onSearch} onPage={() => undefined} />);
    await waitFor(() => expect(screen.getAllByTestId("fact-value-row")).toHaveLength(2));
    expect(screen.getAllByTestId("fact-value-row").map((r) => r.getAttribute("data-value"))).toEqual(["Summer_Launch", "Spring_Sale"]);
    expect(screen.getByTestId("fact-values-table").textContent).toContain("2026-03-15");
    expect(screen.getByTestId("fact-values-range").textContent).toBe("1–2 of 2");
    // Nothing to add, edit or delete.
    expect(screen.queryByTestId("values-input")).toBeNull();
    expect(screen.queryByRole("button", { name: /add|edit|rename|merge|retire|delete/i })).toBeNull();

    await userEvent.type(screen.getByTestId("fact-values-search"), "s");
    expect(onSearch).toHaveBeenCalledWith("s");
    rerender(
      <QueryClientProvider client={client}>
        <FactValues ws={WS} dim={campaign} q="spring" page={0} onSearch={onSearch} onPage={() => undefined} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId("fact-value-row").map((r) => r.getAttribute("data-value"))).toEqual(["Spring_Sale"]));
    expect(GET).toHaveBeenCalledWith("/api/v1/workspaces/{ws}/dimensions/{key}/fact-values", { params: { path: { ws: WS, key: "campaign" }, query: { q: "spring", limit: 50, offset: 0 } } });
  });
});

describe("FilterBar on a data-derived granularity (EX-9)", () => {
  it("offers the campaigns from the spend data and filters with an `in` predicate", async () => {
    const onChange = vi.fn();
    renderWithQuery(<FilterBar ws={WS} filter={{ logic: "and", children: [] }} dimensions={[campaign]} onChange={onChange} />);
    await userEvent.click(screen.getByTestId("filter-add"));
    await userEvent.selectOptions(screen.getByTestId("filter-dimension"), "campaign");
    await userEvent.click(screen.getByTestId("filter-values-search"));
    await waitFor(() => expect(screen.getAllByTestId("filter-value-option").map((o) => o.getAttribute("data-value"))).toEqual(["Summer_Launch", "Spring_Sale"]));
    await userEvent.click(screen.getAllByTestId("filter-value-option")[1] as HTMLElement);
    await userEvent.click(screen.getByTestId("filter-apply"));
    expect(onChange).toHaveBeenCalledWith({ logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "in", value: ["Spring_Sale"] }] });
  });
});
