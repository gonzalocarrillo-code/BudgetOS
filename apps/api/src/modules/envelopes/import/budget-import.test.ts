import { randomUUID } from "node:crypto";
import { goldenPlan } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../../seed/golden.js";
import { cleanupGolden } from "../../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../../test-support/harness.js";

/**
 * D-007 / D-008 done-when (docs/DATA_PLAN.md §3): the template comes from the workspace's registry;
 * a 50-line file creates a whole new tree (48 budgets and the 35 parents the hierarchy implies) and
 * changes two budgets, as drafts under one approval; the same file again changes nothing. Problems
 * are per line with the nearest value; a parent the import would push over budget blocks Commit.
 */
const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `imp-${randomUUID().slice(0, 8)}`;
const plan = goldenPlan();

async function as(persona: string, method: "GET" | "POST", url: string, body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId }, ...(body === undefined ? {} : { body }) });
}
const csvOf = (rows: string[][]) => rows.map((r) => r.join(",")).join("\n");
type Preview = { previewId: string; counts: Record<string, number>; totals: { new: string; change: string }; blocked: string | null; lines: Array<{ line: number; status: string; problems: Array<{ column: string | null; message: string; suggestion?: string | null }> }>; parents: Array<{ name: string; amount: string }>; overCap: Array<{ name: string }>; unknownColumns: string[] };

let templateId: string;
beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
  templateId = (await owner.hierarchyTemplate.findFirstOrThrow({ where: { workspaceId: golden.workspaceId, name: "Region first" } })).id;
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

const HEADER = ["key", "region", "country", "platform", "objective", "audience", "currency", "amount", "start_date", "end_date", "envelope_id"];
function amerFile(changeIds: Array<{ id: string; amount: string }>): string {
  const rows: string[][] = [HEADER];
  for (const country of ["US", "CA"]) for (const platform of ["meta", "google_ads", "tiktok", "amazon"]) for (const objective of ["awareness", "consideration", "conversion"]) for (const audience of ["prospecting", "retargeting"]) {
    rows.push(["", "AMER", country, platform, objective, audience, "USD", "1000.00", "2027-01-01", "2027-12-31", ""]);
  }
  for (const c of changeIds) rows.push(["", "", "", "", "", "", "USD", c.amount, "2026-01-01", "2026-12-31", c.id]);
  return csvOf(rows);
}

describe("budget import (D-007, D-008)", () => {
  it("the template is this workspace's: granularities by the hierarchy, the fiscal months, live budgets as examples", async () => {
    const res = await as("admin", "GET", `/api/v1/workspaces/${golden.workspaceId}/budget-import/template?templateId=${templateId}`);
    expect(res.status).toBe(200);
    const [header, help, example] = res.text.trim().split("\r\n");
    const cols = header?.split(",") ?? [];
    expect(cols.slice(0, 7)).toEqual(["key", "parent_key", "region", "country", "platform", "objective", "audience"]);
    for (const c of ["name", "currency", "amount", "start_date", "end_date", "envelope_id", "rationale"]) expect(cols).toContain(c);
    expect(cols.filter((c) => /^\d{4}-\d{2}$/.test(c))).toHaveLength(12);
    expect(help?.startsWith('"# One row per budget')).toBe(true);
    expect(example).toMatch(/[0-9a-f-]{36},$/); // an example keeps its envelope_id, so re-importing it changes nothing
  });

  it("50 lines: a new region's whole tree and two changes, as drafts under one approval; the same file again changes nothing", async () => {
    const ws = golden.workspaceId;
    const leaves = plan.filter((e) => e.level === 4).slice(0, 2);
    const changeIds = leaves.map((l) => ({ id: golden.envelopeIds.get(l.key) as string, amount: new Decimal(l.versions.at(-1)?.amount as string).minus(10).toFixed(2) }));
    const file = amerFile(changeIds);

    const preview = (await as("admin", "POST", `/api/v1/workspaces/${ws}/budget-import/preview`, { csv: file, templateId })).body as unknown as Preview;
    expect(preview.counts).toEqual({ new: 48, change: 2, same: 0, error: 0, parents: 1 + 2 + 8 + 24 });
    expect(preview.totals).toEqual({ new: "48000.00", change: "-20.00" });
    expect(preview.blocked).toBeNull();
    expect(preview.parents.find((p) => p.name === "AMER")?.amount).toBe("48000.00");
    expect(preview.parents.find((p) => p.name === "AMER US meta")?.amount).toBe("6000.00");
    const before = await owner.envelope.count({ where: { workspaceId: ws } });

    const commit = await as("admin", "POST", `/api/v1/workspaces/${ws}/budget-import/commit`, { previewId: preview.previewId, rationale: "FY2027 AMER plan" });
    expect(commit.status, JSON.stringify(commit.body)).toBe(201);
    const done = commit.body as { requestId: string | null; autoApproved: boolean; created: number; parents: number; changed: number };
    expect(done).toMatchObject({ created: 48, parents: 35, changed: 2 });
    if (!done.autoApproved) expect((await as("admin", "POST", `/api/v1/approvals/${done.requestId}/decisions`, { decision: "approve" })).status).toBe(201);
    expect(await owner.envelope.count({ where: { workspaceId: ws } })).toBe(before + 83);
    const amer = await owner.envelope.findFirstOrThrow({ where: { workspaceId: ws, name: "AMER", parentId: null } });
    expect(amer.status).toBe("APPROVED");
    const amerVersion = await owner.envelopeVersion.findUniqueOrThrow({ where: { id: amer.currentVersionId as string } });
    expect(amerVersion.amount.toFixed(2)).toBe("48000.00");
    const leaf = await owner.envelope.findFirstOrThrow({ where: { workspaceId: ws, dimensionValues: { equals: { region: "AMER", country: "US", platform: "meta", objective: "awareness", audience: "prospecting" } } } });
    const parent = await owner.envelope.findUniqueOrThrow({ where: { id: leaf.parentId as string } });
    expect(parent.dimensionValues).toEqual({ region: "AMER", country: "US", platform: "meta", objective: "awareness" });
    for (const c of changeIds) {
      const e = await owner.envelope.findUniqueOrThrow({ where: { id: c.id } });
      expect((await owner.envelopeVersion.findUniqueOrThrow({ where: { id: e.currentVersionId as string } })).amount.toFixed(2)).toBe(c.amount);
    }
    const audits = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE workspace_id = $1::uuid AND action = 'budgets.imported'`, ws);
    const out = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'budget.changed' AND payload->>'kind' = 'import'`, ws);
    expect([Number(audits[0]?.n), Number(out[0]?.n)]).toEqual([1, 1]);

    // The same file again: every line is the budget as it is now.
    const again = (await as("admin", "POST", `/api/v1/workspaces/${ws}/budget-import/preview`, { csv: file, templateId })).body as unknown as Preview;
    expect(again.counts).toEqual({ new: 0, change: 0, same: 50, error: 0, parents: 0 });
    expect(again.blocked).toMatch(/Nothing to change/);
    expect((await as("admin", "POST", `/api/v1/workspaces/${ws}/budget-import/commit`, { previewId: again.previewId, rationale: "again" })).status).toBe(409);
  });

  it("problems are per line with the nearest value; a parent pushed over its budget blocks Commit", async () => {
    const ws = golden.workspaceId;
    const file = csvOf([
      [...HEADER, "Notes", "2026-01", "2026-02"],
      ["", "EMEA", "Germny", "meta", "awareness", "prospecting", "USD", "10.00", "2026-01-01", "2026-12-31", "", "x", "", ""],
      ["", "EMEA", "DE", "meta", "awareness", "lookalike", "USD", "999999.00", "2026-01-01", "2026-12-31", "", "", "", ""],
      ["", "EMEA", "DE", "meta", "awareness", "lookalike", "USD", '"12,5"', "2026-01-01", "2025-12-31", "", "", "", ""],
      ["", "EMEA", "FR", "meta", "awareness", "lookalike", "USD", "30.00", "2026-01-01", "2026-12-31", "", "", "10.00", "10.00"],
    ]);
    const p = (await as("admin", "POST", `/api/v1/workspaces/${ws}/budget-import/preview`, { csv: file, templateId })).body as unknown as Preview;
    expect(p.unknownColumns).toEqual(["Notes"]);
    const line = (n: number) => p.lines.find((l) => l.line === n);
    expect(line(2)?.problems[0]).toMatchObject({ column: "country", suggestion: "DE" });
    expect(line(4)?.problems.map((x) => x.column)).toEqual(expect.arrayContaining(["amount", "end_date"]));
    expect(line(5)?.problems.map((x) => x.message).join(" ")).toMatch(/Phasing must sum to amount/);
    expect(p.lines.map((l) => l.status)).toEqual(["error", "new", "error", "error"]);
    // The lookalike row hangs under the existing DE meta awareness budget and does not fit in it.
    expect(p.overCap.map((o) => o.name)).toEqual(["EMEA DE meta awareness"]);
    expect(p.blocked).toMatch(/3 lines have a problem/);
  });
});
