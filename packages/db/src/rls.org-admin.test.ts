import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "./sql.js";
import { withTenant, type TenantContext } from "./tenant.js";

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
  }
});

afterAll(async () => {
  const ws = workspaces.map((w) => w.id);
  const orgs = [orgA, orgB];
  await owner.$executeRaw`DELETE FROM envelope_version WHERE envelope_id = ANY(${[...envelopes.values()]}::uuid[])`;
  await owner.$executeRaw`DELETE FROM envelope WHERE workspace_id = ANY(${ws}::uuid[])`;
  await owner.$executeRaw`DELETE FROM processed_event WHERE consumer = ${consumer}`;
  await owner.$executeRaw`DELETE FROM outbox WHERE workspace_id = ANY(${ws}::uuid[])`;
  await owner.$executeRaw`DELETE FROM dimension_value WHERE dimension_id = ANY(${[...orgDims.values(), ...wsDims.values()]}::uuid[])`;
  await owner.$executeRaw`DELETE FROM dimension WHERE org_id = ANY(${orgs}::uuid[])`;
  await owner.$executeRaw`DELETE FROM workspace WHERE id = ANY(${ws}::uuid[])`;
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
  });
});

// Tables budget_app can reach without RLS. Organization-level and identity tables are read before a
// tenant exists (ADR-005). Adding a table here needs a reason; the rest are open follow-ups.
const withoutRls = new Map<string, string>([
  ["_prisma_migrations", "migration bookkeeping"],
  ["organization", "tenant root, read before a tenant exists"],
  ["workspace", "tenant root; RLS helpers read it"],
  ["app_user", "identity, read by the auth interceptor before a tenant exists"],
  ["app_group", "identity, read before a tenant exists"],
  ["app_group_member", "identity, read before a tenant exists"],
  ["role_assignment", "read before a tenant exists; follow-up"],
  ["fx_rate", "global reference data"],
  ["metric_definition", "follow-up"],
  ["value_constraint", "follow-up"],
  ["ingest_run", "follow-up"],
]);

it("every other public table has RLS enabled and forced", async () => {
  const rows = await owner.$queryRaw<Array<{ relname: string }>>`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`;
  expect(rows.map((r) => r.relname).filter((t) => !withoutRls.has(t)).sort()).toEqual([]);
});
