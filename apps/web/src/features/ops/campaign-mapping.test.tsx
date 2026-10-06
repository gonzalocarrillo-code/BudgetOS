import "../../test/dom-polyfills.js";
import { t } from "@budget/ui/i18n";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "../../test/render.js";
import { CampaignMapping, predicateText } from "./campaign-mapping.js";

const { GET, POST, DELETE } = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a), DELETE: (...a: unknown[]) => DELETE(...a) },
  unwrap: vi.fn(async (p: Promise<unknown>) => p),
}));

const WS = "01927a00-0000-7000-8000-0000000000a1";
const BR = "01927a00-0000-7000-8000-0000000000e1";
const BR2 = "01927a00-0000-7000-8000-0000000000e2";
const zero = { totalRows: 0, matchedRows: 0, unmatchedRows: 0, ambiguousRows: 0 };
const coverage = {
  from: null,
  to: null,
  currency: "USD",
  totals: { total: "100.00", matched: "60.00", unmatched: "25.00", ambiguous: "15.00", ...zero },
  bySource: [],
  byCampaign: [],
  open: [
    { campaign: "c-none", label: "Spring BR", status: "unmatched", amount: "25.00", rows: 2, firstDate: "2026-03-01", lastDate: "2026-03-02", candidates: [] },
    { campaign: "c-tie", label: null, status: "ambiguous", amount: "15.00", rows: 1, firstDate: "2026-03-01", lastDate: "2026-03-01", candidates: [{ id: BR, name: "Brazil" }, { id: BR2, name: "Brazil 2" }] },
    { campaign: null, label: null, status: "unmatched", amount: "5.00", rows: 1, firstDate: "2026-03-01", lastDate: "2026-03-01", candidates: [] },
  ],
};
const rule = { id: "01927a00-0000-7000-8000-0000000000f1", envelopeId: BR2, envelopeName: "Brazil 2", predicate: { logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "eq", value: "c-tie" }] }, startDate: null, endDate: null, createdBy: BR, createdAt: "2026-10-06T00:00:00.000Z" };

beforeEach(() => {
  GET.mockReset();
  POST.mockReset();
  DELETE.mockReset();
  GET.mockImplementation(async (path: string) => {
    if (path === "/api/v1/workspaces/{ws}/match-coverage") return coverage;
    if (path === "/api/v1/workspaces/{ws}/match-rules") return { rules: [] };
    if (path === "/api/v1/search") return { groups: [] };
    throw new Error(`unmocked GET ${path}`);
  });
  POST.mockImplementation(async () => ({ rule, rematch: { spend: 1, kpi: 0, projection: 0, envelopeIds: [BR2] } }));
});
afterEach(() => cleanup());

describe("CampaignMapping (EX-1)", () => {
  it("shows the server's split and the open campaigns largest first; a campaign-less row cannot be assigned, with a reason", async () => {
    renderWithQuery(<CampaignMapping ws={WS} from={undefined} to={undefined} canEditBudgets onPeriod={() => undefined} />);
    await screen.findByTestId("mapping-open");
    expect(screen.getByTestId("mapping-bar-matched").style.width).toBe("60%");
    expect(screen.getByTestId("mapping-bar-ambiguous").style.width).toBe("15%");
    const rows = screen.getAllByTestId("mapping-open-row");
    expect(rows.map((r) => r.textContent ?? "")).toEqual([expect.stringContaining("Spring BR"), expect.stringContaining("Brazil, Brazil 2"), expect.stringContaining(t("mapping.noCampaign"))]);
    const buttons = screen.getAllByTestId("mapping-assign");
    expect(buttons[2]?.closest("[data-disabled-reason]")?.getAttribute("data-disabled-reason")).toBe(t("mapping.noCampaignReason"));
    expect(buttons[0]?.closest("[data-disabled-reason]")).toBeNull();
  });

  it("Assign to budget creates the rule campaign = value for the chosen budget", async () => {
    renderWithQuery(<CampaignMapping ws={WS} from={undefined} to={undefined} canEditBudgets onPeriod={() => undefined} />);
    await screen.findByTestId("mapping-open");
    await userEvent.click(screen.getAllByTestId("mapping-assign")[1] as HTMLElement);
    const options = await screen.findAllByTestId("mapping-option");
    await userEvent.click(options[1] as HTMLElement); // Brazil 2, one of the tied candidates
    await waitFor(() => expect(POST).toHaveBeenCalled());
    expect(POST.mock.calls[0]?.[0]).toBe("/api/v1/workspaces/{ws}/match-rules");
    expect((POST.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({ envelopeId: BR2, predicate: { logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "eq", value: "c-tie" }] } });
    expect(await screen.findByTestId("mapping-notice")).toHaveProperty("textContent", t("mapping.assigned", { campaign: "c-tie", budget: "Brazil 2", n: 1 }));
  });

  it("without budget edit rights, assigning and deleting rules are disabled with a reason", async () => {
    GET.mockImplementation(async (path: string) => (path === "/api/v1/workspaces/{ws}/match-rules" ? { rules: [rule] } : coverage));
    renderWithQuery(<CampaignMapping ws={WS} from={undefined} to={undefined} canEditBudgets={false} onPeriod={() => undefined} />);
    await screen.findByTestId("mapping-rule");
    expect(screen.getByTestId("mapping-rule").textContent).toContain("campaign = c-tie → Brazil 2");
    expect(screen.getByTestId("mapping-rule-delete").closest("[data-disabled-reason]")?.getAttribute("data-disabled-reason")).toBe(t("mapping.noEditReason"));
    expect(screen.getAllByTestId("mapping-assign")[0]?.closest("[data-disabled-reason]")?.getAttribute("data-disabled-reason")).toBe(t("mapping.noEditReason"));
  });

  it("describes predicates in words", () => {
    expect(predicateText({ logic: "or", children: [{ field: { kind: "dimension", key: "campaign" }, op: "in", value: ["a", "b"] }, { logic: "and", not: true, children: [{ field: { kind: "dimension", key: "country" }, op: "is_empty" }] }] })).toBe("campaign in a, b or (not (country is empty))");
  });
});
