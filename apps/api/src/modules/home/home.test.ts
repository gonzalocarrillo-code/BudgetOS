import { randomUUID } from "node:crypto";
import { TOP_LEVEL, LIVE_LEAVES } from "@budget/domain";
import { DEFAULT_POLICIES, DEFAULT_RULES, DEFAULT_TOURS, GOLDEN_ASSERTIONS } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden, cleanupWorkspace } from "../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/**
 * T-040 (spec §27, §22): Home, tours and workspace templates on the golden workspace. Done-when:
 * a new workspace from the template (with demo data) is usable in under 60 s — registry, policies,
 * rules, a view, tours, and budgets and actuals in /query — and its demo rows purge in one call.
 * Tours: the caller's role tours until completed at their version; an org admin's edit is a new
 * version everyone sees again. Home: waiting on me first, then pacing per top-level budget.
 */

const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `home-${randomUUID().slice(0, 8)}`;
const created: string[] = [];
type Body = Record<string, unknown>;

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, ws: string | null = golden.workspaceId) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, `/api/v1${url}`, token, { headers: { ...(ws ? { "x-workspace-id": ws } : {}), "x-request-id": `t040-${randomUUID()}` }, ...(body === undefined ? {} : { body }) });
}

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
  for (const ws of created) await cleanupWorkspace(owner, ws);
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("workspace templates (T-040)", () => {
  it("a new workspace from the template, with demo data, is usable in under 60 s (done-when); the demo purges in one call", async () => {
    expect((await as("planner", "GET", "/workspace-templates", undefined, null)).status).toBe(403);
    const templates = await as("orgAdmin", "GET", "/workspace-templates", undefined, null);
    expect(templates.status, JSON.stringify(templates.body).slice(0, 300)).toBe(200);
    const agency = (templates.body as unknown as Array<{ id: string; key: string; counts: Record<string, number> }>).find((t) => t.key === "default_agency");
    // Writing the defaults again changes nothing (jsonb reorders keys; the comparison must not see a change).
    const versions = async () => (await owner.tour.findMany({ where: { workspaceId: null }, select: { role: true, version: true }, orderBy: { role: "asc" } })).map((t) => `${t.role}:${t.version}`);
    const before = await versions();
    await as("orgAdmin", "GET", "/workspace-templates", undefined, null);
    expect(await versions()).toEqual(before);
    expect(agency?.counts).toMatchObject({ policies: DEFAULT_POLICIES.length, rules: DEFAULT_RULES.length, tours: DEFAULT_TOURS.length, savedViews: 1, hierarchyTemplates: 2 });

    const started = Date.now();
    const res = await as("orgAdmin", "POST", "/workspaces", { name: "Acme LATAM", templateId: agency?.id, withDemoData: true }, null);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const ws = String(res.body["id"]);
    created.push(ws);
    expect(res.body).toMatchObject({ slug: "acme-latam", policies: DEFAULT_POLICIES.length, rules: DEFAULT_RULES.length, tours: DEFAULT_TOURS.length, demo: { envelopes: 9, leaves: 6, targets: 3 } });
    const demoBudget = (res.body["demo"] as { budget: string }).budget;

    // Usable: the org admin sees it, its registry and templates are there, the planner answers.
    const me = await as("orgAdmin", "GET", "/me", undefined, null);
    expect((me.body["workspaces"] as Array<{ workspaceId: string }>).map((w) => w.workspaceId)).toContain(ws);
    const templatesThere = await owner.hierarchyTemplate.findMany({ where: { workspaceId: ws }, select: { name: true, isDefault: true } });
    expect(templatesThere.find((t) => t.isDefault)?.name).toBe("Default");
    expect(await owner.approvalPolicy.count({ where: { workspaceId: ws } })).toBe(DEFAULT_POLICIES.length);
    expect(await owner.savedView.count({ where: { workspaceId: ws, visibility: "shared" } })).toBe(1);
    const query = async () => as("orgAdmin", "POST", `/workspaces/${ws}/query`, { workspaceId: ws, period: { kind: "relative", preset: "current_year" }, filter: { logic: "and", children: LIVE_LEAVES }, measures: ["budget", "actual"], limit: 1 }, ws);
    const q = await query();
    expect(q.status, JSON.stringify(q.body).slice(0, 300)).toBe(201);
    expect((q.body["totals"] as Record<string, string>)["budget"]).toBe(demoBudget);
    expect(new Decimal((q.body["totals"] as Record<string, string>)["actual"] ?? 0).gt(0)).toBe(true);
    expect(Date.now() - started).toBeLessThan(60_000);
    const tours = await as("orgAdmin", "GET", "/tours?all=true", undefined, ws);
    expect((tours.body as unknown as Array<{ role: string; isDefault: boolean }>).map((t) => [t.role, t.isDefault]).sort()).toEqual(DEFAULT_TOURS.map((t) => [t.role, false]).sort());
    expect((await as("orgAdmin", "GET", `/workspaces/${ws}/demo-data`, undefined, ws)).body).toEqual({ envelopes: 9, targets: 3 });

    // Purge: one call removes every demo row; the template's configuration stays.
    const purged = await as("orgAdmin", "POST", `/workspaces/${ws}/demo-data/purge`, undefined, ws);
    expect(purged.status, JSON.stringify(purged.body)).toBe(201);
    expect(purged.body).toMatchObject({ envelopes: 9, targets: 3 });
    expect((await as("orgAdmin", "GET", `/workspaces/${ws}/demo-data`, undefined, ws)).body).toEqual({ envelopes: 0, targets: 0 });
    expect(await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = $1::uuid`, ws)).toEqual([{ n: 0n }]);
    expect((await query()).body["totals"]).toMatchObject({ leafCount: "0" });
    expect(await owner.approvalPolicy.count({ where: { workspaceId: ws } })).toBe(DEFAULT_POLICIES.length);
    const audits = await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE entity_type = 'workspace' AND entity_id = $1::uuid ORDER BY occurred_at`, ws);
    expect(audits.map((a) => a.action)).toEqual(["workspace.created", "workspace.demo_seeded", "workspace.demo_purged"]);
    expect((await as("planner", "POST", "/workspaces", { name: "Nope", templateId: agency?.id }, null)).status).toBe(403);
  }, 90_000);
});

describe("tours (T-040)", () => {
  it("the caller's role tours until completed at their version; an org admin's edit shows it again", async () => {
    expect(GOLDEN_ASSERTIONS.tours.roles).toEqual(DEFAULT_TOURS.map((t) => t.role));
    const planner = await as("planner", "GET", "/tours");
    expect(planner.status, JSON.stringify(planner.body).slice(0, 300)).toBe(200);
    const [tour] = planner.body as unknown as Array<{ id: string; role: string; version: number; steps: Array<{ element: string }>; completed: boolean }>;
    expect(tour).toMatchObject({ role: "planner", completed: false });
    expect(tour?.steps.map((s) => s.element)).toEqual(DEFAULT_TOURS.find((t) => t.role === "planner")?.steps.map((s) => s.element));
    expect(((await as("finance1", "GET", "/tours")).body as unknown as Array<{ role: string }>).map((t) => t.role)).toEqual(["finance"]);
    expect(((await as("approver", "GET", "/tours")).body as unknown as Array<{ role: string }>).map((t) => t.role)).toEqual(["approver"]);

    // UX-001: closing early is a skip. It stops the invitation but is not a completion; finishing later is.
    const [fin] = (await as("finance1", "GET", "/tours")).body as unknown as Array<{ id: string; version: number }>;
    const skipped = await as("finance1", "POST", `/tours/${fin?.id ?? ""}/complete`, { version: fin?.version, dismissed: true });
    expect(skipped.body).toMatchObject({ completed: false, dismissed: true });
    expect((await as("finance1", "GET", "/tours")).body).toEqual([]);
    expect(((await as("finance1", "GET", "/tours?all=true")).body as unknown as Array<{ completed: boolean; dismissed: boolean }>)[0]).toMatchObject({ completed: false, dismissed: true });
    await as("finance1", "POST", `/tours/${fin?.id ?? ""}/complete`, { version: fin?.version });
    expect(((await as("finance1", "GET", "/tours?all=true")).body as unknown as Array<{ completed: boolean; dismissed: boolean }>)[0]).toMatchObject({ completed: true, dismissed: false });
    await as("finance1", "POST", `/tours/${fin?.id ?? ""}/complete`, { version: fin?.version, dismissed: true });
    expect(((await as("finance1", "GET", "/tours?all=true")).body as unknown as Array<{ completed: boolean }>)[0]?.completed).toBe(true);

    const done = await as("planner", "POST", `/tours/${tour?.id ?? ""}/complete`, { version: tour?.version });
    expect(done.body).toMatchObject({ completed: true });
    expect((await as("planner", "GET", "/tours")).body).toEqual([]);
    expect(((await as("planner", "GET", "/tours?all=true")).body as unknown as Array<{ completed: boolean }>)[0]?.completed).toBe(true);

    expect((await as("planner", "PATCH", `/tours/${tour?.id ?? ""}`, { name: "Mine" })).status).toBe(403);
    const edited = await as("orgAdmin", "PATCH", `/tours/${tour?.id ?? ""}`, { steps: [{ path: "/budgets", element: '[data-tour="filter-bar"]', title: "Filters first", description: "Our agency starts every review with the filter bar." }] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ role: "planner", isDefault: false, version: (tour?.version ?? 1) + 1 });
    const again = (await as("planner", "GET", "/tours")).body as unknown as Array<{ id: string; steps: Array<{ title: string }> }>;
    expect(again.map((t) => t.steps[0]?.title)).toEqual(["Filters first"]);
    expect(again[0]?.id).not.toBe(tour?.id); // the workspace's own copy
  });
});

describe("home (T-040)", () => {
  it("waiting on me first, then pacing per top-level budget (the planner's totals), recents and views", async () => {
    const res = await as("budgetOwner", "GET", "/me/home");
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
    const home = res.body as { waitingOnMe: { approvals: unknown[]; mentions: Array<{ body: string; author: string | null }>; alerts: unknown[]; unmatched: number }; scopes: Array<{ label: string; filter: unknown; budget: string }>; recents: unknown[]; pinnedViews: Array<{ name: string }> };
    expect(Object.keys(res.body)).toEqual(["waitingOnMe", "scopes", "recents", "pinnedViews", "workspace", "asOf", "totals", "setup"]);
    // The header: the workspace, its fiscal year so far, and the year's totals over what the caller reads.
    expect(res.body["workspace"]).toMatchObject({ name: "Golden", currency: "USD" });
    expect((res.body["setup"] as { budgets: number }).budgets).toBeGreaterThan(0);
    expect((res.body["totals"] as { budget: string | null }).budget).not.toBeNull();
    expect(home.waitingOnMe.unmatched).toBeGreaterThan(0); // the golden CSV's unmatched US rows
    expect(home.scopes.length).toBeGreaterThan(0);
    // UX-008 (ADR-051): a strip is its top-level budget's own row in Budgets' budget structure, and
    // the header total is Budgets' total, not the sum of the leaves.
    const first = home.scopes[0] as { envelopeId?: string; budget: string } | undefined;
    const structure = await as("budgetOwner", "POST", `/workspaces/${golden.workspaceId}/query`, { workspaceId: golden.workspaceId, period: { kind: "relative", preset: "current_year" }, filter: { logic: "and", children: TOP_LEVEL }, subtree: true, measures: ["budget", "actual"], limit: 100 });
    const rows = structure.body["rows"] as Array<{ envelopeId: string; measures: Record<string, string> }>;
    expect(first?.budget).toBe(rows.find((r) => r.envelopeId === first?.envelopeId)?.measures["budget"]);
    expect((res.body["totals"] as { budget: string }).budget).toBe((structure.body["totals"] as Record<string, string>)["budget"]);

    // A mention in an open thread is waiting on the person mentioned (golden's only mention is in a resolved thread).
    const envelopeId = [...golden.envelopeIds.values()][0] as string;
    const thread = await as("planner", "POST", "/threads", { anchorType: "envelope", anchorId: envelopeId, title: "Q4 check", firstComment: { bodyMd: `@[user:${golden.users.budgetOwner}] can you confirm the Q4 split?` } });
    expect(thread.status, JSON.stringify(thread.body)).toBe(201);
    const mentioned = (await as("budgetOwner", "GET", "/me/home")).body as typeof home;
    expect(mentioned.waitingOnMe.mentions.map((m) => [m.body, m.author])).toContainEqual(["@[user:" + golden.users.budgetOwner + "] can you confirm the Q4 split?", `Golden planner`]);
    // The approver's approvals are the ones they can decide now (the same rows as the inbox's "mine").
    const approver = (await as("approver", "GET", "/me/home")).body as Body & { waitingOnMe: { approvals: Array<{ id: string }> } };
    const inbox = (await as("approver", "GET", "/approvals?assignee=me&limit=10")).body as { rows: Array<{ id: string }> };
    expect(approver.waitingOnMe.approvals.map((a) => a.id)).toEqual(inbox.rows.map((r) => r.id));
    const planner = (await as("planner", "GET", "/me/home")).body as typeof home;
    expect(planner.recents.length).toBeGreaterThan(0);
    expect(planner.pinnedViews.map((v) => v.name).length).toBeGreaterThanOrEqual(0);
  });

  it("a workspace with no budgets says so: no totals, and what is set up (feedback 2026-09-28)", async () => {
    const templates = (await as("orgAdmin", "GET", "/workspace-templates", undefined, null)).body as unknown as Array<{ id: string; key: string }>;
    const res = await as("orgAdmin", "POST", "/workspaces", { name: "Blank", templateId: templates.find((t) => t.key === "default_agency")?.id, withDemoData: false }, null);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const ws = String(res.body["id"]);
    created.push(ws);
    const home = await as("orgAdmin", "GET", "/me/home", undefined, ws);
    expect(home.status, JSON.stringify(home.body).slice(0, 300)).toBe(200);
    expect(home.body["totals"]).toBeNull();
    expect(home.body["setup"]).toMatchObject({ budgets: 0, sources: 0, spend: false });
    expect(home.body["workspace"]).toMatchObject({ name: "Blank" });
  });

  it("Settings › Workspace: what identifies it, and an admin renames it (audited)", async () => {
    const got = await as("planner", "GET", `/workspaces/${golden.workspaceId}/general`);
    expect(got.body).toMatchObject({ name: "Golden", reportingCurrency: "USD", fiscalYearStartMonth: 1 });
    expect((await as("planner", "PATCH", `/workspaces/${golden.workspaceId}/general`, { name: "Nope" })).status).toBe(403);
    const renamed = await as("admin", "PATCH", `/workspaces/${golden.workspaceId}/general`, { name: "Golden Co" });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Golden Co" });
    const [a] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'workspace.renamed'`, golden.workspaceId);
    expect(Number(a?.n)).toBe(1);
    await as("admin", "PATCH", `/workspaces/${golden.workspaceId}/general`, { name: "Golden" });
  });

  it("a person renames themselves: only their name, audited (feedback 2026-09-28)", async () => {
    const bad = await as("planner", "PATCH", "/me", { name: "  " });
    expect(bad.status).toBe(422);
    const ok = await as("planner", "PATCH", "/me", { name: "Maya Chen" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ id: golden.users.planner, name: "Maya Chen" });
    const me = await as("planner", "GET", "/me", undefined, null);
    expect((me.body["user"] as { name: string }).name).toBe("Maya Chen");
    const row = await owner.user.findUniqueOrThrow({ where: { id: golden.users.planner }, select: { name: true, email: true } });
    expect(row).toMatchObject({ name: "Maya Chen", email: `planner@${slug}.golden.test` });
    const [audited] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'user.renamed'`, golden.users.planner);
    expect(Number(audited?.n)).toBe(1);
    const [evented] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE topic = 'user.updated' AND payload->>'userId' = $1`, golden.users.planner);
    expect(Number(evented?.n)).toBe(1);
    await owner.user.update({ where: { id: golden.users.planner }, data: { name: "Golden planner" } });
  });
});
