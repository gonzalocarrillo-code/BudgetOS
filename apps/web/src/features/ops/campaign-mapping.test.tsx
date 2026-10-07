import "../../test/dom-polyfills.js";
import { t } from "@budget/ui/i18n";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderWithQuery } from "../../test/render.js";
import { MappingRules, UnassignedCampaigns, parseAliases, predicateText } from "./campaign-mapping.js";

const { GET, POST, DELETE, PATCH } = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a), DELETE: (...a: unknown[]) => DELETE(...a), PATCH: (...a: unknown[]) => PATCH(...a) },
  unwrap: vi.fn(async (p: Promise<unknown>) => p),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className, ...rest }: { to: string; children?: ReactNode; className?: string; params?: unknown; search?: unknown; "data-testid"?: string }) => (
    <a href={to} className={className} data-testid={rest["data-testid"]}>
      {children}
    </a>
  ),
}));

const WS = "01927a00-0000-7000-8000-0000000000a1";
const BR = "01927a00-0000-7000-8000-0000000000e1";
const BR2 = "01927a00-0000-7000-8000-0000000000e2";
const SRC = "01927a00-0000-7000-8000-0000000000c1";
const CONV = "01927a00-0000-7000-8000-0000000000d1";
const zero = { totalRows: 0, matchedRows: 0, unmatchedRows: 0, ambiguousRows: 0 };
const coverage = {
  from: null,
  to: null,
  currency: "USD",
  totals: { total: "100.00", matched: "60.00", unmatched: "25.00", ambiguous: "15.00", ...zero },
  bySource: [],
  byCampaign: [{ campaign: "c-1", label: "BR_FB_Prospecting", total: "40.00", matched: "40.00", unmatched: "0", ambiguous: "0", ...zero }],
  open: [
    { campaign: "c-none", label: "Spring BR", status: "unmatched", reason: "name_mismatch", amount: "25.00", rows: 2, firstDate: "2026-03-01", lastDate: "2026-03-02", candidates: [] },
    { campaign: "c-tie", label: null, status: "ambiguous", reason: null, amount: "15.00", rows: 1, firstDate: "2026-03-01", lastDate: "2026-03-01", candidates: [{ id: BR, name: "Brazil" }, { id: BR2, name: "Brazil 2" }] },
    { campaign: null, label: null, status: "unmatched", reason: "unknown_budget_ref", amount: "5.00", rows: 1, firstDate: "2026-03-01", lastDate: "2026-03-01", candidates: [] },
  ],
};
const rule = { id: "01927a00-0000-7000-8000-0000000000f1", envelopeId: BR2, envelopeName: "Brazil 2", predicate: { logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "eq", value: "c-tie" }] }, startDate: null, endDate: null, createdBy: BR, createdAt: "2026-10-06T00:00:00.000Z" };
const convention = { id: CONV, delimiter: "_", tokens: [{ dimension: "country", aliases: {} }, { dimension: "platform", aliases: { FB: "meta" } }, { dimension: null, aliases: {} }], createdBy: BR, createdAt: "2026-10-06T00:00:00.000Z" };
const source = { id: SRC, kind: "bigquery", name: "Warehouse", config: { kind: "bigquery" }, mapping: { kind: "spend", columns: { day: { role: "period_date" }, spend: { role: "amount" }, budget_id: { role: "ignore" } } }, schedule: null, isActive: true };
const dims = [
  { id: BR, key: "country", label: "Country", isActive: true, icon: "tag", values: [] },
  { id: BR2, key: "platform", label: "Platform", isActive: true, icon: "tag", values: [] },
  { id: SRC, key: "campaign", label: "Campaign", isActive: true, icon: "tag", values: [] },
];
let rules: Record<string, unknown> = { rules: [], conventions: [], references: [] };

beforeEach(() => {
  rules = { rules: [], conventions: [], references: [] };
  for (const m of [GET, POST, DELETE, PATCH]) m.mockReset();
  GET.mockImplementation(async (path: string) => {
    if (path === "/api/v1/workspaces/{ws}/match-coverage") return coverage;
    if (path === "/api/v1/workspaces/{ws}/match-rules") return rules;
    if (path === "/api/v1/workspaces/{ws}/sources") return [source];
    if (path === "/api/v1/workspaces/{ws}/dimensions") return dims;
    if (path === "/api/v1/search") return { groups: [] };
    throw new Error(`unmocked GET ${path}`);
  });
  POST.mockImplementation(async (path: string, init: { body: { convention?: unknown } }) => {
    if (path === "/api/v1/workspaces/{ws}/naming-conventions/preview")
      return {
        samples: [
          { name: "BR_FB_Prospecting", campaign: "c-1", dimensionValues: { country: "BR", platform: "meta" }, problem: null, parts: [{ position: 1, raw: "BR", dimension: "country", code: "BR", source: "registry" }, { position: 2, raw: "FB", dimension: "platform", code: "meta", source: "alias" }, { position: 3, raw: "Prospecting", dimension: null, code: null, source: null }] },
          { name: "Spring BR", campaign: "c-none", dimensionValues: null, problem: { kind: "parts", expected: 3, found: 1 }, parts: [] },
        ],
        unresolved: [{ position: 1, dimension: "country", token: "Narnia", campaigns: 2, amount: "25.00" }],
        currency: "USD",
      };
    if (path === "/api/v1/workspaces/{ws}/naming-conventions") return { convention: { ...convention, ...(init.body as object) }, rematch: { spend: 3, kpi: 0, projection: 0, envelopeIds: [BR] } };
    return { rule, rematch: { spend: 1, kpi: 0, projection: 0, envelopeIds: [BR2] } };
  });
  DELETE.mockImplementation(async () => ({}));
  PATCH.mockImplementation(async () => source);
});
afterEach(() => cleanup());

describe("MappingRules (EX-5)", () => {
  it("explains how mapping works in one paragraph and draws no coverage bar or coloured chips", async () => {
    renderWithQuery(<MappingRules ws={WS} canEditBudgets />);
    expect(screen.getByTestId("mapping-help").textContent).toBe(t("mapping.help"));
    await screen.findByTestId("mapping-rules-empty");
    expect(screen.queryByTestId("mapping-coverage")).toBeNull();
    expect(document.querySelector(".bg-success, .bg-warning, .bg-destructive, [data-status]")).toBeNull();
  });

  it("lists the three kinds of rule, each with what it matches and its target", async () => {
    rules = { rules: [rule], conventions: [convention], references: [{ sourceId: SRC, sourceName: "Warehouse", column: "budget_id" }] };
    renderWithQuery(<MappingRules ws={WS} canEditBudgets />);
    await screen.findByTestId("mapping-rule-list");
    const rows = screen.getAllByTestId("mapping-rule");
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual(["database", "campaign", "nomenclature"]);
    expect(rows[0]?.textContent).toContain(t("mapping.referenceLine", { source: "Warehouse", column: "budget_id" }));
    expect(rows[1]?.textContent).toContain("campaign = c-tie → Brazil 2");
    expect(rows[2]?.textContent).toContain(t("mapping.conventionLine", { delimiter: "_", parts: `country · platform (FB=meta) · ${t("mapping.ignored")}` }));
  });

  it("deleting: a campaign rule and a database reference (its column goes back to ignored); the convention is edited in Registry", async () => {
    rules = { rules: [rule], conventions: [convention], references: [{ sourceId: SRC, sourceName: "Warehouse", column: "budget_id" }] };
    source.mapping.columns.budget_id = { role: "budget_ref" };
    renderWithQuery(<MappingRules ws={WS} canEditBudgets />);
    await screen.findByTestId("mapping-rule-list");
    await screen.findAllByTestId("mapping-rule");
    const del = () => screen.getAllByTestId("mapping-rule-delete");
    expect(del()).toHaveLength(2);
    expect(within(screen.getAllByTestId("mapping-rule")[2] as HTMLElement).getByTestId("mapping-edit-naming").getAttribute("href")).toBe("/w/$ws/admin/registry");
    await userEvent.click(del()[1] as HTMLElement);
    await waitFor(() => expect(DELETE).toHaveBeenCalledWith("/api/v1/match-rules/{id}", expect.anything()));
    await waitFor(() => expect(del()[0]?.closest("[data-disabled-reason]")).toBeNull());
    await userEvent.click(del()[0] as HTMLElement);
    await waitFor(() => expect(PATCH).toHaveBeenCalled());
    expect((PATCH.mock.calls[0]?.[1] as { body: { mapping: { columns: Record<string, unknown> } } }).body.mapping.columns["budget_id"]).toEqual({ role: "ignore" });
    source.mapping.columns.budget_id = { role: "ignore" };
  });

  it("EX-6: the convention is shown read-only with its preview (unresolved in words, no colours) and unresolved tokens, without Map to", async () => {
    rules = { rules: [], conventions: [convention], references: [] };
    renderWithQuery(<MappingRules ws={WS} canEditBudgets />);
    const preview = await screen.findByTestId("naming-preview");
    await waitFor(() => expect(within(preview).getAllByTestId("naming-preview-row")).toHaveLength(2));
    const rows = within(preview).getAllByTestId("naming-preview-row");
    expect(rows[0]?.textContent).toContain("meta");
    expect(rows[1]?.textContent).toContain(t("mapping.problem.parts", { found: 1, expected: 3 }));
    expect(within(preview).getAllByTestId("naming-unresolved-row")[0]?.textContent).toContain("Narnia");
    expect(within(preview).queryByTestId("naming-map-to")).toBeNull();
    expect(document.querySelector(".bg-success, .bg-warning, .bg-destructive")).toBeNull();
  });

  it("without budget edit rights a campaign rule cannot be deleted, with a reason", async () => {
    rules = { rules: [rule], conventions: [], references: [] };
    renderWithQuery(<MappingRules ws={WS} canEditBudgets={false} />);
    await screen.findByTestId("mapping-rule");
    expect(screen.getByTestId("mapping-rule-delete").closest("[data-disabled-reason]")?.getAttribute("data-disabled-reason")).toBe(t("mapping.noEditReason"));
  });

  it("Add rule → nomenclature points to Registry, where the convention is defined", async () => {
    renderWithQuery(<MappingRules ws={WS} canEditBudgets />);
    await userEvent.click(await screen.findByTestId("mapping-add"));
    await userEvent.click(screen.getByTestId("mapping-kind-nomenclature"));
    const box = screen.getByTestId("mapping-naming-in-registry");
    expect(box.textContent).toContain(t("campaignNaming.setInRegistry"));
    expect(within(box).getByTestId("mapping-edit-naming")).toBeTruthy();
    expect(POST.mock.calls.some((c) => c[0] === "/api/v1/workspaces/{ws}/naming-conventions")).toBe(false);
  });

  it("Add rule → from the database: a source column becomes the budget reference (one per source)", async () => {
    renderWithQuery(<MappingRules ws={WS} canEditBudgets />);
    await userEvent.click(await screen.findByTestId("mapping-add"));
    await userEvent.click(screen.getByTestId("mapping-kind-database"));
    await waitFor(() => expect((screen.getByTestId("mapping-source") as HTMLSelectElement).value).toBe(SRC));
    await userEvent.type(screen.getByTestId("mapping-column"), "budget_id");
    await userEvent.click(screen.getByTestId("mapping-save"));
    await waitFor(() => expect(PATCH).toHaveBeenCalled());
    expect(PATCH.mock.calls[0]?.[0]).toBe("/api/v1/sources/{id}");
    expect((PATCH.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({ mapping: { kind: "spend", columns: { day: { role: "period_date" }, spend: { role: "amount" }, budget_id: { role: "budget_ref" } } } });
  });

  it("describes predicates in words and reads aliases", () => {
    expect(predicateText({ logic: "or", children: [{ field: { kind: "dimension", key: "campaign" }, op: "in", value: ["a", "b"] }, { logic: "and", not: true, children: [{ field: { kind: "dimension", key: "country" }, op: "is_empty" }] }] })).toBe("campaign in a, b or (not (country is empty))");
    expect(parseAliases("FB=meta, IG = meta, broken, =x")).toEqual({ FB: "meta", IG: "meta" });
  });
});

describe("UnassignedCampaigns (EX-5)", () => {
  it("is a plain list with the reason in words; a campaign-less row cannot get a rule, with a reason", async () => {
    renderWithQuery(<UnassignedCampaigns ws={WS} canEditBudgets />);
    await screen.findAllByTestId("mapping-open-row");
    expect(screen.getAllByTestId("mapping-open-why").map((e) => e.textContent)).toEqual([t("mapping.why.name_mismatch"), t("mapping.why.ambiguous", { budgets: "Brazil, Brazil 2" }), t("mapping.why.unknown_budget_ref")]);
    expect(document.querySelector("[data-status]")).toBeNull();
    const buttons = screen.getAllByTestId("mapping-create-rule");
    expect(buttons[2]?.closest("[data-disabled-reason]")?.getAttribute("data-disabled-reason")).toBe(t("mapping.noCampaignReason"));
    expect(buttons[0]?.closest("[data-disabled-reason]")).toBeNull();
  });

  it("Create rule makes campaign = value → the chosen budget", async () => {
    renderWithQuery(<UnassignedCampaigns ws={WS} canEditBudgets />);
    await screen.findAllByTestId("mapping-open-row");
    await userEvent.click(screen.getAllByTestId("mapping-create-rule")[1] as HTMLElement);
    const options = await screen.findAllByTestId("mapping-option");
    await userEvent.click(options[1] as HTMLElement); // Brazil 2, one of the tied candidates
    await waitFor(() => expect(POST).toHaveBeenCalled());
    expect(POST.mock.calls[0]?.[0]).toBe("/api/v1/workspaces/{ws}/match-rules");
    expect((POST.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({ envelopeId: BR2, predicate: { logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "eq", value: "c-tie" }] } });
    expect(await screen.findByTestId("mapping-open-notice")).toHaveProperty("textContent", t("mapping.assigned", { campaign: "c-tie", budget: "Brazil 2", n: 1 }));
  });

  it("without budget edit rights, Create rule is disabled with a reason", async () => {
    renderWithQuery(<UnassignedCampaigns ws={WS} canEditBudgets={false} />);
    await screen.findAllByTestId("mapping-open-row");
    expect(screen.getAllByTestId("mapping-create-rule")[0]?.closest("[data-disabled-reason]")?.getAttribute("data-disabled-reason")).toBe(t("mapping.noEditReason"));
  });
});
