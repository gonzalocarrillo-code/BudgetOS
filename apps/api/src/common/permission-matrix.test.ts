import { randomUUID } from "node:crypto";
import { can, type Role } from "@budget/domain";
import { withTenant } from "@budget/db";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openApiDocument } from "../openapi.js";
import { ISSUER, PROJECT, appDb as appDbClient, ownerDb, startHarness, type Harness, type Method, type MintOptions } from "../test-support/harness.js";
import { AccessRepository } from "./auth/access.repository.js";
import type { RoutePermission } from "./permission.decorator.js";
import { assertInScope, envelopeScopeTarget } from "./scope.guard.js";
import type { AuthContext } from "./tenant.js";

/**
 * T-009 done-when: permission matrix, every role × route, through the real HTTP stack with
 * Identity Platform shaped test JWTs signed by a local JWKS (LOCAL_BUILD_PHASES finding 9).
 * No auth bypass exists; the role × action grid itself is packages/domain/src/permissions.matrix.test.ts.
 */

const owner = ownerDb();
const appDb = appDbClient();

const ROLES: Role[] = ["VIEWER", "PLANNER", "BUDGET_OWNER", "APPROVER", "FINANCE", "DATA_ADMIN", "WORKSPACE_ADMIN", "ORG_ADMIN"];

const orgA = randomUUID();
const orgB = randomUUID();
const wsA = randomUUID();
const wsB = randomUUID(); // same org, only the org admin has access
const wsC = randomUUID(); // other org
interface TestUser {
  id: string;
  email: string;
  sub: string;
}
const mkUser = (label: string): TestUser => {
  const id = randomUUID();
  return { id, email: `${label.toLowerCase()}-${id}@planner.test`, sub: `ip-${id}` };
};
const users = Object.fromEntries(ROLES.map((r) => [r, mkUser(r)])) as Record<Role, TestUser>;
const outsider = mkUser("outsider");
const inactive = mkUser("inactive");
const grouped = mkUser("grouped");
const approver2 = mkUser("approver2");
const scoped = mkUser("scoped");
const orgBAdmin = mkUser("orgb-admin");

let h: Harness;
const kid = "test-key-1";
const mint = (u: { sub: string; email: string }, over: MintOptions = {}) => h.mint(u, over);
const call = (method: Method, url: string, token: string | null, opts: { headers?: Record<string, string>; body?: unknown } = {}) => h.call(method, url, token, opts);

beforeAll(async () => {
  await owner.organization.createMany({ data: [{ id: orgA, name: "t009-a" }, { id: orgB, name: "t009-b" }] });
  await owner.workspace.createMany({
    data: [
      { id: wsA, orgId: orgA, slug: `a-${wsA}`, name: "T-009 A", reportingCurrency: "USD" },
      { id: wsB, orgId: orgA, slug: `b-${wsB}`, name: "T-009 B", reportingCurrency: "USD" },
      { id: wsC, orgId: orgB, slug: `c-${wsC}`, name: "T-009 C", reportingCurrency: "USD" },
    ],
  });
  const orgAUsers = [...Object.values(users), outsider, inactive, grouped, approver2, scoped];
  await owner.user.createMany({
    data: [
      ...orgAUsers.map((u) => ({ id: u.id, orgId: orgA, email: u.email, name: u.email, googleSub: `g-${u.sub}`, isActive: u !== inactive })),
      { id: orgBAdmin.id, orgId: orgB, email: orgBAdmin.email, name: "org b admin", googleSub: `g-${orgBAdmin.sub}` },
    ],
  });
  await owner.roleAssignment.createMany({
    data: [
      ...ROLES.map((role) => ({
        id: randomUUID(),
        workspaceId: role === "ORG_ADMIN" ? null : wsA,
        principalType: "user",
        principalId: users[role].id,
        role,
        createdBy: users.ORG_ADMIN.id,
      })),
      { id: randomUUID(), workspaceId: wsA, principalType: "user", principalId: inactive.id, role: "VIEWER" as const, createdBy: users.ORG_ADMIN.id },
      { id: randomUUID(), workspaceId: wsA, principalType: "user", principalId: approver2.id, role: "APPROVER" as const, createdBy: users.ORG_ADMIN.id },
      { id: randomUUID(), workspaceId: wsC, principalType: "user", principalId: orgBAdmin.id, role: "WORKSPACE_ADMIN" as const, createdBy: orgBAdmin.id },
    ],
  });

  h = await startHarness();
}, 60_000);

afterAll(async () => {
  await h?.close();
  const wss = [wsA, wsB, wsC];
  const orgs = [orgA, orgB];
  await owner.$executeRawUnsafe(`DELETE FROM approval_request WHERE workspace_id = ANY($1::uuid[])`, wss);
  await owner.$executeRawUnsafe(`DELETE FROM envelope_dimension WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = ANY($1::uuid[]))`, wss);
  await owner.$executeRawUnsafe(`DELETE FROM envelope WHERE workspace_id = ANY($1::uuid[])`, wss);
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = ANY($1::uuid[]))`, orgs);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = ANY($1::uuid[])`, orgs);
  await owner.$executeRawUnsafe(`DELETE FROM outbox WHERE workspace_id = ANY($1::uuid[])`, wss);
  await owner.$executeRawUnsafe(`DELETE FROM app_group_member WHERE group_id IN (SELECT id FROM app_group WHERE org_id = ANY($1::uuid[]))`, orgs);
  await owner.$executeRawUnsafe(`DELETE FROM app_group WHERE org_id = ANY($1::uuid[])`, orgs);
  await owner.roleAssignment.deleteMany({ where: { OR: [{ workspaceId: { in: wss } }, { principalId: users.ORG_ADMIN.id }] } });
  await owner.user.deleteMany({ where: { orgId: { in: orgs } } });
  await owner.workspace.deleteMany({ where: { id: { in: wss } } });
  await owner.organization.deleteMany({ where: { id: { in: orgs } } });
  await Promise.all([owner.$disconnect(), appDb.$disconnect()]);
});

// ---------------------------------------------------------------------------------------------
// Route table. Every operation in openapi.json must appear here (checked below).
// ---------------------------------------------------------------------------------------------

interface RouteCase {
  method: Method;
  path: string; // openapi template
  permission: RoutePermission;
  url: () => string;
  headers?: Record<string, string>;
  body?: unknown;
}
const X = () => ({ "x-workspace-id": wsA });
const rid = randomUUID();
const ROUTES: RouteCase[] = [
  { method: "GET", path: "/api/v1/me", permission: "authenticated", url: () => "/api/v1/me" },
  { method: "GET", path: "/api/v1/workspaces/{ws}/dimensions", permission: "workspace.member", url: () => `/api/v1/workspaces/${wsA}/dimensions` },
  { method: "POST", path: "/api/v1/workspaces/{ws}/dimensions", permission: "registry.manage", url: () => `/api/v1/workspaces/${wsA}/dimensions`, body: {} },
  { method: "PATCH", path: "/api/v1/dimensions/{id}", permission: "registry.manage", url: () => `/api/v1/dimensions/${rid}`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/dimensions/{id}/values", permission: "registry.manage", url: () => `/api/v1/dimensions/${rid}/values`, headers: X(), body: {} },
  { method: "PATCH", path: "/api/v1/values/{id}", permission: "registry.manage", url: () => `/api/v1/values/${rid}`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/values/{id}/merge", permission: "registry.manage", url: () => `/api/v1/values/${rid}/merge`, headers: X(), body: {} },
  { method: "GET", path: "/api/v1/workspaces/{ws}/hierarchy-templates", permission: "workspace.member", url: () => `/api/v1/workspaces/${wsA}/hierarchy-templates` },
  { method: "POST", path: "/api/v1/workspaces/{ws}/hierarchy-templates", permission: "registry.manage", url: () => `/api/v1/workspaces/${wsA}/hierarchy-templates`, body: {} },
  { method: "GET", path: "/api/v1/workspaces/{ws}/search", permission: "workspace.member", url: () => `/api/v1/workspaces/${wsA}/search?q=x` },
  { method: "GET", path: "/api/v1/workspaces/{ws}/search/suggest", permission: "workspace.member", url: () => `/api/v1/workspaces/${wsA}/search/suggest?prefix=re` },
  { method: "GET", path: "/api/v1/threads", permission: "thread.comment", url: () => `/api/v1/threads?anchorType=envelope&anchorId=${rid}`, headers: X() },
  { method: "POST", path: "/api/v1/threads", permission: "thread.comment", url: () => `/api/v1/threads`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/threads/{id}/comments", permission: "thread.comment", url: () => `/api/v1/threads/${rid}/comments`, headers: X(), body: {} },
  { method: "PATCH", path: "/api/v1/comments/{id}", permission: "thread.comment", url: () => `/api/v1/comments/${rid}`, headers: X(), body: {} },
  { method: "DELETE", path: "/api/v1/comments/{id}", permission: "thread.comment", url: () => `/api/v1/comments/${rid}`, headers: X() },
  { method: "POST", path: "/api/v1/threads/{id}/resolve", permission: "thread.comment", url: () => `/api/v1/threads/${rid}/resolve`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/threads/{id}/reopen", permission: "thread.comment", url: () => `/api/v1/threads/${rid}/reopen`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/subscriptions", permission: "workspace.member", url: () => `/api/v1/subscriptions`, headers: X(), body: {} },
  { method: "GET", path: "/api/v1/workspaces/{ws}/tags", permission: "workspace.member", url: () => `/api/v1/workspaces/${wsA}/tags` },
  { method: "POST", path: "/api/v1/workspaces/{ws}/tags", permission: "tag.create", url: () => `/api/v1/workspaces/${wsA}/tags`, body: {} },
  { method: "PATCH", path: "/api/v1/tags/{id}", permission: "tag.create", url: () => `/api/v1/tags/${rid}`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/tags/apply", permission: "tag.apply", url: () => `/api/v1/tags/apply`, headers: X(), body: {} },
  { method: "DELETE", path: "/api/v1/tags/apply", permission: "tag.apply", url: () => `/api/v1/tags/apply`, headers: X(), body: {} },
  { method: "GET", path: "/api/v1/workspaces/{ws}/pacing", permission: "envelope.read", url: () => `/api/v1/workspaces/${wsA}/pacing` },
  { method: "GET", path: "/api/v1/workspaces/{ws}/rules", permission: "workspace.member", url: () => `/api/v1/workspaces/${wsA}/rules` },
  { method: "POST", path: "/api/v1/workspaces/{ws}/rules", permission: "rule.manage", url: () => `/api/v1/workspaces/${wsA}/rules`, body: {} },
  { method: "PATCH", path: "/api/v1/rules/{id}", permission: "rule.manage", url: () => `/api/v1/rules/${rid}`, headers: X(), body: {} },
  { method: "GET", path: "/api/v1/alerts", permission: "envelope.read", url: () => `/api/v1/alerts`, headers: X() },
  { method: "PATCH", path: "/api/v1/alerts/{id}", permission: "envelope.edit_draft", url: () => `/api/v1/alerts/${rid}`, headers: X(), body: {} },
  { method: "GET", path: "/api/v1/workspaces/{ws}/sources", permission: "source.manage", url: () => `/api/v1/workspaces/${wsA}/sources` },
  { method: "POST", path: "/api/v1/workspaces/{ws}/sources", permission: "source.manage", url: () => `/api/v1/workspaces/${wsA}/sources`, body: {} },
  { method: "PATCH", path: "/api/v1/sources/{id}", permission: "source.manage", url: () => `/api/v1/sources/${rid}`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/sources/{id}/suggest-mapping", permission: "source.manage", url: () => `/api/v1/sources/${rid}/suggest-mapping`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/sources/{id}/run", permission: "source.manage", url: () => `/api/v1/sources/${rid}/run`, headers: X(), body: {} },
  { method: "GET", path: "/api/v1/sources/{id}/runs", permission: "source.manage", url: () => `/api/v1/sources/${rid}/runs`, headers: X() },
  { method: "GET", path: "/api/v1/workspaces/{ws}/unmatched-spend", permission: "source.manage", url: () => `/api/v1/workspaces/${wsA}/unmatched-spend` },
  { method: "POST", path: "/api/v1/workspaces/{ws}/unmatched-spend/map", permission: "source.manage", url: () => `/api/v1/workspaces/${wsA}/unmatched-spend/map`, body: {} },
  { method: "POST", path: "/api/v1/uploads", permission: "source.manage", url: () => `/api/v1/uploads`, headers: X(), body: {} },
  { method: "GET", path: "/api/v1/workspaces/{ws}/metrics", permission: "workspace.member", url: () => `/api/v1/workspaces/${wsA}/metrics` },
  { method: "POST", path: "/api/v1/workspaces/{ws}/metrics", permission: "registry.manage", url: () => `/api/v1/workspaces/${wsA}/metrics`, body: {} },
  { method: "GET", path: "/api/v1/workspaces/{ws}/targets", permission: "target.read", url: () => `/api/v1/workspaces/${wsA}/targets` },
  { method: "POST", path: "/api/v1/workspaces/{ws}/targets", permission: "target.edit_draft", url: () => `/api/v1/workspaces/${wsA}/targets`, body: {} },
  { method: "PATCH", path: "/api/v1/targets/{id}/draft", permission: "target.edit_draft", url: () => `/api/v1/targets/${rid}/draft`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/targets/{id}/submit", permission: "target.submit", url: () => `/api/v1/targets/${rid}/submit`, headers: X(), body: {} },
  { method: "GET", path: "/api/v1/targets/{id}/versions", permission: "target.read", url: () => `/api/v1/targets/${rid}/versions`, headers: X() },
  { method: "GET", path: "/api/v1/envelopes/{id}/targets", permission: "target.read", url: () => `/api/v1/envelopes/${rid}/targets`, headers: X() },
  { method: "POST", path: "/api/v1/assets", permission: "registry.manage", url: () => "/api/v1/assets", headers: X(), body: {} },
  { method: "GET", path: "/api/v1/workspaces/{ws}/roles", permission: "user.manage", url: () => `/api/v1/workspaces/${wsA}/roles` },
  { method: "POST", path: "/api/v1/workspaces/{ws}/roles", permission: "user.manage", url: () => `/api/v1/workspaces/${wsA}/roles`, body: {} },
  { method: "DELETE", path: "/api/v1/roles/{id}", permission: "user.manage", url: () => `/api/v1/roles/${rid}`, headers: X() },
  { method: "POST", path: "/api/v1/workspaces/{ws}/groups/sync", permission: "user.manage", url: () => `/api/v1/workspaces/${wsA}/groups/sync`, body: {} },
  { method: "POST", path: "/api/v1/workspaces/{ws}/envelopes", permission: "envelope.create", url: () => `/api/v1/workspaces/${wsA}/envelopes`, body: {} },
  { method: "GET", path: "/api/v1/envelopes/{id}", permission: "envelope.read", url: () => `/api/v1/envelopes/${rid}`, headers: X() },
  { method: "PATCH", path: "/api/v1/envelopes/{id}", permission: "envelope.edit_draft", url: () => `/api/v1/envelopes/${rid}`, headers: X(), body: {} },
  { method: "GET", path: "/api/v1/envelopes/{id}/versions", permission: "envelope.read", url: () => `/api/v1/envelopes/${rid}/versions`, headers: X() },
  { method: "GET", path: "/api/v1/envelopes/{id}/timeline", permission: "envelope.read", url: () => `/api/v1/envelopes/${rid}/timeline`, headers: X() },
  { method: "PATCH", path: "/api/v1/envelopes/{id}/draft", permission: "envelope.edit_draft", url: () => `/api/v1/envelopes/${rid}/draft`, headers: X(), body: {} },
  { method: "PATCH", path: "/api/v1/envelopes/{id}/phasing", permission: "envelope.edit_draft", url: () => `/api/v1/envelopes/${rid}/phasing`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/envelopes/{id}/restore/{versionId}", permission: "envelope.edit_draft", url: () => `/api/v1/envelopes/${rid}/restore/${rid}`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/envelopes/{id}/move", permission: "envelope.move", url: () => `/api/v1/envelopes/${rid}/move`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/envelopes/{id}/split", permission: "envelope.move", url: () => `/api/v1/envelopes/${rid}/split`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/envelopes/merge", permission: "envelope.move", url: () => "/api/v1/envelopes/merge", headers: X(), body: {} },
  { method: "POST", path: "/api/v1/envelopes/bulk", permission: "envelope.bulk", url: () => "/api/v1/envelopes/bulk", headers: X(), body: {} },
  { method: "POST", path: "/api/v1/envelopes/bulk/{previewId}/commit", permission: "envelope.bulk", url: () => `/api/v1/envelopes/bulk/${rid}/commit`, headers: X() },
  { method: "POST", path: "/api/v1/workspaces/{ws}/envelopes/csv-export", permission: "export.run", url: () => `/api/v1/workspaces/${wsA}/envelopes/csv-export`, body: {} },
  { method: "POST", path: "/api/v1/workspaces/{ws}/envelopes/csv-import", permission: "envelope.bulk", url: () => `/api/v1/workspaces/${wsA}/envelopes/csv-import`, body: {} },
  { method: "POST", path: "/api/v1/envelopes/{id}/submit", permission: "envelope.submit", url: () => `/api/v1/envelopes/${rid}/submit`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/envelopes/{id}/withdraw", permission: "envelope.submit", url: () => `/api/v1/envelopes/${rid}/withdraw`, headers: X(), body: {} },
  { method: "GET", path: "/api/v1/approvals", permission: "workspace.member", url: () => "/api/v1/approvals?assignee=me", headers: X() },
  { method: "GET", path: "/api/v1/approvals/{id}", permission: "envelope.read", url: () => `/api/v1/approvals/${rid}`, headers: X() },
  { method: "POST", path: "/api/v1/approvals/{id}/decisions", permission: "approval.decide", url: () => `/api/v1/approvals/${rid}/decisions`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/approvals/{id}/external-evidence", permission: "envelope.submit", url: () => `/api/v1/approvals/${rid}/external-evidence`, headers: X(), body: {} },
  { method: "POST", path: "/api/v1/approvals/{id}/withdraw", permission: "envelope.submit", url: () => `/api/v1/approvals/${rid}/withdraw`, headers: X(), body: {} },
  { method: "GET", path: "/api/v1/workspaces/{ws}/policies", permission: "workspace.member", url: () => `/api/v1/workspaces/${wsA}/policies` },
  { method: "POST", path: "/api/v1/workspaces/{ws}/policies", permission: "policy.manage", url: () => `/api/v1/workspaces/${wsA}/policies`, body: {} },
  { method: "PATCH", path: "/api/v1/policies/{id}", permission: "policy.manage", url: () => `/api/v1/policies/${rid}`, headers: X(), body: {} },
];

function allowed(role: Role | "OUTSIDER", permission: RoutePermission): boolean {
  if (permission === "authenticated") return true;
  if (role === "OUTSIDER") return false;
  if (permission === "workspace.member") return true;
  return can([role], permission);
}

describe("permission matrix: every role × route", () => {
  it("covers every operation in openapi.json", () => {
    const paths = openApiDocument()["paths"] as Record<string, Record<string, unknown>>;
    const documented = Object.entries(paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)).sort();
    expect(ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual(documented);
  });

  const cases = ROUTES.flatMap((r) => [...ROLES, "OUTSIDER" as const].map((role) => [role, `${r.method} ${r.path}`, r] as const));
  it.each(cases)("%s %s", async (role, _label, r) => {
    const u = role === "OUTSIDER" ? outsider : users[role];
    const res = await call(r.method, r.url(), await mint(u), { ...(r.headers ? { headers: r.headers } : {}), ...(r.body === undefined ? {} : { body: r.body }) });
    if (allowed(role, r.permission)) {
      // Allowed callers reach validation or the handler: never 401/403, never a crash.
      expect([401, 403]).not.toContain(res.status);
      expect(res.status).toBeLessThan(500);
    } else {
      expect(res.status).toBe(403);
    }
  });
});

describe("token validation (no bypass)", () => {
  const dims = () => `/api/v1/workspaces/${wsA}/dimensions`;
  it("rejects a missing or malformed bearer token with 401", async () => {
    expect((await call("GET", dims(), null)).status).toBe(401);
    expect((await call("GET", dims(), "not.a.jwt")).status).toBe(401);
    const res = await call("GET", dims(), null, { headers: { authorization: "Basic abc" } });
    expect(res.status).toBe(401);
    expect(res.body["code"]).toBe("UNAUTHENTICATED");
  });
  it("rejects a token signed by another key, expired, or for another audience / issuer", async () => {
    const u = users.WORKSPACE_ADMIN;
    for (const token of [
      await mint(u, { key: h.foreignKey }),
      await mint(u, { exp: "-1m" }),
      await mint(u, { aud: "another-project" }),
      await mint(u, { iss: "https://securetoken.google.com/another-project" }),
    ]) {
      expect((await call("GET", dims(), token)).status).toBe(401);
    }
  });
  it("rejects an HS256 token even with a plausible secret", async () => {
    const hs = await new SignJWT({ email: users.ORG_ADMIN.email, email_verified: true })
      .setProtectedHeader({ alg: "HS256", kid })
      .setIssuer(ISSUER)
      .setAudience(PROJECT)
      .setSubject(users.ORG_ADMIN.sub)
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode("a-shared-secret-that-is-long-enough"));
    expect((await call("GET", dims(), hs)).status).toBe(401);
  });
  it("valid token, unknown or inactive user → 403", async () => {
    expect((await call("GET", "/api/v1/me", await mint(mkUser("nobody")))).status).toBe(403);
    expect((await call("GET", dims(), await mint(inactive))).status).toBe(403);
  });
  it("matches a verified email when the subject is unknown, never an unverified one", async () => {
    const viewer = users.VIEWER;
    const other = { sub: `other-${viewer.sub}`, email: viewer.email };
    expect((await call("GET", dims(), await mint(other, { googleSub: "unknown" }))).status).toBe(200);
    expect((await call("GET", dims(), await mint(other, { googleSub: "unknown", emailVerified: false }))).status).toBe(403);
  });
});

describe("workspace resolution and tenancy", () => {
  it("a role in one workspace does not open another", async () => {
    expect((await call("GET", `/api/v1/workspaces/${wsB}/dimensions`, await mint(users.WORKSPACE_ADMIN))).status).toBe(403);
    expect((await call("GET", `/api/v1/workspaces/${wsB}/dimensions`, await mint(users.ORG_ADMIN))).status).toBe(200);
  });
  it("another org's workspace is closed even to an org admin, and vice versa", async () => {
    expect((await call("GET", `/api/v1/workspaces/${wsC}/dimensions`, await mint(users.ORG_ADMIN))).status).toBe(403);
    expect((await call("GET", `/api/v1/workspaces/${wsA}/dimensions`, await mint(orgBAdmin))).status).toBe(403);
    expect((await call("GET", `/api/v1/workspaces/${randomUUID()}/dimensions`, await mint(users.ORG_ADMIN))).status).toBe(403);
  });
  it("X-Workspace-Id must agree with the route and be a uuid", async () => {
    const t = await mint(users.WORKSPACE_ADMIN);
    expect((await call("GET", `/api/v1/workspaces/${wsA}/dimensions`, t, { headers: { "x-workspace-id": wsB } })).status).toBe(422);
    expect((await call("GET", "/api/v1/workspaces/not-a-uuid/dimensions", t)).status).toBe(422);
    expect((await call("DELETE", `/api/v1/roles/${rid}`, t)).status).toBe(422); // no workspace at all
  });
  it("GET /me lists roles and permissions per workspace", async () => {
    const me = await call("GET", "/api/v1/me", await mint(users.PLANNER));
    expect(me.status).toBe(200);
    const workspaces = me.body["workspaces"] as Array<{ workspaceId: string; roles: string[]; permissions: string[] }>;
    expect(workspaces.map((w) => w.workspaceId)).toEqual([wsA]);
    expect(workspaces[0]?.roles).toEqual(["PLANNER"]);
    expect(workspaces[0]?.permissions).toContain("envelope.submit");
    expect(workspaces[0]?.permissions).not.toContain("approval.decide");
    const admin = await call("GET", "/api/v1/me", await mint(users.ORG_ADMIN));
    expect(admin.body["isOrgAdmin"]).toBe(true);
    expect((admin.body["workspaces"] as unknown[]).length).toBe(2);
  });
});

async function auditCount(action: string, requestId: string): Promise<number> {
  const rows = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM audit_event WHERE workspace_id = $1::uuid AND action = $2 AND request_id = $3`,
    wsA,
    action,
    requestId,
  );
  return Number(rows[0]?.n ?? 0);
}
async function outboxCount(): Promise<number> {
  const rows = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'access.changed'`, wsA);
  return Number(rows[0]?.n ?? 0);
}

describe("role assignment", () => {
  it("assign → access, revoke → no access; one audit_event and one outbox row each", async () => {
    const admin = await mint(users.WORKSPACE_ADMIN);
    const dims = `/api/v1/workspaces/${wsA}/dimensions`;
    expect((await call("GET", dims, await mint(outsider))).status).toBe(403);

    const before = await outboxCount();
    const assign = await call("POST", `/api/v1/workspaces/${wsA}/roles`, admin, {
      headers: { "x-request-id": "t009-assign" },
      body: { principalType: "user", principalId: outsider.id, role: "VIEWER" },
    });
    expect(assign.status).toBe(201);
    expect(await auditCount("role.assigned", "t009-assign")).toBe(1);
    expect(await outboxCount()).toBe(before + 1);
    expect((await call("GET", dims, await mint(outsider))).status).toBe(200);

    const dup = await call("POST", `/api/v1/workspaces/${wsA}/roles`, admin, { body: { principalType: "user", principalId: outsider.id, role: "VIEWER" } });
    expect(dup.status).toBe(409);

    const revoke = await call("DELETE", `/api/v1/roles/${String(assign.body["id"])}`, admin, { headers: { "x-workspace-id": wsA, "x-request-id": "t009-revoke" } });
    expect(revoke.status).toBe(200);
    expect(await auditCount("role.revoked", "t009-revoke")).toBe(1);
    expect(await outboxCount()).toBe(before + 2);
    expect((await call("GET", dims, await mint(outsider))).status).toBe(403);
  });

  it("ORG_ADMIN is not assignable per workspace; scopes accept only dimension predicates", async () => {
    const admin = await mint(users.WORKSPACE_ADMIN);
    const url = `/api/v1/workspaces/${wsA}/roles`;
    // 400 from the DTO pipe when decorator metadata is emitted (tsc), 422 from the command's own parse otherwise (vitest/esbuild).
    expect([400, 422]).toContain((await call("POST", url, admin, { body: { principalType: "user", principalId: outsider.id, role: "ORG_ADMIN" } })).status);
    const badScope = { logic: "and", children: [{ field: { kind: "measure", key: "budget" }, op: "gt", value: 1 }] };
    expect([400, 422]).toContain((await call("POST", url, admin, { body: { principalType: "user", principalId: outsider.id, role: "VIEWER", scope: badScope } })).status);
  });

  it("a principal from another org cannot be assigned", async () => {
    const res = await call("POST", `/api/v1/workspaces/${wsA}/roles`, await mint(users.WORKSPACE_ADMIN), {
      body: { principalType: "user", principalId: orgBAdmin.id, role: "VIEWER" },
    });
    expect(res.status).toBe(404);
  });
});

describe("groups sync", () => {
  const googleGroup = `latam-media-leads-${wsA}@planner.test`;
  it("membership through a synced group grants the group's role, and removal revokes it", async () => {
    const admin = await mint(users.WORKSPACE_ADMIN);
    const dims = `/api/v1/workspaces/${wsA}/dimensions`;
    const before = await outboxCount();
    const first = await call("POST", `/api/v1/workspaces/${wsA}/groups/sync`, admin, {
      headers: { "x-request-id": "t009-sync-1" },
      body: { groups: [{ googleGroup, name: "LATAM media leads", members: [grouped.email, "ghost@planner.test"] }] },
    });
    expect(first.status).toBe(201);
    expect(first.body["unknownMembers"]).toEqual(["ghost@planner.test"]);
    expect(await auditCount("groups.synced", "t009-sync-1")).toBe(1);
    expect(await outboxCount()).toBe(before + 1);
    const groupId = String((first.body["groups"] as Array<{ groupId: string }>)[0]?.groupId);

    expect((await call("GET", dims, await mint(grouped))).status).toBe(403); // member, but the group has no role yet
    const assign = await call("POST", `/api/v1/workspaces/${wsA}/roles`, admin, { body: { principalType: "group", principalId: groupId, role: "PLANNER" } });
    expect(assign.status).toBe(201);
    expect((await call("GET", dims, await mint(grouped))).status).toBe(200);
    const me = await call("GET", "/api/v1/me", await mint(grouped));
    expect((me.body["workspaces"] as Array<{ roles: string[] }>)[0]?.roles).toEqual(["PLANNER"]);

    const second = await call("POST", `/api/v1/workspaces/${wsA}/groups/sync`, admin, { body: { groups: [{ googleGroup, name: "LATAM media leads", members: [] }] } });
    expect(second.status).toBe(201);
    expect((second.body["groups"] as Array<{ removed: number }>)[0]?.removed).toBe(1);
    expect((await call("GET", dims, await mint(grouped))).status).toBe(403);
  });

  it("a group that grants roles in another workspace needs an org admin to sync", async () => {
    const shared = `shared-${wsA}@planner.test`;
    const created = await call("POST", `/api/v1/workspaces/${wsA}/groups/sync`, await mint(users.ORG_ADMIN), { body: { groups: [{ googleGroup: shared, name: "Shared", members: [] }] } });
    const groupId = String((created.body["groups"] as Array<{ groupId: string }>)[0]?.groupId);
    await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: wsB, principalType: "group", principalId: groupId, role: "WORKSPACE_ADMIN", createdBy: users.ORG_ADMIN.id } });
    const escalate = { groups: [{ googleGroup: shared, name: "Shared", members: [users.PLANNER.email] }] };
    expect((await call("POST", `/api/v1/workspaces/${wsA}/groups/sync`, await mint(users.WORKSPACE_ADMIN), { body: escalate })).status).toBe(403);
    expect((await call("POST", `/api/v1/workspaces/${wsA}/groups/sync`, await mint(users.ORG_ADMIN), { body: escalate })).status).toBe(201);
  });
});

describe("dimension scopes", () => {
  it("a scoped role is enforced against the envelope's dimension values, via ancestry", async () => {
    const region = randomUUID();
    const [latam, br, emea, de] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await owner.$executeRawUnsafe(
      `INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, 'region', 'Region', 'ENUM', $3::uuid)`,
      region,
      orgA,
      users.ORG_ADMIN.id,
    );
    for (const [id, code, parent] of [[latam, "latam", null], [br, "br", latam], [emea, "emea", null], [de, "de", emea]] as const) {
      await owner.$executeRawUnsafe(
        `INSERT INTO dimension_value (id, dimension_id, code, label, parent_value_id) VALUES ($1::uuid, $2::uuid, $3, $3, $4::uuid)`,
        id,
        region,
        code,
        parent,
      );
    }
    const envelope = async (value: string) => {
      const id = randomUUID();
      await owner.$executeRawUnsafe(
        `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, created_by, updated_at)
         VALUES ($1::uuid, $2::uuid, $1::text, '{}'::jsonb, '2026-01-01', '2026-12-31', 'USD', $3::uuid, now())`,
        id,
        wsA,
        users.ORG_ADMIN.id,
      );
      await owner.$executeRawUnsafe(`INSERT INTO envelope_dimension (envelope_id, dimension_id, value_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`, id, region, value);
      return id;
    };
    const inScope = await envelope(br);
    const outOfScope = await envelope(de);

    const scope = { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "descends_from", value: "latam" }] };
    const assign = await call("POST", `/api/v1/workspaces/${wsA}/roles`, await mint(users.WORKSPACE_ADMIN), {
      body: { principalType: "user", principalId: scoped.id, role: "BUDGET_OWNER", scope },
    });
    expect(assign.status).toBe(201);

    const access = await new AccessRepository(appDb).access({ id: scoped.id, orgId: orgA }, wsA, "t009-scope");
    const auth: AuthContext = {
      ctx: { workspaceId: wsA, orgId: orgA, userId: scoped.id, isOrgAdmin: false, actorType: "user", requestId: "t009-scope" },
      user: { id: scoped.id, orgId: orgA, email: scoped.email, name: scoped.email },
      isOrgAdmin: false,
      roles: ["BUDGET_OWNER"],
      assignments: access.assignments,
    };
    await withTenant(appDb, auth.ctx, async (tx) => {
      const target = await envelopeScopeTarget(tx, inScope);
      expect(target).toEqual({ dims: { region: "br" }, ancestors: { region: ["latam", "br"] } });
      expect(() => assertInScope(auth, "approval.decide", target)).not.toThrow();
      const other = await envelopeScopeTarget(tx, outOfScope);
      expect(() => assertInScope(auth, "approval.decide", other)).toThrowError(/Outside your scope/);
      // Scope never widens the role: BUDGET_OWNER still cannot close periods in scope.
      expect(() => assertInScope(auth, "closure.close", target)).toThrowError(/Outside your scope/);
      await expect(envelopeScopeTarget(tx, randomUUID())).rejects.toThrowError(/not found/);
    });
    // The same envelope id is invisible from another workspace (RLS).
    await withTenant(appDb, { ...auth.ctx, workspaceId: wsB }, async (tx) => {
      await expect(envelopeScopeTarget(tx, inScope)).rejects.toThrowError(/not found/);
    });
  });
});

describe("separation of duties", () => {
  it("eligible_approver(): a requester cannot approve their own request; another approver can", async () => {
    const requestId = randomUUID();
    await owner.$executeRawUnsafe(
      `INSERT INTO approval_request (id, workspace_id, entity_type, entity_id, policy_id, policy_version, policy_snapshot, summary, requested_by)
       VALUES ($1::uuid, $2::uuid, 'envelope_version', $3::uuid, $4::uuid, 1, $5::jsonb, 'sod', $6::uuid)`,
      requestId,
      wsA,
      randomUUID(),
      randomUUID(),
      JSON.stringify({ chain: [{ role: "APPROVER" }], blockSelfApproval: true }),
      users.APPROVER.id,
    );
    const eligible = async (userId: string) =>
      (await owner.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT eligible_approver($1::uuid, $2::uuid) AS ok`, requestId, userId))[0]?.ok;
    expect(await eligible(users.APPROVER.id)).toBe(false);
    expect(await eligible(approver2.id)).toBe(true);
    expect(await eligible(users.FINANCE.id)).toBe(false); // wrong role for the step
  });
});
