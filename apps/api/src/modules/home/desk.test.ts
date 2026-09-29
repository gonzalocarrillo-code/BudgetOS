import { randomUUID } from "node:crypto";
import type { Role } from "@budget/domain";
import { GOLDEN_PENDING_BULK } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";
import type { AuthContext } from "../../common/tenant.js";
import { getHome } from "./home.js";

/**
 * HO-005 (docs/HOME_OVERVIEW_PLAN.md §3.1): Home is each person's desk. What waits on them follows
 * their roles: a budget owner decides the golden bulk and sees the alerts on their budgets, the
 * planner who sent it sees it waiting on others, only those who map facts see unmatched spend, and
 * those who close periods see the quarter about to end.
 */
const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `desk-${randomUUID().slice(0, 8)}`;
const PERSONAS = ["orgAdmin", "admin", "budgetOwner", "approver", "planner", "finance1"] as const;
type Persona = (typeof PERSONAS)[number];
const ROLE: Record<Persona, Role> = { orgAdmin: "ORG_ADMIN", admin: "WORKSPACE_ADMIN", budgetOwner: "BUDGET_OWNER", approver: "APPROVER", planner: "PLANNER", finance1: "FINANCE" };

type Desk = {
  waitingOnMe: {
    approvals: Array<{ id: string; title?: string; count?: number; before?: string | null; after?: string | null; requestedByName?: string | null }>;
    unmatched: number;
    canMap: boolean;
    drafts: { count: number; items: Array<{ envelopeId: string; versionId: string; name: string }> };
    alertsOnMyBudgets: Array<{ envelopeId: string; name: string; ruleName: string | null; severity: string; count: number; assigned: number }>;
    closures: Array<{ periodKey: string; daysLeft: number; drafts: number; pending: number }>;
    failedRuns: unknown[];
  };
  sent: Array<{ id: string; title: string; count: number; waitingOn: string | null }>;
  scopes: Array<{ label: string; envelopeId: string; owner: boolean; alerts: number; pending: number; remaining: string | null }>;
  recents: Array<{ entityType: string; title: string; parent: string | null; action: string }>;
  totals: { openAlerts: number; waiting: number; overdue: number };
};

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, `/api/v1${url}`, token, { headers: { "x-workspace-id": golden.workspaceId, "x-request-id": `ho005-${randomUUID()}` }, ...(body === undefined ? {} : { body }) });
}
const desk = async (persona: Persona) => {
  const res = await as(persona, "GET", "/me/home");
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body as unknown as Desk;
};
/** The persona as the API would see them, to call getHome at a fixed date. */
const authOf = (p: Persona): AuthContext => ({
  ctx: { workspaceId: golden.workspaceId, orgId: golden.orgId, userId: golden.users[p], isOrgAdmin: false, actorType: "user", requestId: `ho005-${randomUUID()}` },
  user: { id: golden.users[p], orgId: golden.orgId, email: `${p.toLowerCase()}@${slug}.golden.test`, name: `Golden ${p}` },
  isOrgAdmin: p === "orgAdmin",
  roles: [ROLE[p]],
  assignments: [{ role: ROLE[p], scope: {} }],
});

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("Home is each person's desk (HO-005)", () => {
  it("what waits on each persona follows their roles", async () => {
    const desks = Object.fromEntries(await Promise.all(PERSONAS.map(async (p) => [p, await desk(p)] as const))) as Record<Persona, Desk>;

    // The budget owner decides the golden bulk: its rationale, how many budgets, the total before and after.
    const bulk = desks.budgetOwner.waitingOnMe.approvals.find((a) => a.title === GOLDEN_PENDING_BULK.rationale);
    expect(bulk, JSON.stringify(desks.budgetOwner.waitingOnMe.approvals)).toBeDefined();
    expect(bulk?.count).toBe(24); // EMEA × amazon: 4 countries × 3 objectives × 2 audiences
    const up = new Decimal(bulk?.after ?? 0).div(bulk?.before ?? 1).minus(1);
    expect(up.toDecimalPlaces(2).toNumber()).toBe(0.05);
    expect(bulk?.requestedByName).toBe("Golden planner");
    // … and, owning every budget through a workspace-wide role, the alerts on them, by budget and rule.
    const groups = desks.budgetOwner.waitingOnMe.alertsOnMyBudgets;
    expect(groups.length).toBeGreaterThan(0);
    expect(new Set(groups.map((g) => g.name))).toEqual(new Set(["EMEA", "LATAM"]));
    expect(groups.every((g) => g.ruleName !== null && g.count > 0 && g.assigned === 0)).toBe(true);

    // The planner who sent it sees it waiting on a budget owner; they own no budget, so no alerts are theirs.
    const sent = desks.planner.sent.find((s) => s.title === GOLDEN_PENDING_BULK.rationale);
    expect(sent).toMatchObject({ count: 24, waitingOn: "BUDGET_OWNER" });
    expect(desks.planner.waitingOnMe.alertsOnMyBudgets).toEqual([]);

    // Unmatched spend and failed runs only for those who can map facts (source.manage).
    for (const p of ["planner", "budgetOwner", "approver", "finance1"] as const) expect(desks[p].waitingOnMe, p).toMatchObject({ unmatched: 0, canMap: false });
    for (const p of ["orgAdmin", "admin"] as const) {
      expect(desks[p].waitingOnMe.canMap, p).toBe(true);
      expect(desks[p].waitingOnMe.unmatched, p).toBeGreaterThan(0); // the golden CSV's unmatched rows
    }
    // Everyone's pulse counts the same queue and the same alerts.
    for (const p of PERSONAS) expect(desks[p].totals, p).toMatchObject({ openAlerts: desks.orgAdmin.totals.openAlerts, waiting: desks.orgAdmin.totals.waiting });
    expect(desks.orgAdmin.totals.waiting).toBeGreaterThanOrEqual(1);

    // Not one page for everyone: the four roles that act differently get four different desks.
    const shape = (d: Desk) => JSON.stringify({ w: d.waitingOnMe, s: d.sent });
    expect(new Set((["planner", "budgetOwner", "orgAdmin", "finance1"] as const).map((p) => shape(desks[p]))).size).toBe(4);
  });

  it("a draft the planner never sent waits on them until they send it", async () => {
    const envelopeId = [...golden.envelopeIds.values()][5] as string;
    const before = (await desk("planner")).waitingOnMe.drafts.count;
    const got = await as("planner", "GET", `/envelopes/${envelopeId}`);
    const basedOn = (got.body["draftVersionId"] ?? got.body["currentVersionId"]) as string;
    const saved = await as("planner", "PATCH", `/envelopes/${envelopeId}/draft`, { amount: "4321.00", basedOnVersionId: basedOn });
    expect([200, 201], JSON.stringify(saved.body)).toContain(saved.status);
    const drafts = (await desk("planner")).waitingOnMe.drafts;
    expect(drafts.count).toBe(before + 1);
    expect(drafts.items[0]).toMatchObject({ envelopeId });
    expect((await desk("budgetOwner")).waitingOnMe.drafts.items.map((d) => d.envelopeId)).not.toContain(envelopeId); // someone else's draft
    const versionId = drafts.items[0]?.versionId as string;
    const submitted = await as("planner", "POST", `/envelopes/${envelopeId}/submit`, { versionId });
    expect([200, 201], JSON.stringify(submitted.body)).toContain(submitted.status);
    expect((await desk("planner")).waitingOnMe.drafts.count).toBe(before);
  });

  it("those who close periods see the quarter about to end, with what is unsettled in it", async () => {
    const q3 = (await getHome(app, authOf("finance1"), new Date("2026-09-29T09:00:00Z"))).waitingOnMe.closures ?? [];
    expect(q3.map((c) => [c.periodKey, c.daysLeft])).toEqual([["2026-Q3", 1]]);
    expect(q3[0]?.pending).toBeGreaterThanOrEqual(24); // the golden bulk waits in it
    // In May nothing ends within two weeks, and Q1 ended more than a month ago.
    expect((await getHome(app, authOf("finance1"), new Date("2026-05-10T09:00:00Z"))).waitingOnMe.closures).toEqual([]);
    // A planner does not close periods.
    expect((await getHome(app, authOf("planner"), new Date("2026-09-29T09:00:00Z"))).waitingOnMe.closures).toEqual([]);
  });

  it("strips say what is open under each top-level budget; recents say what the person did, and where", async () => {
    const d = await desk("budgetOwner");
    const byName = Object.fromEntries(d.scopes.map((s) => [s.label, s]));
    expect(Object.keys(byName).sort()).toEqual(["EMEA", "LATAM"]);
    expect(d.scopes.reduce((n, s) => n + s.alerts, 0)).toBe(d.totals.openAlerts); // every open alert sits under one of them
    // Budgets waiting for approval, under the budget they sit in: the bulk's 24 are all in EMEA.
    expect(d.scopes.reduce((n, s) => n + s.pending, 0)).toBe(await owner.envelope.count({ where: { workspaceId: golden.workspaceId, status: "PENDING" } }));
    expect(byName["EMEA"]?.pending).toBeGreaterThanOrEqual(24);
    expect(d.scopes.every((s) => s.owner === false && s.remaining !== null)).toBe(true);

    const planner = await desk("planner");
    expect(planner.recents.length).toBeGreaterThan(0);
    expect(planner.recents.length).toBeLessThanOrEqual(5);
    expect(planner.recents.every((r) => typeof r.action === "string" && r.action.length > 0)).toBe(true);
    // A budget or a target names where it sits (a top-level budget has no parent).
    expect(planner.recents.some((r) => (r.entityType === "envelope" || r.entityType === "target") && r.parent !== null), JSON.stringify(planner.recents)).toBe(true);
  });
});
