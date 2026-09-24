import { randomUUID } from "node:crypto";
import { owner } from "./db.js";

/**
 * SQL fixtures for the planner suite (LOCAL_BUILD_PHASES phase 4).
 * This is the only place outside packages/db/seed that inserts envelope versions directly:
 * the golden seed, which goes through commands, arrives with T-006.
 */

export interface FixtureOrg {
  orgId: string;
  users: { u1: string; u2: string };
  dims: { geo: string; platform: string };
  values: Record<string, { id: string; dimensionId: string }>;
}

export interface VersionSpec {
  amount: string;
  status: "DRAFT" | "PENDING" | "APPROVED" | "SUPERSEDED";
  approvedAt?: string;
}

export interface EnvelopeSpec {
  name: string;
  geo?: string | null;
  platform?: string | null;
  status: "DRAFT" | "PENDING" | "APPROVED";
  ownerId?: string | null;
  start: string;
  end: string;
  currency?: string;
  createdAt?: string;
  versions?: VersionSpec[];
  spend?: Array<{ date: string; amount: string }>;
  kpi?: Array<{ date: string; metric: string; value: string }>;
  projections?: Array<{ date: string; value: string; runId: string; loadedAt: string }>;
}

export interface InsertedEnvelope {
  id: string;
  versionIds: string[];
}

const GEO: Array<{ code: string; label: string; parent: string | null }> = [
  { code: "latam", label: "LATAM", parent: null },
  { code: "br", label: "Brazil", parent: "latam" },
  { code: "br_sp", label: "São Paulo", parent: "br" },
  { code: "mx", label: "Mexico", parent: "latam" },
  { code: "emea", label: "EMEA", parent: null },
  { code: "de", label: "Germany", parent: "emea" },
];
const PLATFORM: Array<{ code: string; label: string }> = [
  { code: "meta", label: "Meta" },
  { code: "google", label: "Google" },
  { code: "tiktok", label: "TikTok" },
];

export async function createOrg(): Promise<FixtureOrg> {
  const orgId = randomUUID();
  const u1 = randomUUID();
  const u2 = randomUUID();
  await owner.query(`INSERT INTO organization (id, name) VALUES ($1, 'planner-fixture')`, [orgId]);
  for (const u of [u1, u2]) {
    await owner.query(
      `INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Planner Fixture')`,
      [u, orgId, `${u}@planner.test`],
    );
  }
  const geo = randomUUID();
  const platform = randomUUID();
  await owner.query(
    `INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by)
     VALUES ($1, $3, NULL, 'geo', 'Geo', 'ENUM', $4), ($2, $3, NULL, 'platform', 'Platform', 'ENUM', $4)`,
    [geo, platform, orgId, u1],
  );
  const values: FixtureOrg["values"] = {};
  for (const v of GEO) {
    const id = randomUUID();
    const parentId = v.parent === null ? null : values[v.parent]?.id;
    await owner.query(
      `INSERT INTO dimension_value (id, dimension_id, code, label, parent_value_id) VALUES ($1, $2, $3, $4, $5)`,
      [id, geo, v.code, v.label, parentId ?? null],
    );
    values[v.code] = { id, dimensionId: geo };
  }
  for (const v of PLATFORM) {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1, $2, $3, $4)`,
      [id, platform, v.code, v.label],
    );
    values[v.code] = { id, dimensionId: platform };
  }
  await owner.query(
    `INSERT INTO metric_definition (id, org_id, key, label, numerator, denominator, direction, format)
     VALUES ($1, $2, 'cpa', 'CPA', 'spend', 'kpi:conversions', 'lower_is_better', 'currency')`,
    [randomUUID(), orgId],
  );
  // Months used by the fixtures; the migration only creates partitions from current_date.
  await owner.query(`SELECT ensure_fact_partitions('2025-01-01'::date, 15)`);
  return { orgId, users: { u1, u2 }, dims: { geo, platform }, values };
}

export async function createWorkspace(org: FixtureOrg): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO workspace (id, org_id, slug, name, reporting_currency) VALUES ($1, $2, $3, 'Planner fixture', 'USD')`,
    [id, org.orgId, `planner-${id}`],
  );
  return id;
}

export async function insertEnvelope(
  org: FixtureOrg,
  workspaceId: string,
  spec: EnvelopeSpec,
): Promise<InsertedEnvelope> {
  const id = randomUUID();
  const dims: Record<string, string> = {};
  if (spec.geo) dims["geo"] = spec.geo;
  if (spec.platform) dims["platform"] = spec.platform;
  await owner.query(
    `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, owner_id, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::"EnvelopeStatus", $9, $10, $11, $11)`,
    [
      id,
      workspaceId,
      spec.name,
      JSON.stringify(dims),
      spec.start,
      spec.end,
      spec.currency ?? "USD",
      spec.status,
      spec.ownerId ?? null,
      org.users.u1,
      spec.createdAt ?? "2026-01-02T00:00:00Z",
    ],
  );
  for (const code of Object.values(dims)) {
    const value = org.values[code];
    if (!value) throw new Error(`fixture value ${code} missing`);
    await owner.query(
      `INSERT INTO envelope_dimension (envelope_id, dimension_id, value_id) VALUES ($1, $2, $3)`,
      [id, value.dimensionId, value.id],
    );
  }
  const versionIds: string[] = [];
  let current: string | null = null;
  for (const [i, v] of (spec.versions ?? []).entries()) {
    const vid = randomUUID();
    await owner.query(
      `INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at, superseded_at)
       VALUES ($1, $2, $3, $4, $4, $5::"VersionStatus", $6, $7, NULL)`,
      [vid, id, i + 1, v.amount, v.status, org.users.u1, v.approvedAt ?? null],
    );
    versionIds.push(vid);
    if (v.status === "APPROVED") current = vid;
  }
  if (current !== null) {
    await owner.query(`UPDATE envelope SET current_version_id = $2 WHERE id = $1`, [id, current]);
  }
  const dimsJson = JSON.stringify(dims);
  for (const s of spec.spend ?? []) {
    await owner.query(
      `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash)
       VALUES ($1, $2, $3::jsonb, $4, 'USD', $5, $5, 'fixture', $6, $7)`,
      [workspaceId, id, dimsJson, s.date, s.amount, randomUUID(), randomUUID()],
    );
  }
  for (const k of spec.kpi ?? []) {
    await owner.query(
      `INSERT INTO kpi_fact (workspace_id, envelope_id, dimension_values, period_date, metric, value, source_system, source_run_id, source_row_hash)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'fixture', $7, $8)`,
      [workspaceId, id, dimsJson, k.date, k.metric, k.value, randomUUID(), randomUUID()],
    );
  }
  for (const p of spec.projections ?? []) {
    await owner.query(
      `INSERT INTO projection_fact (workspace_id, envelope_id, dimension_values, period_date, metric, value, value_reporting, formula_version, horizon_end, source_system, source_run_id, loaded_at)
       VALUES ($1, $2, $3::jsonb, $4, 'spend', $5, $5, 'fixture_v1', '2026-03-31', 'fixture', $6, $7)`,
      [workspaceId, id, dimsJson, p.date, p.value, p.runId, p.loadedAt],
    );
  }
  return { id, versionIds };
}

/** Period used by every named fixture: 2026 Q1, 90 days. `today` is day 45, so elapsed = 0.5. */
export const PERIOD = { start: "2026-01-01", end: "2026-03-31" };
export const TODAY = "2026-02-14";

export type NamedEnvelope = "E1" | "E2" | "E3" | "E4" | "E5" | "E6";
export const NAMES: Record<NamedEnvelope, string> = {
  E1: "BR Meta",
  E2: "SP Google",
  E3: "MX Meta",
  E4: "DE TikTok",
  E5: "Unassigned Meta",
  E6: "Old 2025",
};

export interface NamedFixture {
  workspaceId: string;
  ids: Record<NamedEnvelope, string>;
  e1Versions: string[];
}

/**
 * Five envelopes in 2026 Q1 plus one outside it. Expected values are asserted in planner.test.ts.
 *
 * | env | geo   | platform | status   | budget (now) | actual | projected | conversions |
 * |-----|-------|----------|----------|--------------|--------|-----------|-------------|
 * | E1  | br    | meta     | APPROVED | 1500         | 400    | 1300      | 40          |
 * | E2  | br_sp | google   | PENDING  | 2000         | 1200   | 2400      | 30          |
 * | E3  | mx    | meta     | APPROVED | 500          | 0      | 0         | —           |
 * | E4  | de    | tiktok   | DRAFT    | —            | 100    | 0         | —           |
 * | E5  | —     | meta     | APPROVED | 800          | 800    | 900       | 0           |
 */
export async function seedNamedFixture(org: FixtureOrg): Promise<NamedFixture> {
  const ws = await createWorkspace(org);
  const { u1, u2 } = org.users;
  const oldRun = randomUUID();
  const newRun = randomUUID();

  const e1 = await insertEnvelope(org, ws, {
    name: NAMES.E1,
    geo: "br",
    platform: "meta",
    status: "APPROVED",
    ownerId: u1,
    start: "2026-01-01",
    end: "2026-03-31",
    versions: [
      { amount: "1000.00", status: "SUPERSEDED", approvedAt: "2026-01-05T00:00:00Z" },
      { amount: "1200.00", status: "SUPERSEDED", approvedAt: "2026-01-20T00:00:00Z" },
      { amount: "1500.00", status: "APPROVED", approvedAt: "2026-02-10T00:00:00Z" },
    ],
    spend: [
      { date: "2025-12-15", amount: "77.00" },
      { date: "2026-01-10", amount: "150.00" },
      { date: "2026-02-05", amount: "250.00" },
    ],
    kpi: [
      { date: "2026-01-10", metric: "conversions", value: "15" },
      { date: "2026-02-05", metric: "conversions", value: "25" },
    ],
    projections: [
      { date: "2026-03-31", value: "9999", runId: oldRun, loadedAt: "2026-02-01T00:00:00Z" },
      { date: "2026-03-31", value: "1300", runId: newRun, loadedAt: "2026-02-13T00:00:00Z" },
    ],
  });
  const e2 = await insertEnvelope(org, ws, {
    name: NAMES.E2,
    geo: "br_sp",
    platform: "google",
    status: "PENDING",
    ownerId: u2,
    start: "2026-02-01",
    end: "2026-03-31",
    versions: [
      { amount: "2000.00", status: "APPROVED", approvedAt: "2026-01-05T00:00:00Z" },
      { amount: "2500.00", status: "PENDING" },
    ],
    spend: [{ date: "2026-02-10", amount: "1200.00" }],
    kpi: [{ date: "2026-02-10", metric: "conversions", value: "30" }],
    projections: [{ date: "2026-03-31", value: "2400", runId: newRun, loadedAt: "2026-02-13T00:00:00Z" }],
  });
  const e3 = await insertEnvelope(org, ws, {
    name: NAMES.E3,
    geo: "mx",
    platform: "meta",
    status: "APPROVED",
    ownerId: u1,
    start: "2026-01-15",
    end: "2026-02-28",
    versions: [{ amount: "500.00", status: "APPROVED", approvedAt: "2026-01-20T00:00:00Z" }],
  });
  const e4 = await insertEnvelope(org, ws, {
    name: NAMES.E4,
    geo: "de",
    platform: "tiktok",
    status: "DRAFT",
    ownerId: null,
    currency: "EUR",
    start: "2026-03-01",
    end: "2026-03-31",
    createdAt: "2025-10-01T00:00:00Z",
    versions: [{ amount: "300.00", status: "DRAFT" }],
    spend: [{ date: "2026-03-02", amount: "100.00" }],
  });
  const e5 = await insertEnvelope(org, ws, {
    name: NAMES.E5,
    geo: null,
    platform: "meta",
    status: "APPROVED",
    ownerId: u2,
    start: "2026-01-01",
    end: "2026-03-31",
    versions: [{ amount: "800.00", status: "APPROVED", approvedAt: "2026-01-05T00:00:00Z" }],
    spend: [{ date: "2026-01-20", amount: "800.00" }],
    kpi: [{ date: "2026-01-20", metric: "conversions", value: "0" }],
    projections: [{ date: "2026-03-31", value: "900", runId: newRun, loadedAt: "2026-02-13T00:00:00Z" }],
  });
  const e6 = await insertEnvelope(org, ws, {
    name: NAMES.E6,
    geo: "br",
    platform: "meta",
    status: "APPROVED",
    start: "2025-01-01",
    end: "2025-12-31",
    versions: [{ amount: "999.00", status: "APPROVED", approvedAt: "2025-01-05T00:00:00Z" }],
  });

  // Tags: E1 q1-push; E3 q1-push + brand.
  const q1 = randomUUID();
  const brand = randomUUID();
  await owner.query(
    `INSERT INTO tag (id, workspace_id, name, created_by) VALUES ($1, $3, 'q1-push', $4), ($2, $3, 'brand', $4)`,
    [q1, brand, ws, u1],
  );
  for (const [tag, env] of [
    [q1, e1.id],
    [q1, e3.id],
    [brand, e3.id],
  ] as const) {
    await owner.query(
      `INSERT INTO taggable (workspace_id, tag_id, entity_type, entity_id, tagged_by) VALUES ($1, $2, 'envelope', $3, $4)`,
      [ws, tag, env, u1],
    );
  }

  // Threads: E2 open with a comment by u2 mentioning u1; E5 resolved.
  const t2 = randomUUID();
  const t5 = randomUUID();
  await owner.query(
    `INSERT INTO thread (id, workspace_id, anchor_type, anchor_id, status, created_by)
     VALUES ($1, $3, 'envelope', $4, 'open', $6), ($2, $3, 'envelope', $5, 'resolved', $6)`,
    [t2, t5, ws, e2.id, e5.id, u2],
  );
  await owner.query(
    `INSERT INTO comment (id, thread_id, author_id, body_md, mentions) VALUES ($1, $2, $3, 'please check', $4::jsonb)`,
    [randomUUID(), t2, u2, JSON.stringify([{ type: "user", id: u1 }])],
  );

  // Alert: E3 open, high.
  await owner.query(
    `INSERT INTO alert (id, workspace_id, rule_id, envelope_id, severity, status, metric_value, threshold, context)
     VALUES ($1, $2, $3, $4, 'high', 'OPEN', 1.5, 1.2, '{}'::jsonb)`,
    [randomUUID(), ws, randomUUID(), e3.id],
  );

  // Pending approval on E2's second version, requested by u1; u2 holds APPROVER in this workspace.
  const pendingVersion = e2.versionIds[1];
  await owner.query(
    `INSERT INTO approval_request (id, workspace_id, entity_type, entity_id, policy_id, policy_version, policy_snapshot, summary, requested_by)
     VALUES ($1, $2, 'envelope_version', $3, $4, 1, $5::jsonb, 'raise', $6)`,
    [
      randomUUID(),
      ws,
      pendingVersion,
      randomUUID(),
      JSON.stringify({ chain: [{ role: "APPROVER" }], blockSelfApproval: true }),
      u1,
    ],
  );
  await owner.query(
    `INSERT INTO role_assignment (id, workspace_id, principal_type, principal_id, role, created_by)
     VALUES ($1, $2, 'user', $3, 'APPROVER', $3)`,
    [randomUUID(), ws, u2],
  );

  // CPA target 12 on E1.
  const target = randomUUID();
  const targetVersion = randomUUID();
  await owner.query(
    `INSERT INTO target (id, workspace_id, scope_type, envelope_id, metric_key, start_date, end_date)
     VALUES ($1, $2, 'envelope', $3, 'cpa', '2026-01-01', '2026-03-31')`,
    [target, ws, e1.id],
  );
  await owner.query(
    `INSERT INTO target_version (id, target_id, version_no, value, comparator, status, created_by, approved_at)
     VALUES ($1, $2, 1, 12, 'lte', 'APPROVED', $3, '2026-01-05T00:00:00Z')`,
    [targetVersion, target, u1],
  );
  await owner.query(`UPDATE target SET current_version_id = $2 WHERE id = $1`, [target, targetVersion]);

  return {
    workspaceId: ws,
    ids: { E1: e1.id, E2: e2.id, E3: e3.id, E4: e4.id, E5: e5.id, E6: e6.id },
    e1Versions: e1.versionIds,
  };
}

export async function cleanupOrg(org: FixtureOrg): Promise<void> {
  const ws = `(SELECT id FROM workspace WHERE org_id = $1)`;
  const env = `(SELECT id FROM envelope WHERE workspace_id IN ${ws})`;
  const statements = [
    `DELETE FROM comment WHERE thread_id IN (SELECT id FROM thread WHERE workspace_id IN ${ws})`,
    `DELETE FROM thread WHERE workspace_id IN ${ws}`,
    `DELETE FROM taggable WHERE workspace_id IN ${ws}`,
    `DELETE FROM tag WHERE workspace_id IN ${ws}`,
    `DELETE FROM alert WHERE workspace_id IN ${ws}`,
    `DELETE FROM approval_request WHERE workspace_id IN ${ws}`,
    `DELETE FROM role_assignment WHERE workspace_id IN ${ws}`,
    `DELETE FROM target_version WHERE target_id IN (SELECT id FROM target WHERE workspace_id IN ${ws})`,
    `DELETE FROM target WHERE workspace_id IN ${ws}`,
    `DELETE FROM spend_fact WHERE workspace_id IN ${ws}`,
    `DELETE FROM kpi_fact WHERE workspace_id IN ${ws}`,
    `DELETE FROM projection_fact WHERE workspace_id IN ${ws}`,
    `DELETE FROM envelope_dimension WHERE envelope_id IN ${env}`,
    `DELETE FROM envelope_version WHERE envelope_id IN ${env}`,
    `DELETE FROM envelope WHERE workspace_id IN ${ws}`,
    `DELETE FROM workspace WHERE org_id = $1`,
    `DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1)`,
    `DELETE FROM dimension WHERE org_id = $1`,
    `DELETE FROM metric_definition WHERE org_id = $1`,
    `DELETE FROM app_user WHERE org_id = $1`,
    `DELETE FROM organization WHERE id = $1`,
  ];
  for (const sql of statements) {
    await owner.query(sql, [org.orgId]);
  }
}
