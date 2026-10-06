import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { asOrgAdmin } from "@budget/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/**
 * D-004 to D-006 done-when (docs/DATA_PLAN.md §2.3): a second file from the same client maps with no
 * edits (its profile matches the header in any case or order); a profile change reaches the sources
 * that follow it; every mapping saved teaches the workspace's words, and tCPA is known as CPA from
 * the first guess; the preview lists a sample's problems before any run, with the ingest pipeline's
 * own rejections.
 */
const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `map-${randomUUID().slice(0, 8)}`;

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId }, ...(body === undefined ? {} : { body }) });
}
// W0-6: the owner has no BYPASSRLS; every raw owner.* read below (all scoped to the golden
// workspace/org) needs the same org-admin tenant context real writes get from withTenant.
function asOwner<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return asOrgAdmin(owner, fn, golden.orgId);
}

const header = ["Date", "Country", "Platform", "Spend", "Currency", "Conversions", "tCPA"];
const rows = [
  ["2026-03-01", "DE", "Meta", "100.50", "USD", "4", "25.12"],
  ["2026-03-02", "Germny", "Metaa", "80.00", "USD", "2", "40.00"],
  ["2026-03-03", "FR", "google_ads", "12,5", "USD", "1", "12.50"],
];
const mapping = {
  kind: "spend+kpi",
  columns: {
    Date: { role: "period_date", format: "yyyy-MM-dd" },
    Country: { dimension: "country" },
    Platform: { dimension: "platform" },
    Spend: { role: "amount" },
    Currency: { role: "currency" },
    Conversions: { role: "kpi", metric: "conversions" },
    tCPA: { role: "ignore" },
  },
};

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("mapping preview (D-006)", () => {
  it("says what each column becomes, what the registry does not know (and the nearest value), ratios, and what a run would reject", async () => {
    const ws = golden.workspaceId;
    const res = await as("admin", "POST", `/api/v1/workspaces/${ws}/mapping-preview`, { mapping: { ...mapping, columns: { ...mapping.columns, tCPA: { role: "kpi", metric: "tcpa" } } }, header, rows });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const report = res.body as unknown as { rowsChecked: number; rowsRejected: number; problems: string[]; rejects: Array<{ row: number; reason: string }>; columns: Array<{ column: string; mapsTo: string; values?: Array<{ raw: string; code: string | null; suggestion: string | null }>; issues: string[]; notes: string[] }> };
    const col = (c: string) => report.columns.find((x) => x.column === c);
    expect(report.rowsChecked).toBe(3);
    expect(col("Country")?.values).toEqual(expect.arrayContaining([expect.objectContaining({ raw: "DE", code: "DE" }), expect.objectContaining({ raw: "Germny", code: null, suggestion: "DE" })]));
    expect(col("Platform")?.values).toEqual(expect.arrayContaining([expect.objectContaining({ raw: "Meta", code: "meta" }), expect.objectContaining({ raw: "Metaa", code: null, suggestion: "meta" })]));
    expect(col("Country")?.issues.join(" ")).toContain("did you mean DE?");
    // tCPA is this workspace's CPA: a ratio, which a source must not deliver as a count.
    expect(col("tCPA")?.issues.join(" ")).toMatch(/is CPA, a ratio/);
    expect(col("Conversions")?.notes).toEqual([]); // CPA reads kpi:conversions
    // The ingest normalizer's own verdicts: an unknown country, a number with a comma.
    expect(report.rowsRejected).toBe(2);
    expect(report.rejects).toEqual([
      { row: 3, reason: 'unknown country "Germny"' },
      { row: 4, reason: 'Spend "12,5" is not a number' },
    ]);

    // Left out, the ratio is a note, not a problem.
    const ok = (await as("admin", "POST", `/api/v1/workspaces/${ws}/mapping-preview`, { mapping, header, rows: rows.slice(0, 1) })).body as unknown as typeof report;
    expect(ok.rowsRejected).toBe(0);
    expect(ok.columns.find((x) => x.column === "tCPA")?.notes.join(" ")).toMatch(/is CPA, a ratio: BudgetOS works it out/);
    expect(ok.problems).toEqual([]);
  });
});

describe("synonyms (D-005)", () => {
  it("built-in words are there from the first guess; a manual word wins and can be switched off", async () => {
    const ws = golden.workspaceId;
    const list = (await as("admin", "GET", `/api/v1/workspaces/${ws}/mapping-synonyms`)).body as unknown as { columns: Array<{ term: string; target: unknown; origin: string }>; metrics: Array<{ id: string | null; term: string; target: { metric: string }; origin: string; isActive: boolean }> };
    expect(list.columns.find((c) => c.term === "spend")).toMatchObject({ target: { role: "amount" }, origin: "builtin" });
    expect(list.metrics.find((m) => m.term === "tcpa")).toMatchObject({ target: { metric: "cpa" }, origin: "builtin" });

    const made = await as("admin", "POST", `/api/v1/workspaces/${ws}/mapping-synonyms`, { kind: "metric", term: "Coste por conversión", target: { metric: "cpa" } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ term: "costeporconversion", origin: "manual" });
    expect((await as("admin", "POST", `/api/v1/workspaces/${ws}/mapping-synonyms`, { kind: "metric", term: "x", target: { role: "amount" } })).status).toBe(422);
    const off = await as("admin", "PATCH", `/api/v1/mapping-synonyms/${String(made.body["id"])}`, { isActive: false });
    expect(off.body).toMatchObject({ isActive: false });
    const audits = await asOwner((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE workspace_id = $1::uuid AND action LIKE 'mapping_synonym.%'`, ws));
    expect(Number(audits[0]?.n)).toBe(2);
  });
});

describe("mapping profiles (D-004)", () => {
  it("a second file from the same client maps with no edits; a profile change reaches its sources; saved mappings teach words", async () => {
    const ws = golden.workspaceId;
    const created = await as("admin", "POST", `/api/v1/workspaces/${ws}/mapping-profiles`, { name: "Agency weekly export", mapping, header });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const profileId = String(created.body["id"]);
    expect((await as("admin", "POST", `/api/v1/workspaces/${ws}/mapping-profiles`, { name: "Agency weekly export", mapping, header })).status).toBe(409);

    // The next file: same columns, other case and order → exact; with one more column → covers.
    const next = (await as("admin", "POST", `/api/v1/workspaces/${ws}/mapping-profiles/match`, { header: ["tcpa", "CONVERSIONS", "currency", "spend", "platform", "country", "date"] })).body as unknown as { profile: { id: string; mapping: typeof mapping } | null; fit: string | null };
    expect(next).toMatchObject({ fit: "exact", profile: { id: profileId } });
    expect(next.profile?.mapping).toEqual(mapping);
    expect((await as("admin", "POST", `/api/v1/workspaces/${ws}/mapping-profiles/match`, { header: [...header, "Notes"] })).body).toMatchObject({ fit: "covers" });
    expect((await as("admin", "POST", `/api/v1/workspaces/${ws}/mapping-profiles/match`, { header: ["a", "b"] })).body).toEqual({ profile: null, fit: null });

    // A source that follows the profile takes its mapping, and follows a change to it.
    const source = await as("admin", "POST", `/api/v1/workspaces/${ws}/sources`, { name: "Agency CSV", config: { kind: "csv", uri: `gs://budget-os-uploads/uploads/${ws}/agency.csv` }, mapping: { ...mapping, columns: { ...mapping.columns, Conversions: { role: "kpi", metric: "orders" } } }, mappingProfileId: profileId });
    expect(source.status, JSON.stringify(source.body)).toBe(201);
    expect(source.body).toMatchObject({ mappingProfileId: profileId, mapping });
    const remapped = { ...mapping, columns: { ...mapping.columns, Conversions: { role: "kpi", metric: "purchases" } } };
    const updated = await as("admin", "PATCH", `/api/v1/mapping-profiles/${profileId}`, { mapping: remapped });
    expect(updated.body).toMatchObject({ sources: 1 });
    const row = await asOwner((tx) => tx.dataSource.findUniqueOrThrow({ where: { id: String(source.body["id"]) } }));
    expect(row.mapping).toEqual(remapped);
    const actions = (
      await asOwner((tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE workspace_id = $1::uuid AND entity_id = ANY($2::uuid[]) ORDER BY occurred_at`, ws, [profileId, String(source.body["id"])]))
    ).map((a) => a.action);
    expect(actions).toEqual(["mapping_profile.created", "source.created", "source.updated", "mapping_profile.updated"]);

    // Every column mapped was learned (the ratio left out was not).
    const learned = await asOwner((tx) => tx.mappingSynonym.findMany({ where: { workspaceId: ws, origin: "learned" } }));
    // (The golden seed's own source taught its columns too.)
    expect(learned.map((l) => l.term)).toEqual(expect.arrayContaining(["conversions", "country", "currency", "date", "platform", "spend"]));
    expect(learned.map((l) => l.term)).not.toContain("tcpa");
    expect(learned.find((l) => l.term === "conversions")?.target).toEqual({ role: "kpi", metric: "purchases" });

    // Archived, it no longer matches and no source can start following it.
    await as("admin", "PATCH", `/api/v1/mapping-profiles/${profileId}`, { archived: true });
    expect((await as("admin", "POST", `/api/v1/workspaces/${ws}/mapping-profiles/match`, { header })).body).toEqual({ profile: null, fit: null });
    expect((await as("admin", "POST", `/api/v1/workspaces/${ws}/sources`, { name: "Another", config: { kind: "csv", uri: `gs://budget-os-uploads/uploads/${ws}/b.csv` }, mapping, mappingProfileId: profileId })).status).toBe(409);
  });
});
