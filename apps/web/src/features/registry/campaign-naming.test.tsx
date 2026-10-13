import "../../test/dom-polyfills.js";
import { t } from "@budget/ui/i18n";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "../../test/render.js";
import { CampaignNaming, draftInput } from "./campaign-naming.js";

/**
 * EX-6 (ADR-0092) / EX-7 (ADR-0093): Registry › Campaign names. Analyze names fills the positions;
 * each position is a granularity (with its dictionary and "Edit dictionary"), ignored, a date or free
 * text; a new granularity is created inline; Suggest with AI only suggests (disabled with a reason
 * without OpenAI); the preview says unresolved tokens in words, per position, and "Define" adds a
 * dictionary entry; Save PUTs.
 */

const { GET, POST, PUT, DELETE } = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a), PUT: (...a: unknown[]) => PUT(...a), DELETE: (...a: unknown[]) => DELETE(...a) },
  unwrap: vi.fn(async (p: Promise<unknown>) => p),
}));

const WS = "01927a00-0000-7000-8000-0000000000a1";
const ID = "01927a00-0000-7000-8000-0000000000d1";
const USER = "01927a00-0000-7000-8000-0000000000b1";
const dims = [
  { id: "d1", key: "country", label: "Country", isActive: true, icon: "tag", values: [{ id: "v1", code: "BR", label: "Brazil" }] },
  { id: "d2", key: "platform", label: "Platform", isActive: true, icon: "tag", values: [] },
  { id: "d3", key: "audience", label: "Audience", isActive: true, icon: "tag", values: [] },
  { id: "d4", key: "client", label: "Client", isActive: true, icon: "tag", values: [] },
  { id: "d5", key: "campaign", label: "Campaign", isActive: true, icon: "tag", values: [] },
].map((d) => ({ description: null, dataType: "ENUM", color: null, allowedParents: [], isRequiredForLeaf: false, workspaceId: null, ...d, values: d.values.map((v) => ({ path: "", parentValueId: null, isActive: true, aliases: [], mergedIntoId: null, ...v })) }));

const savedConvention = { id: ID, delimiter: "_", tokens: [{ dimension: "country", aliases: {} }, { dimension: "platform", aliases: {} }, { dimension: "audience", aliases: {} }], createdBy: USER, createdAt: "2026-10-07T00:00:00.000Z" };
let state: Record<string, unknown> = { convention: null, others: 0, aiAvailable: false };
const analysis = {
  source: "facts",
  delimiter: "_",
  partCount: 3,
  total: 3,
  fitting: 3,
  positions: [
    { position: 1, cardinality: 3, examples: ["BR", "UK", "Brasil"], hits: [{ kind: "country", dimension: "country", hitRate: 1 }], best: { kind: "country", dimension: "country", hitRate: 1 } },
    { position: 2, cardinality: 2, examples: ["FB", "Meta"], hits: [{ kind: "platform", dimension: "platform", hitRate: 1 }], best: { kind: "platform", dimension: "platform", hitRate: 1 } },
    { position: 3, cardinality: 3, examples: ["Prospecting", "Retargeting", "Zzz"], hits: [{ kind: "audience", dimension: "audience", hitRate: 0.6667 }], best: { kind: "audience", dimension: "audience", hitRate: 0.6667 } },
  ],
  proposal: { delimiter: "_", tokens: [{ dimension: "country", aliases: {} }, { dimension: "platform", aliases: {} }, { dimension: "audience", aliases: {} }] },
};
const preview = {
  samples: [
    {
      name: "Brasil_FB_Zzz",
      campaign: "c-3",
      dimensionValues: null,
      problem: { kind: "unknown_value", position: 3, dimension: "audience", value: "Zzz" },
      parts: [
        { position: 1, raw: "Brasil", dimension: "country", code: "BR", source: "dictionary" },
        { position: 2, raw: "FB", dimension: "platform", code: "meta", source: "dictionary" },
        { position: 3, raw: "Zzz", dimension: "audience", code: null, source: null },
      ],
    },
  ],
  unresolved: [{ position: 3, dimension: "audience", token: "Zzz", campaigns: 1, amount: "5.00" }],
  currency: "USD",
};
const suggestion = {
  suggestion: { delimiter: "_", positions: [{ dimension: "country", confidence: 0.9 }, { dimension: "platform", confidence: 0.9 }, { dimension: "audience", confidence: 0.7 }], mappings: [{ position: 3, token: "Zzz", value: "retargeting", confidence: 0.6 }] },
  proposal: { delimiter: "_", tokens: [{ dimension: "country", aliases: {} }, { dimension: "platform", aliases: {} }, { dimension: "audience", aliases: { Zzz: "retargeting" } }] },
  model: "m",
  names: 3,
  applied: false,
};
const saveResponse = { convention: savedConvention, rematch: { spend: 3, kpi: 0, projection: 0, envelopeIds: [] }, createdValues: [{ dimension: "country", code: "GB", label: "United Kingdom" }] };

beforeEach(() => {
  state = { convention: null, others: 0, aiAvailable: false };
  for (const m of [GET, POST, PUT, DELETE]) m.mockReset();
  GET.mockImplementation(async (path: string) => {
    if (path === "/api/v1/workspaces/{ws}/naming-convention") return state;
    if (path === "/api/v1/workspaces/{ws}/naming-dictionaries")
      return { dictionaries: [{ dimension: "country", label: "Country", kind: "country", seeded: true, builtinCount: 1200, syncSourceId: null, position: 1, entries: 1200 }], aiAvailable: state["aiAvailable"] };
    throw new Error(`unmocked GET ${path}`);
  });
  POST.mockImplementation(async (path: string) => {
    if (path === "/api/v1/workspaces/{ws}/naming-conventions/analyze") return analysis;
    if (path === "/api/v1/workspaces/{ws}/naming-conventions/preview") return preview;
    if (path === "/api/v1/workspaces/{ws}/naming-conventions/suggest") return suggestion;
    if (path === "/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/entries") return { dimension: "audience", written: 1, skipped: 0, removed: 0, createdValues: [], rematch: null };
    if (path === "/api/v1/workspaces/{ws}/dimensions") return { id: "d9", key: "product" };
    throw new Error(`unmocked POST ${path}`);
  });
  PUT.mockImplementation(async () => saveResponse);
});
afterEach(() => cleanup());

const reason = (testId: string) => screen.getByTestId(testId).closest("[data-disabled-reason]")?.getAttribute("data-disabled-reason") ?? null;

const proposalInput = { delimiter: "_", tokens: ["country", "platform", "audience"].map((d) => ({ dimension: d, aliases: {}, kind: "dimension" })) };

describe("CampaignNaming (EX-6, EX-7)", () => {
  it("Analyze names fills the positions; each granularity shows its dictionary; the preview says unresolved tokens in words; Save PUTs", async () => {
    renderWithQuery(<CampaignNaming ws={WS} dims={dims} canManage />);
    await waitFor(() => expect(reason("naming-save")).toBe(t("campaignNaming.needDimension")));
    await userEvent.click(screen.getByTestId("naming-analyze"));
    const a = await screen.findByTestId("naming-analysis");
    expect(within(a).getAllByTestId("naming-analysis-row")[0]?.textContent).toContain("100%");
    expect(POST.mock.calls.find((c) => c[0] === "/api/v1/workspaces/{ws}/naming-conventions/analyze")?.[1]).toMatchObject({ body: {} });
    await userEvent.click(screen.getByTestId("naming-analysis-use"));
    const selects = screen.getAllByTestId("naming-position-dimension") as HTMLSelectElement[];
    expect(selects.map((s) => s.value)).toEqual(["dim:country", "dim:platform", "dim:audience"]);
    await waitFor(() => expect(screen.getAllByTestId("naming-position-dictionary")[0]?.textContent).toBe(`${t("campaignNaming.dict.country")} · ${t("campaignNaming.entries", { n: 1200 })}`));
    expect([...(selects[0]?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value"))).toEqual(["ignore", "date", "free_text", "dim:country", "dim:client", "new"]);
    const p = await screen.findByTestId("naming-preview");
    await waitFor(() => expect(within(p).getAllByTestId("naming-preview-row")).toHaveLength(1));
    const cells = within(p).getAllByTestId("naming-preview-cell");
    expect(cells.map((c) => c.getAttribute("data-resolved"))).toEqual(["yes", "yes", "no"]);
    expect(cells[2]?.textContent).toBe(t("campaignNaming.unresolvedCell", { token: "Zzz" }));
    expect(p.querySelector(".bg-success, .bg-warning, .bg-destructive")).toBeNull();
    expect(within(p).getAllByTestId("naming-unresolved-position")[0]?.textContent).toContain(t("campaignNaming.unresolvedPosition", { position: 3, dimension: "Audience", n: 1 }));
    await userEvent.click(screen.getByTestId("naming-save"));
    await waitFor(() => expect(PUT).toHaveBeenCalled());
    expect((PUT.mock.calls[0]?.[1] as { body: unknown }).body).toEqual(proposalInput);
    expect(await screen.findByTestId("naming-notice")).toHaveProperty("textContent", t("campaignNaming.saved", { n: 3, created: t("campaignNaming.created", { n: 1 }) }));
  });

  it("Suggest with AI is disabled with a reason without OpenAI, and for someone who cannot manage", async () => {
    renderWithQuery(<CampaignNaming ws={WS} dims={dims} canManage />);
    await waitFor(() => expect(reason("naming-suggest")).toBe(t("campaignNaming.aiOff")));
    cleanup();
    state = { convention: null, others: 0, aiAvailable: true };
    renderWithQuery(<CampaignNaming ws={WS} dims={dims} canManage={false} />);
    await waitFor(() => expect(reason("naming-suggest")).toBe(t("campaignNaming.noManage")));
    expect(reason("naming-save")).toBe(t("campaignNaming.noManage"));
  });

  it("an AI suggestion is shown for review; nothing is saved until the user accepts and saves", async () => {
    state = { convention: null, others: 0, aiAvailable: true };
    renderWithQuery(<CampaignNaming ws={WS} dims={dims} canManage />);
    await waitFor(() => expect(reason("naming-suggest")).toBeNull());
    await userEvent.type(screen.getByTestId("naming-names"), "BR_FB_Prospecting{enter}UK_Meta_Retargeting");
    await userEvent.click(screen.getByTestId("naming-suggest"));
    const s = await screen.findByTestId("naming-suggestion");
    expect(POST.mock.calls.find((c) => c[0] === "/api/v1/workspaces/{ws}/naming-conventions/suggest")?.[1]).toMatchObject({ body: { names: ["BR_FB_Prospecting", "UK_Meta_Retargeting"] } });
    expect(within(s).getAllByTestId("naming-suggestion-row")[2]?.textContent).toContain("Zzz → retargeting");
    expect(PUT).not.toHaveBeenCalled();
    expect((screen.getAllByTestId("naming-position-dimension") as HTMLSelectElement[]).map((x) => x.value)).toEqual(["ignore"]);
    await userEvent.click(screen.getByTestId("naming-suggestion-use"));
    expect((screen.getAllByTestId("naming-position-dimension") as HTMLSelectElement[]).map((x) => x.value)).toEqual(["dim:country", "dim:platform", "dim:audience"]);
    // Aliases are not typed any more: the AI's mappings are shown, codes are defined in the dictionaries.
    expect(screen.queryByTestId("naming-position-aliases")).toBeNull();
    expect(screen.queryByTestId("naming-position-legacy")).toBeNull();
    expect(PUT).not.toHaveBeenCalled();
  });

  it("'Define' on an unresolved code adds it to the granularity's dictionary; Edit dictionary opens it", async () => {
    state = { convention: savedConvention, others: 0, aiAvailable: false };
    const onEdit = vi.fn();
    renderWithQuery(<CampaignNaming ws={WS} dims={dims} canManage onEditDictionary={onEdit} />);
    await waitFor(() => expect(reason("naming-save")).toBe(t("campaignNaming.unchanged")));
    const p = await screen.findByTestId("naming-preview");
    await userEvent.click(await within(p).findByTestId("naming-define"));
    expect(reason("naming-define-save")).toBe(t("namingDict.needMeaning"));
    await userEvent.type(screen.getByTestId("naming-define-meaning"), "Retargeting");
    await userEvent.click(screen.getByTestId("naming-define-save"));
    const call = await waitFor(() => {
      const c = POST.mock.calls.find((x) => x[0] === "/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/entries");
      expect(c).toBeDefined();
      return c?.[1] as { params: { path: { dimension: string } }; body: unknown };
    });
    expect(call.params.path.dimension).toBe("audience");
    expect(call.body).toEqual({ code: "Zzz", meaning: "Retargeting" });
    await userEvent.click(screen.getAllByTestId("naming-edit-dictionary")[0] as HTMLElement);
    expect(onEdit).toHaveBeenCalledWith("country");
  });

  it("a position can be a date (pattern), free text or ignored; a new granularity is created inline", async () => {
    renderWithQuery(<CampaignNaming ws={WS} dims={dims} canManage canManageRegistry={false} />);
    await waitFor(() => expect(reason("naming-save")).toBe(t("campaignNaming.needDimension")));
    fireEvent.change(screen.getByTestId("naming-part-count"), { target: { value: "3" } });
    const selects = () => screen.getAllByTestId("naming-position-dimension") as HTMLSelectElement[];
    await userEvent.selectOptions(selects()[0] as HTMLSelectElement, "dim:country");
    await userEvent.selectOptions(selects()[1] as HTMLSelectElement, "date");
    await userEvent.selectOptions(screen.getByTestId("naming-position-pattern"), "DDMMYY");
    await userEvent.selectOptions(selects()[2] as HTMLSelectElement, "new");
    expect(reason("naming-new-create")).toBe(t("registry.blocked.role"));
    await userEvent.selectOptions(selects()[2] as HTMLSelectElement, "free_text");
    await userEvent.type(screen.getAllByTestId("naming-position-attribute")[1] as HTMLElement, "audience_note");
    await userEvent.click(screen.getByTestId("naming-save"));
    await waitFor(() => expect(PUT).toHaveBeenCalled());
    expect((PUT.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({
      delimiter: "_",
      tokens: [
        { dimension: "country", aliases: {}, kind: "dimension" },
        { dimension: null, aliases: {}, kind: "date", datePattern: "DDMMYY" },
        { dimension: null, aliases: {}, kind: "free_text", attribute: "audience_note" },
      ],
    });
    cleanup();
    renderWithQuery(<CampaignNaming ws={WS} dims={dims} canManage canManageRegistry />);
    await userEvent.selectOptions((await screen.findAllByTestId("naming-position-dimension"))[0] as HTMLSelectElement, "new");
    await userEvent.type(screen.getByTestId("naming-new-label"), "Match type");
    await userEvent.click(screen.getByTestId("naming-new-create"));
    await waitFor(() => expect(POST.mock.calls.find((c) => c[0] === "/api/v1/workspaces/{ws}/dimensions")?.[1]).toMatchObject({ body: { key: "match_type", label: "Match type", workspaceId: WS } }));
  });

  it("draftInput keeps each position's kind, drops aliases and needs one granularity", () => {
    const tk = { datePattern: "MMDDYY" as const, attribute: "", aliases: { FB: "meta" } };
    expect(draftInput({ delimiter: "-", tokens: [{ ...tk, kind: "ignore", dimension: null }] })).toBeNull();
    expect(draftInput({ delimiter: "-", tokens: [{ ...tk, kind: "dimension", dimension: "platform" }, { ...tk, kind: "date", dimension: null }] })).toEqual({
      delimiter: "-",
      tokens: [
        { dimension: "platform", aliases: {}, kind: "dimension" },
        { dimension: null, aliases: {}, kind: "date", datePattern: "MMDDYY" },
      ],
    });
  });
});
