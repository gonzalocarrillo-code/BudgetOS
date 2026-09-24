import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "./sql.js";
import { withIdentity, withTenant, type TenantContext } from "./tenant.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const contents = readFileSync(path, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv(join(packageRoot, ".env"));

const ownerUrl = process.env["DATABASE_URL"] ?? "postgresql://budget:budget@localhost:5432/budget";
const appUrl =
  process.env["APP_DATABASE_URL"] ??
  "postgresql://budget_app:replace-in-secret-manager@localhost:5432/budget";

const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
const app = new PrismaClient({ datasources: { db: { url: appUrl } } });

const actorId = randomUUID();
const orgA = randomUUID();
const orgB = randomUUID();
// Org A has two workspaces; org B one.
const wsA1 = randomUUID();
const wsA2 = randomUUID();
const wsB1 = randomUUID();
const workspaces = [
  { id: wsA1, org: orgA },
  { id: wsA2, org: orgA },
  { id: wsB1, org: orgB },
];
const envelopes = new Map<string, string>(workspaces.map((w) => [w.id, randomUUID()]));
const versions = new Map(workspaces.map((w) => [w.id, randomUUID()]));
const audits = new Map(workspaces.map((w) => [w.id, randomUUID()]));
const orgDims = new Map<string, string>([
  [orgA, randomUUID()],
  [orgB, randomUUID()],
]);
const wsDims = new Map(workspaces.map((w) => [w.id, randomUUID()]));
const consumer = `rls-org-admin-${randomUUID()}`;
const sources = new Map<string, string>(workspaces.map((w) => [w.id, randomUUID()]));
const users = new Map<string, string>([
  [orgA, randomUUID()],
  [orgB, randomUUID()],
]);
// role_assignment id → workspace id, or `org:<org id>` for an org-wide ORG_ADMIN row.
const assignments = new Map<string, string>();
const allDims = (): string[] => [...orgDims.values(), ...wsDims.values()];
const groups = new Map<string, string>([
  [orgA, randomUUID()],
  [orgB, randomUUID()],
]);
const sub = (userId: string): string => `sub-${userId}`;
// outbox id (bigint, as text) → workspace; filled in beforeAll.
const outboxWorkspace = new Map<string, string>();

function env(ws: string): string {
  return envelopes.get(ws) ?? "";
}

function ctx(over: Partial<TenantContext>): TenantContext {
  return {
    workspaceId: null,
    orgId: null,
    userId: actorId,
    isOrgAdmin: false,
    actorType: "user",
    requestId: "rls-org-admin",
    ...over,
  };
}

interface Visible {
  envelopes: string[];
  versions: string[];
  audits: string[];
  dimensions: string[];
  /** dimension_id of each visible dimension_value. */
  dimensionValues: string[];
  /** workspace of each visible processed_event, through its outbox id. */
  processed: string[];
  /** org_id of each visible metric_definition. */
  metrics: string[];
  /** dimension_id of each visible value_constraint. */
  valueConstraints: string[];
  /** workspace of each visible ingest_run, through its data source. */
  ingestRuns: string[];
  /** workspace (or `org:<id>`) of each visible role_assignment. */
  roles: string[];
  organizations: string[];
  workspaces: string[];
  /** org_id of each visible app_user / app_group. */
  users: string[];
  groups: string[];
  /** org of the group of each visible app_group_member. */
  members: string[];
}

async function visible(tx: Tx): Promise<Visible> {
  const ids = <T extends { id: string }>(rows: T[]): string[] => rows.map((r) => r.id).sort();
  const envelopeIds = [...envelopes.values()];
  return {
    envelopes: ids(
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM envelope WHERE id = ANY(${envelopeIds}::uuid[])`,
    ),
    versions: ids(
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT envelope_id::text AS id FROM envelope_version WHERE envelope_id = ANY(${envelopeIds}::uuid[])`,
    ),
    audits: ids(
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT workspace_id::text AS id FROM audit_event WHERE entity_id = ANY(${[...audits.values()]}::uuid[])`,
    ),
    dimensions: ids(
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM dimension WHERE org_id IN (${orgA}::uuid, ${orgB}::uuid)`,
    ),
    dimensionValues: ids(
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT dimension_id::text AS id FROM dimension_value
        WHERE dimension_id = ANY(${[...orgDims.values(), ...wsDims.values()]}::uuid[])`,
    ),
    processed: (
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT outbox_id::text AS id FROM processed_event WHERE consumer = ${consumer}`
    )
      .map((r) => outboxWorkspace.get(r.id) ?? r.id)
      .sort(),
    metrics: ids(
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT org_id::text AS id FROM metric_definition WHERE org_id IN (${orgA}::uuid, ${orgB}::uuid)`,
    ),
    valueConstraints: ids(
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT dimension_id::text AS id FROM value_constraint WHERE dimension_id = ANY(${allDims()}::uuid[])`,
    ),
    ingestRuns: (
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT source_id::text AS id FROM ingest_run WHERE source_id = ANY(${[...sources.values()]}::uuid[])`
    )
      .map((r) => [...sources].find(([, src]) => src === r.id)?.[0] ?? r.id)
      .sort(),
    roles: (
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM role_assignment WHERE id = ANY(${[...assignments.keys()]}::uuid[])`
    )
      .map((r) => assignments.get(r.id) ?? r.id)
      .sort(),
    organizations: ids(
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM organization WHERE id IN (${orgA}::uuid, ${orgB}::uuid)`,
    ),
    workspaces: ids(
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM workspace WHERE org_id IN (${orgA}::uuid, ${orgB}::uuid)`,
    ),
    users: ids(
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT org_id::text AS id FROM app_user WHERE id = ANY(${[...users.values()]}::uuid[])`,
    ),
    groups: ids(
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT org_id::text AS id FROM app_group WHERE org_id IN (${orgA}::uuid, ${orgB}::uuid)`,
    ),
    members: (
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT group_id::text AS id FROM app_group_member WHERE group_id = ANY(${[...groups.values()]}::uuid[])`
    )
      .map((r) => [...groups].find(([, g]) => g === r.id)?.[0] ?? r.id)
      .sort(),
  };
}

const sorted = (xs: string[]): string[] => [...xs].sort();

beforeAll(async () => {
  await owner.$executeRaw`INSERT INTO organization (id, name) VALUES (${orgA}::uuid, 'rls-org-a'), (${orgB}::uuid, 'rls-org-b')`;
  for (const w of workspaces) {
    await owner.$executeRaw`
      INSERT INTO workspace (id, org_id, slug, name, reporting_currency)
      VALUES (${w.id}::uuid, ${w.org}::uuid, ${`rls-${w.id}`}, 'rls', 'USD')`;
    await owner.$executeRaw`
      INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, created_by, updated_at)
      VALUES (${env(w.id)}::uuid, ${w.id}::uuid, 'rls', '{}'::jsonb, DATE '2026-01-01', DATE '2026-12-31', 'USD', ${actorId}::uuid, now())`;
    await owner.$executeRaw`
      INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, created_by)
      VALUES (${versions.get(w.id)}::uuid, ${env(w.id)}::uuid, 1, 10.00, 10.00, ${actorId}::uuid)`;
    // audit_event is append-only; these rows stay behind, keyed to a workspace that is deleted.
    await owner.$executeRaw`
      INSERT INTO audit_event (workspace_id, actor_type, action, entity_type, entity_id)
      VALUES (${w.id}::uuid, 'system', 'rls.test', 'envelope', ${audits.get(w.id)}::uuid)`;
    await owner.$executeRaw`
      INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by)
      VALUES (${wsDims.get(w.id)}::uuid, ${w.org}::uuid, ${w.id}::uuid, 'rls_ws', 'rls', 'ENUM', ${actorId}::uuid)`;
  }
  for (const [org, id] of orgDims) {
    await owner.$executeRaw`
      INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by)
      VALUES (${id}::uuid, ${org}::uuid, NULL, 'rls_org', 'rls', 'ENUM', ${actorId}::uuid)`;
  }
  for (const dimensionId of [...orgDims.values(), ...wsDims.values()]) {
    await owner.$executeRaw`
      INSERT INTO dimension_value (id, dimension_id, code, label, path)
      VALUES (${randomUUID()}::uuid, ${dimensionId}::uuid, 'v', 'V', 'v')`;
  }
  for (const w of workspaces) {
    const [row] = await owner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO outbox (workspace_id, topic, payload) VALUES (${w.id}::uuid, 'rls.test', '{}'::jsonb)
      RETURNING id::text AS id`;
    const outboxId = row?.id ?? "";
    outboxWorkspace.set(outboxId, w.id);
    await owner.$executeRaw`
      INSERT INTO processed_event (consumer, outbox_id) VALUES (${consumer}, ${outboxId}::bigint)`;
    await owner.$executeRaw`
      INSERT INTO data_source (id, workspace_id, kind, name, config, mapping)
      VALUES (${sources.get(w.id)}::uuid, ${w.id}::uuid, 'csv', 'rls', '{}'::jsonb, '{}'::jsonb)`;
    await owner.$executeRaw`
      INSERT INTO ingest_run (id, source_id) VALUES (${randomUUID()}::uuid, ${sources.get(w.id)}::uuid)`;
  }
  for (const dimensionId of allDims()) {
    await owner.$executeRaw`
      INSERT INTO value_constraint (id, dimension_id, when_dimension_key, when_value_code)
      VALUES (${randomUUID()}::uuid, ${dimensionId}::uuid, 'rls', 'v')`;
  }
  for (const [org, userId] of users) {
    await owner.$executeRaw`
      INSERT INTO metric_definition (id, org_id, key, label, numerator, direction, format)
      VALUES (${randomUUID()}::uuid, ${org}::uuid, 'rls', 'rls', 'spend', 'lower_is_better', 'money')`;
    await owner.$executeRaw`
      INSERT INTO app_user (id, org_id, email, name, google_sub)
      VALUES (${userId}::uuid, ${org}::uuid, ${`${userId}@rls.test`}, 'rls', ${sub(userId)})`;
    await owner.$executeRaw`
      INSERT INTO app_group (id, org_id, google_group, name) VALUES (${groups.get(org)}::uuid, ${org}::uuid, 'rls@rls.test', 'rls')`;
    await owner.$executeRaw`
      INSERT INTO app_group_member (group_id, user_id) VALUES (${groups.get(org)}::uuid, ${userId}::uuid)`;
    const orgWide = randomUUID();
    assignments.set(orgWide, `org:${org}`);
    await owner.$executeRaw`
      INSERT INTO role_assignment (id, workspace_id, principal_type, principal_id, role, created_by)
      VALUES (${orgWide}::uuid, NULL, 'user', ${userId}::uuid, 'ORG_ADMIN', ${actorId}::uuid)`;
    for (const w of workspaces.filter((x) => x.org === org)) {
      const id = randomUUID();
      assignments.set(id, w.id);
      await owner.$executeRaw`
        INSERT INTO role_assignment (id, workspace_id, principal_type, principal_id, role, created_by)
        VALUES (${id}::uuid, ${w.id}::uuid, 'user', ${userId}::uuid, 'VIEWER', ${actorId}::uuid)`;
    }
  }
});

afterAll(async () => {
  const ws = workspaces.map((w) => w.id);
  const orgs = [orgA, orgB];
  await owner.$executeRaw`DELETE FROM envelope_version WHERE envelope_id = ANY(${[...envelopes.values()]}::uuid[])`;
  await owner.$executeRaw`DELETE FROM envelope WHERE workspace_id = ANY(${ws}::uuid[])`;
  await owner.$executeRaw`DELETE FROM role_assignment WHERE principal_id = ANY(${[...users.values()]}::uuid[])`;
  await owner.$executeRaw`DELETE FROM app_user WHERE org_id = ANY(${orgs}::uuid[])`;
  await owner.$executeRaw`DELETE FROM app_group_member WHERE group_id IN (SELECT id FROM app_group WHERE org_id = ANY(${orgs}::uuid[]))`;
  await owner.$executeRaw`DELETE FROM app_group WHERE org_id = ANY(${orgs}::uuid[])`;
  await owner.$executeRaw`DELETE FROM metric_definition WHERE org_id = ANY(${orgs}::uuid[])`;
  await owner.$executeRaw`DELETE FROM value_constraint WHERE dimension_id = ANY(${allDims()}::uuid[])`;
  await owner.$executeRaw`DELETE FROM ingest_run WHERE source_id = ANY(${[...sources.values()]}::uuid[])`;
  await owner.$executeRaw`DELETE FROM data_source WHERE workspace_id = ANY(${ws}::uuid[])`;
  await owner.$executeRaw`DELETE FROM processed_event WHERE consumer = ${consumer}`;
  await owner.$executeRaw`DELETE FROM outbox WHERE workspace_id = ANY(${ws}::uuid[])`;
  await owner.$executeRaw`DELETE FROM dimension_value WHERE dimension_id = ANY(${[...orgDims.values(), ...wsDims.values()]}::uuid[])`;
  await owner.$executeRaw`DELETE FROM dimension WHERE org_id = ANY(${orgs}::uuid[])`;
  await owner.$executeRaw`DELETE FROM workspace WHERE org_id = ANY(${orgs}::uuid[])`;
  await owner.$executeRaw`DELETE FROM organization WHERE id = ANY(${orgs}::uuid[])`;
  await owner.$disconnect();
  await app.$disconnect();
});

describe("org-admin RLS bypass is scoped to the admin's org", () => {
  it("an org admin of org A reads every org A workspace and nothing of org B", async () => {
    const seen = await withTenant(app, ctx({ orgId: orgA, isOrgAdmin: true }), visible);
    expect(seen.envelopes).toEqual(sorted([env(wsA1), env(wsA2)]));
    expect(seen.versions, "child table follows its parent").toEqual(sorted([env(wsA1), env(wsA2)]));
    expect(seen.audits).toEqual(sorted([wsA1, wsA2]));
    expect(seen.dimensions).toEqual(
      sorted([orgDims.get(orgA) ?? "", wsDims.get(wsA1) ?? "", wsDims.get(wsA2) ?? ""]),
    );
    expect(seen.dimensionValues, "values follow their dimension").toEqual(seen.dimensions);
    expect(seen.processed, "processed events follow their outbox row").toEqual(sorted([wsA1, wsA2]));
    expect(seen.metrics).toEqual([orgA]);
    expect(seen.valueConstraints, "constraints follow their dimension").toEqual(seen.dimensions);
    expect(seen.ingestRuns, "ingest runs follow their data source").toEqual(sorted([wsA1, wsA2]));
    expect(seen.roles).toEqual(sorted([wsA1, wsA2, `org:${orgA}`]));
    expect(seen.organizations).toEqual([orgA]);
    expect(seen.workspaces).toEqual(sorted([wsA1, wsA2]));
    expect(seen.users).toEqual([orgA]);
    expect(seen.groups).toEqual([orgA]);
    expect(seen.members, "memberships follow their group").toEqual([orgA]);
  });

  it("an org admin of org A cannot write into org B", async () => {
    const write = withTenant(app, ctx({ orgId: orgA, isOrgAdmin: true }), (tx) =>
      tx.$executeRaw`
        INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, created_by, updated_at)
        VALUES (${randomUUID()}::uuid, ${wsB1}::uuid, 'rls-x', '{}'::jsonb, DATE '2026-01-01', DATE '2026-12-31', 'USD', ${actorId}::uuid, now())`,
    );
    await expect(write).rejects.toThrow(/row-level security/);
    const dim = withTenant(app, ctx({ orgId: orgA, isOrgAdmin: true }), (tx) =>
      tx.$executeRaw`
        INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by)
        VALUES (${randomUUID()}::uuid, ${orgB}::uuid, NULL, 'rls_x', 'rls', 'ENUM', ${actorId}::uuid)`,
    );
    await expect(dim).rejects.toThrow(/row-level security/);
    const value = withTenant(app, ctx({ orgId: orgA, isOrgAdmin: true }), (tx) =>
      tx.$executeRaw`
        INSERT INTO dimension_value (id, dimension_id, code, label, path)
        VALUES (${randomUUID()}::uuid, ${orgDims.get(orgB) ?? ""}::uuid, 'x', 'X', 'x')`,
    );
    await expect(value).rejects.toThrow(/row-level security/);
    const [outboxB] = [...outboxWorkspace].find(([, ws]) => ws === wsB1) ?? [];
    const processed = withTenant(app, ctx({ orgId: orgA, isOrgAdmin: true }), (tx) =>
      tx.$executeRaw`
        INSERT INTO processed_event (consumer, outbox_id) VALUES (${`${consumer}-x`}, ${outboxB ?? ""}::bigint)`,
    );
    await expect(processed).rejects.toThrow(/row-level security/);
    const writes = [
      (tx: Tx) => tx.$executeRaw`
        INSERT INTO metric_definition (id, org_id, key, label, numerator, direction, format)
        VALUES (${randomUUID()}::uuid, ${orgB}::uuid, 'rls_x', 'x', 'spend', 'lower_is_better', 'money')`,
      (tx: Tx) => tx.$executeRaw`
        INSERT INTO value_constraint (id, dimension_id, when_dimension_key, when_value_code)
        VALUES (${randomUUID()}::uuid, ${orgDims.get(orgB) ?? ""}::uuid, 'x', 'x')`,
      (tx: Tx) => tx.$executeRaw`
        INSERT INTO ingest_run (id, source_id) VALUES (${randomUUID()}::uuid, ${sources.get(wsB1) ?? ""}::uuid)`,
      (tx: Tx) => tx.$executeRaw`
        INSERT INTO role_assignment (id, workspace_id, principal_type, principal_id, role, created_by)
        VALUES (${randomUUID()}::uuid, ${wsB1}::uuid, 'user', ${users.get(orgB) ?? ""}::uuid, 'VIEWER', ${actorId}::uuid)`,
      // An org-A workspace, but a principal of org B.
      (tx: Tx) => tx.$executeRaw`
        INSERT INTO role_assignment (id, workspace_id, principal_type, principal_id, role, created_by)
        VALUES (${randomUUID()}::uuid, ${wsA1}::uuid, 'user', ${users.get(orgB) ?? ""}::uuid, 'VIEWER', ${actorId}::uuid)`,
    ];
    writes.push(
      (tx: Tx) => tx.$executeRaw`
        INSERT INTO workspace (id, org_id, slug, name, reporting_currency)
        VALUES (${randomUUID()}::uuid, ${orgB}::uuid, ${`rls-x-${randomUUID()}`}, 'x', 'USD')`,
      (tx: Tx) => tx.$executeRaw`
        INSERT INTO app_user (id, org_id, email, name) VALUES (${randomUUID()}::uuid, ${orgB}::uuid, ${`${randomUUID()}@rls.test`}, 'x')`,
      (tx: Tx) => tx.$executeRaw`
        INSERT INTO app_group (id, org_id, google_group, name) VALUES (${randomUUID()}::uuid, ${orgB}::uuid, 'x@rls.test', 'x')`,
      (tx: Tx) => tx.$executeRaw`
        INSERT INTO app_group_member (group_id, user_id) VALUES (${groups.get(orgB) ?? ""}::uuid, ${users.get(orgA) ?? ""}::uuid)`,
      // An org-A group, but a member of org B.
      (tx: Tx) => tx.$executeRaw`
        INSERT INTO app_group_member (group_id, user_id) VALUES (${groups.get(orgA) ?? ""}::uuid, ${users.get(orgB) ?? ""}::uuid)`,
      // Organizations are provisioned by the owner role, never by budget_app.
      (tx: Tx) => tx.$executeRaw`INSERT INTO organization (id, name) VALUES (${orgA}::uuid, 'x') ON CONFLICT DO NOTHING`,
    );
    for (const write of writes) {
      await expect(withTenant(app, ctx({ orgId: orgA, isOrgAdmin: true }), write)).rejects.toThrow(/row-level security/);
    }
    const updated = await withTenant(app, ctx({ orgId: orgA, isOrgAdmin: true }), async (tx) => [
      await tx.$executeRaw`UPDATE organization SET name = name WHERE id = ${orgB}::uuid`,
      await tx.$executeRaw`UPDATE workspace SET name = name WHERE id = ${wsB1}::uuid`,
      await tx.$executeRaw`UPDATE app_user SET name = name WHERE id = ${users.get(orgB) ?? ""}::uuid`,
      await tx.$executeRaw`UPDATE organization SET name = name WHERE id = ${orgA}::uuid`,
    ]);
    expect(updated, "org B rows are invisible; the admin may rename its own org").toEqual([0, 0, 0, 1]);
  });

  it("a workspace session reads its org's role assignments but writes only its own workspace's", async () => {
    const session = ctx({ orgId: orgA, workspaceId: wsA1 });
    const userA = users.get(orgA) ?? "";
    const otherWorkspace = withTenant(app, session, (tx) =>
      tx.$executeRaw`
        INSERT INTO role_assignment (id, workspace_id, principal_type, principal_id, role, created_by)
        VALUES (${randomUUID()}::uuid, ${wsA2}::uuid, 'user', ${userA}::uuid, 'PLANNER', ${actorId}::uuid)`,
    );
    await expect(otherWorkspace).rejects.toThrow(/row-level security/);
    const orgWide = withTenant(app, session, (tx) =>
      tx.$executeRaw`
        INSERT INTO role_assignment (id, workspace_id, principal_type, principal_id, role, created_by)
        VALUES (${randomUUID()}::uuid, NULL, 'user', ${userA}::uuid, 'ORG_ADMIN', ${actorId}::uuid)`,
    );
    await expect(orgWide).rejects.toThrow(/row-level security/);
    const [a2Row] = [...assignments].find(([, ws]) => ws === wsA2) ?? [];
    const deleted = await withTenant(app, session, (tx) =>
      tx.$executeRaw`DELETE FROM role_assignment WHERE id = ${a2Row ?? ""}::uuid`,
    );
    expect(deleted, "cannot revoke another workspace's grant").toBe(0);
    const own = randomUUID();
    await withTenant(app, session, (tx) =>
      tx.$executeRaw`
        INSERT INTO role_assignment (id, workspace_id, principal_type, principal_id, role, created_by)
        VALUES (${own}::uuid, ${wsA1}::uuid, 'user', ${userA}::uuid, 'PLANNER', ${actorId}::uuid)`,
    );
    const revoked = await withTenant(app, session, (tx) =>
      tx.$executeRaw`DELETE FROM role_assignment WHERE id = ${own}::uuid`,
    );
    expect(revoked).toBe(1);
    const nonAdminMetric = withTenant(app, session, (tx) =>
      tx.$executeRaw`
        INSERT INTO metric_definition (id, org_id, key, label, numerator, direction, format)
        VALUES (${randomUUID()}::uuid, ${orgA}::uuid, 'rls_y', 'y', 'spend', 'lower_is_better', 'money')`,
    );
    await expect(nonAdminMetric, "org-wide rows need the org admin").rejects.toThrow(/row-level security/);
    for (const write of [
      (tx: Tx) => tx.$executeRaw`
        INSERT INTO workspace (id, org_id, slug, name, reporting_currency)
        VALUES (${randomUUID()}::uuid, ${orgA}::uuid, ${`rls-y-${randomUUID()}`}, 'y', 'USD')`,
      (tx: Tx) => tx.$executeRaw`
        INSERT INTO app_user (id, org_id, email, name) VALUES (${randomUUID()}::uuid, ${orgA}::uuid, ${`${randomUUID()}@rls.test`}, 'y')`,
    ]) {
      await expect(withTenant(app, session, write), "workspaces and users need the org admin").rejects.toThrow(
        /row-level security/,
      );
    }
    const bumped = await withTenant(app, session, async (tx) => [
      await tx.$executeRaw`UPDATE workspace SET settings = settings WHERE id = ${wsA1}::uuid`,
      await tx.$executeRaw`UPDATE workspace SET settings = settings WHERE id = ${wsA2}::uuid`,
    ]);
    expect(bumped, "a session updates its own workspace row only (bumpDataVersion)").toEqual([1, 0]);
    const moved = withTenant(app, session, (tx) =>
      tx.$executeRaw`UPDATE workspace SET org_id = ${orgB}::uuid WHERE id = ${wsA1}::uuid`,
    );
    await expect(moved, "cannot move its workspace to another org").rejects.toThrow(/row-level security/);
    // Groups sync runs as a workspace admin, so any session of the org writes app_group.
    const groupId = randomUUID();
    const group = await withTenant(app, session, async (tx) => [
      await tx.$executeRaw`
        INSERT INTO app_group (id, org_id, google_group, name) VALUES (${groupId}::uuid, ${orgA}::uuid, 'y@rls.test', 'y')`,
      await tx.$executeRaw`INSERT INTO app_group_member (group_id, user_id) VALUES (${groupId}::uuid, ${userA}::uuid)`,
      await tx.$executeRaw`UPDATE app_group_member SET synced_at = now() WHERE group_id = ${groupId}::uuid`,
      await tx.$executeRaw`DELETE FROM app_group_member WHERE group_id = ${groupId}::uuid`,
      await tx.$executeRaw`DELETE FROM app_group WHERE id = ${groupId}::uuid`,
    ]);
    expect(group, "groups sync writes groups and memberships").toEqual([1, 1, 1, 1, 1]);
    const foreignRemoval = await withTenant(app, session, (tx) =>
      tx.$executeRaw`DELETE FROM app_group_member WHERE group_id = ${groups.get(orgB) ?? ""}::uuid`,
    );
    expect(foreignRemoval).toBe(0);
  });

  it("the bypass without an org reads nothing (fail closed)", async () => {
    const seen = await withTenant(app, ctx({ isOrgAdmin: true }), visible);
    expect(seen).toEqual({
      envelopes: [],
      versions: [],
      audits: [],
      dimensions: [],
      dimensionValues: [],
      processed: [],
      metrics: [],
      valueConstraints: [],
      ingestRuns: [],
      roles: [],
      organizations: [],
      workspaces: [],
      users: [],
      groups: [],
      members: [],
    });
  });

  it("a workspace session reads its own workspace and its own org's org-wide rows only", async () => {
    const seen = await withTenant(app, ctx({ orgId: orgA, workspaceId: wsA1 }), visible);
    expect(seen.envelopes).toEqual([env(wsA1)]);
    expect(seen.versions).toEqual([env(wsA1)]);
    expect(seen.audits).toEqual([wsA1]);
    expect(seen.dimensions).toEqual(sorted([orgDims.get(orgA) ?? "", wsDims.get(wsA1) ?? ""]));
    expect(seen.dimensionValues).toEqual(seen.dimensions);
    expect(seen.processed).toEqual([wsA1]);
    expect(seen.metrics).toEqual([orgA]);
    expect(seen.valueConstraints).toEqual(seen.dimensions);
    expect(seen.ingestRuns).toEqual([wsA1]);
    // role_assignment is an org identity table: readable across the org (groups sync checks
    // other workspaces' grants), writable only in the session's workspaces.
    expect(seen.roles).toEqual(sorted([wsA1, wsA2, `org:${orgA}`]));
    expect(seen.organizations).toEqual([orgA]);
    expect(seen.workspaces).toEqual(sorted([wsA1, wsA2]));
    expect(seen.users).toEqual([orgA]);
    expect(seen.groups).toEqual([orgA]);
    expect(seen.members).toEqual([orgA]);
  });
});

describe("pre-tenant identity lookup", () => {
  const userIds = (tx: Tx) =>
    tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id FROM app_user WHERE id = ANY(${[...users.values()]}::uuid[])`.then((rows) =>
      rows.map((r) => r.id).sort(),
    );
  const userA = (): string => users.get(orgA) ?? "";
  const userB = (): string => users.get(orgB) ?? "";

  it("sees only the app_user matching the verified sub or email", async () => {
    expect(await withIdentity(app, { subs: [sub(userB())], email: null }, userIds)).toEqual([userB()]);
    expect(await withIdentity(app, { subs: [], email: `${userA()}@rls.test` }, userIds)).toEqual([userA()]);
    expect(await withIdentity(app, { subs: ["no-such-sub"], email: null }, userIds)).toEqual([]);
  });

  it("sees no other identity table", async () => {
    const seen = await withIdentity(app, { subs: [sub(userA())], email: null }, visible);
    expect({ ...seen, users: [] }).toEqual({
      ...seen,
      organizations: [],
      workspaces: [],
      groups: [],
      roles: [],
      envelopes: [],
      members: [],
      users: [],
    });
    expect(seen.users).toEqual([orgA]);
  });
});

// Tables budget_app can reach without RLS. Organization-level and identity tables are read before a
// tenant exists (ADR-005). Adding a table here needs a reason.
const withoutRls = new Map<string, string>([
  ["_prisma_migrations", "migration bookkeeping"],
  ["fx_rate", "global reference data"],
]);

it("every other public table has RLS enabled and forced", async () => {
  const rows = await owner.$queryRaw<Array<{ relname: string }>>`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`;
  expect(rows.map((r) => r.relname).filter((t) => !withoutRls.has(t)).sort()).toEqual([]);
});

// Partitions have no policies of their own; only reads through the parent are filtered (migration
// 20260924080000). A direct query on a partition must be refused, including partitions created later.
it("budget_app holds no privileges on fact or audit partitions, old or new", async () => {
  await owner.$executeRaw`SELECT ensure_fact_partitions('2031-01-01'::date, 0)`;
  const rows = await owner.$queryRaw<Array<{ relname: string }>>`
    SELECT c.relname FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE parent.relname IN ('spend_fact', 'kpi_fact', 'projection_fact', 'audit_event')
      AND (has_table_privilege('budget_app', c.oid, 'SELECT') OR has_table_privilege('budget_app', c.oid, 'INSERT')
           OR has_table_privilege('budget_app', c.oid, 'UPDATE') OR has_table_privilege('budget_app', c.oid, 'DELETE'))`;
  expect(rows.map((r) => r.relname)).toEqual([]);
  const partitions = await owner.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_class WHERE relname = 'spend_fact_203101'`;
  expect(Number(partitions[0]?.n)).toBe(1);
});

// Regression (migration 20260924100000): ingest batches and pacing evaluations call
// ensure_fact_partitions concurrently; re-revoking existing partitions raced on pg_class
// ("tuple concurrently updated").
it("ensure_fact_partitions is safe to call concurrently, for existing and for new months", async () => {
  const call = (from: string, months: number) =>
    app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT ensure_fact_partitions($1::date, $2::int)`, from, months);
    });
  await Promise.all(Array.from({ length: 8 }, () => call("2026-01-01", 11)));
  const month = `20${40 + Math.floor(Math.random() * 50)}-0${1 + Math.floor(Math.random() * 9)}-01`;
  await Promise.all(Array.from({ length: 8 }, () => call(month, 0)));
  const name = `spend_fact_${month.slice(0, 4)}${month.slice(5, 7)}`;
  const created = await owner.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT to_regclass($1) IS NOT NULL AS ok, has_table_privilege('budget_app', $1, 'SELECT') AS readable`, name);
  expect(created[0]).toMatchObject({ ok: true, readable: false });
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS ${name}, kpi_fact_${name.slice(11)}, projection_fact_${name.slice(11)}, audit_event_${name.slice(11)}`);
});
