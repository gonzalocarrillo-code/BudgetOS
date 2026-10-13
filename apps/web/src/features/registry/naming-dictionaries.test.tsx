import "../../test/dom-polyfills.js";
import { t } from "@budget/ui/i18n";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "../../test/render.js";
import { NamingDictionaries } from "./naming-dictionaries.js";

/**
 * EX-7 (ADR-0093): Registry › Campaign names › Dictionaries. Pick a granularity, search its entries
 * (code, meaning, value, source), add / edit / delete inline, bulk paste (code<TAB>meaning), CSV
 * import and export, reset to built-in, and "Fill dictionary with AI" as a reviewable table where
 * only checked rows are written. Synced entries are read-only with a reason.
 */

const { GET, POST, PATCH, DELETE } = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a), PATCH: (...a: unknown[]) => PATCH(...a), DELETE: (...a: unknown[]) => DELETE(...a) },
  unwrap: vi.fn(async (p: Promise<unknown>) => p),
}));

const WS = "01927a00-0000-7000-8000-0000000000a1";
const E1 = "01927a00-0000-7000-8000-0000000000e1";
const E2 = "01927a00-0000-7000-8000-0000000000e2";
const SYNC = "01927a00-0000-7000-8000-0000000000f1";
const dims = [
  { id: "d1", key: "country", label: "Country" },
  { id: "d2", key: "product", label: "Product" },
  { id: "d5", key: "campaign", label: "Campaign" },
].map((d) => ({ description: null, dataType: "ENUM", color: null, allowedParents: [], isRequiredForLeaf: false, workspaceId: null, isActive: true, icon: "tag", values: [{ id: "v1", code: "gcp", label: "Google Cloud", path: "", parentValueId: null, isActive: true, aliases: [], mergedIntoId: null }], ...d }));

let aiAvailable = false;
const list = () => ({
  dictionaries: [
    { dimension: "country", label: "Country", kind: "country", seeded: true, builtinCount: 1200, syncSourceId: null, position: 13, entries: 1200 },
    { dimension: "product", label: "Product", kind: null, seeded: false, builtinCount: null, syncSourceId: null, position: 4, entries: 2 },
  ],
  aiAvailable,
});
const entry = (over: Record<string, unknown>) => ({ id: E1, code: "GNB", meaning: "Google Nest", value: "gnb", notes: null, source: "user", syncSourceId: null, legacy: false, createdAt: "2026-10-23T00:00:00.000Z", ...over });
let product: Record<string, unknown>;
const country = { dimension: "country", label: "Country", kind: "country", seeded: true, builtinCount: 1200, syncSourceId: null, position: 13, total: 1200, entries: [entry({ id: E2, code: "UK", meaning: "United Kingdom", value: "GB", source: "builtin" })] };
const write = { dimension: "product", written: 1, skipped: 0, removed: 0, createdValues: [], rematch: { spend: 2, kpi: 0, projection: 0, envelopeIds: [] } };

beforeEach(() => {
  aiAvailable = false;
  product = {
    dimension: "product",
    label: "Product",
    kind: null,
    seeded: false,
    builtinCount: null,
    syncSourceId: null,
    position: 4,
    total: 3,
    entries: [entry({}), entry({ id: SYNC, code: "VID", meaning: "Video", value: "video", source: "sync", syncSourceId: E2 }), entry({ id: null, code: "YT", meaning: "youtube", value: "youtube", legacy: true, createdAt: null })],
  };
  for (const m of [GET, POST, PATCH, DELETE]) m.mockReset();
  GET.mockImplementation(async (path: string, opts: { params: { path: { dimension?: string } } }) => {
    if (path === "/api/v1/workspaces/{ws}/naming-dictionaries") return list();
    if (path === "/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}") return opts.params.path.dimension === "country" ? country : product;
    throw new Error(`unmocked GET ${path}`);
  });
  POST.mockImplementation(async (path: string) => {
    if (path === "/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/ai-fill")
      return { dimension: "product", proposals: [{ code: "GCP", meaning: "Google Cloud", value: "gcp", confidence: 0.9 }, { code: "GBR", meaning: "Google Brand", value: null, confidence: 0.3 }], model: "m", codes: 2, examples: 2, applied: false };
    return write;
  });
  PATCH.mockImplementation(async () => write);
  DELETE.mockImplementation(async () => write);
});
afterEach(() => cleanup());

const reason = (el: HTMLElement) => el.closest("[data-disabled-reason]")?.getAttribute("data-disabled-reason") ?? null;
const body = (m: typeof POST, path: string) => (m.mock.calls.find((c) => c[0] === path)?.[1] as { body: unknown } | undefined)?.body;
const render = (dimension = "product", canManage = true) => renderWithQuery(<NamingDictionaries ws={WS} dims={dims} canManage={canManage} dimension={dimension} q="" onDimension={vi.fn()} onQ={vi.fn()} />);

describe("NamingDictionaries (EX-7)", () => {
  it("shows the entries with their source; the campaign is no dictionary; synced and EX-6 entries are read-only with a reason", async () => {
    render();
    const rows = await screen.findAllByTestId("dict-row");
    expect(rows.map((r) => r.getAttribute("data-source"))).toEqual(["user", "sync", "user"]);
    expect(rows[0]?.textContent).toContain("GNB");
    expect(rows[1]?.textContent).toContain(t("namingDict.source.sync"));
    expect([...(screen.getByTestId("dict-picker") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["country", "product"]);
    expect(reason(within(rows[1] as HTMLElement).getByTestId("dict-edit"))).toBe(t("namingDict.syncedReadOnly"));
    expect(reason(within(rows[2] as HTMLElement).getByTestId("dict-delete"))).toBe(t("namingDict.legacyReadOnly"));
    expect(reason(screen.getByTestId("dict-reset"))).toBe(t("namingDict.noBuiltin"));
    expect(reason(screen.getByTestId("dict-ai"))).toBe(t("campaignNaming.aiOff"));
  });

  it("add, edit and delete inline", async () => {
    render();
    await screen.findAllByTestId("dict-row");
    await userEvent.type(screen.getByTestId("dict-add-code"), "GCP");
    await userEvent.type(screen.getByTestId("dict-add-meaning"), "Google Cloud");
    await userEvent.click(screen.getByTestId("dict-add-save"));
    await waitFor(() => expect(body(POST, "/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/entries")).toEqual({ code: "GCP", meaning: "Google Cloud" }));
    const first = (await screen.findAllByTestId("dict-row"))[0] as HTMLElement;
    await userEvent.click(within(first).getByTestId("dict-edit"));
    const meaning = within(first).getByTestId("dict-edit-meaning");
    await userEvent.clear(meaning);
    await userEvent.type(meaning, "Nest");
    await userEvent.click(within(first).getByTestId("dict-edit-save"));
    await waitFor(() => expect(PATCH).toHaveBeenCalled());
    expect(PATCH.mock.calls[0]?.[1]).toMatchObject({ params: { path: { ws: WS, dimension: "product", id: E1 } }, body: { code: "GNB", meaning: "Nest", value: "gnb", notes: null } });
    await userEvent.click(within((await screen.findAllByTestId("dict-row"))[0] as HTMLElement).getByTestId("dict-delete"));
    await waitFor(() => expect(DELETE).toHaveBeenCalled());
    expect(await screen.findByTestId("dict-notice")).toHaveProperty("textContent", t("namingDict.written", { n: 2 }));
  });

  it("bulk paste reads code<TAB>meaning per line and says which lines it could not read", async () => {
    render();
    await screen.findAllByTestId("dict-row");
    await userEvent.click(screen.getByTestId("dict-paste-toggle"));
    fireEvent.change(screen.getByTestId("dict-paste"), { target: { value: "GCP\tGoogle Cloud\nnope\nGBR\tGoogle Brand\tgbr" } });
    expect(screen.getByTestId("dict-paste-summary").textContent).toBe(t("namingDict.pasteSummary", { n: 2, bad: 1, lines: "2" }));
    await userEvent.click(screen.getByTestId("dict-paste-save"));
    await waitFor(() =>
      expect(body(POST, "/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/bulk")).toEqual({
        entries: [
          { code: "GCP", meaning: "Google Cloud" },
          { code: "GBR", meaning: "Google Brand", value: "gbr" },
        ],
        source: "user",
      }),
    );
  });

  it("CSV import writes the file's rows; export downloads every entry", async () => {
    const created: Blob[] = [];
    const url = globalThis.URL as unknown as { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void };
    url.createObjectURL = (b: Blob) => (created.push(b), "blob:x");
    url.revokeObjectURL = () => undefined;
    render();
    await screen.findAllByTestId("dict-row");
    const file = new File(["code,meaning,value\nGCP,Google Cloud,gcp\n"], "product.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByTestId("dict-import"), file);
    await waitFor(() => expect(body(POST, "/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/bulk")).toEqual({ entries: [{ code: "GCP", meaning: "Google Cloud", value: "gcp" }], source: "user" }));
    await userEvent.click(screen.getByTestId("dict-export"));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(GET.mock.calls.some((c) => (c[1] as { params: { query?: { limit?: number } } }).params.query?.limit === 5000)).toBe(true);
    const text = await (created[0] as Blob).text();
    expect(text.split("\n")[0]).toBe("code,meaning,value,notes,source");
    expect(text).toContain("GNB,Google Nest,gnb,,user");
  });

  it("reset to built-in asks to confirm", async () => {
    render("country");
    await screen.findAllByTestId("dict-row");
    expect(screen.getByTestId("dict-info").textContent).toContain(t("campaignNaming.dict.country"));
    await userEvent.click(screen.getByTestId("dict-reset"));
    expect(POST).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("dict-reset-confirm"));
    await waitFor(() => expect(POST.mock.calls.some((c) => c[0] === "/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/reset")).toBe(true));
  });

  it("Fill with AI: a reviewable table; only checked rows are written, as source ai", async () => {
    aiAvailable = true;
    render();
    await screen.findAllByTestId("dict-row");
    await waitFor(() => expect(reason(screen.getByTestId("dict-ai"))).toBeNull());
    await userEvent.click(screen.getByTestId("dict-ai"));
    const rows = await screen.findAllByTestId("dict-ai-row");
    expect(body(POST, "/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/ai-fill")).toEqual({ position: 4 });
    const checks = screen.getAllByTestId("dict-ai-check") as HTMLInputElement[];
    // High confidence starts checked, low confidence does not.
    expect(checks.map((c) => c.checked)).toEqual([true, false]);
    expect(rows).toHaveLength(2);
    expect(POST.mock.calls.some((c) => c[0] === "/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/bulk")).toBe(false);
    await userEvent.click(screen.getByTestId("dict-ai-accept"));
    await waitFor(() => expect(body(POST, "/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/bulk")).toEqual({ entries: [{ code: "GCP", meaning: "Google Cloud", value: "gcp" }], source: "ai" }));
  });

  it("an empty dictionary says what to do; someone who cannot manage sees reasons", async () => {
    product = { ...product, total: 0, entries: [] };
    render("product", false);
    expect(await screen.findByTestId("dict-empty")).toHaveProperty("textContent", t("namingDict.emptyNoBuiltin"));
    expect(reason(screen.getByTestId("dict-add-save"))).toBe(t("campaignNaming.noManage"));
    expect(reason(screen.getByTestId("dict-paste-toggle"))).toBe(t("campaignNaming.noManage"));
  });
});
