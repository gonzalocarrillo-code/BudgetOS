import { newId, Comparator, Predicate, QueryRequest } from "@budget/domain";
import type { Comparator as ComparatorT, FieldRef, FilterGroupT, Predicate as PredicateT } from "@budget/domain";
import fc from "fast-check";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileQuery, metricRegistry } from "./compile-query.js";

/**
 * Spec §6.3. Fixtures are SQL in this file (phase 4). Envelope commands do not exist yet.
 * The golden seed is T-006.
 */

const PERIOD_START = "2026-09-01";
const PERIOD_END = "2026-11-30";
const TODAY = "2026-10-15";
const PERIOD = { start: PERIOD_START, end: PERIOD_END };

const orgId = newId();
const matrixWs = newId();
const pageWs = newId();
const propWs = newId();
const me = newId();
const other = newId();
const approver = newId();
const mention = newId();
const regionDim = newId();
const bucketDim = newId();
const emea = newId();
const de = newId();
const fr = newId();
const us = newId();
const hist = newId();
const bucketA = newId();
const bucketB = newId();

const N = {
  alpha: "Alpha Germany",
  asof: "As Of History",
  bare: "Bare Empty",
  beta: "Beta United",
  core: "Core EMEA",
  france: "France Leaf",
  outside: "Outside Period",
} as const;

const ALL = [N.alpha, N.asof, N.bare, N.beta, N.core, N.france];
const EXCEPT = (names: string[]): string[] => ALL.filter((name) => !names.includes(name));

const region: FieldRef = { kind: "dimension", key: "region" };
const budgetField: FieldRef = { kind: "measure", key: "budget" };
const targetValue: FieldRef = { kind: "target", metric: "cpa", field: "value" };
const targetActual: FieldRef = { kind: "target", metric: "cpa", field: "actual" };
const targetVs: FieldRef = { kind: "target", metric: "cpa", field: "vs_target_pct" };
const targetExists: FieldRef = { kind: "target", metric: "cpa", field: "exists" };
const statusField: FieldRef = { kind: "attr", key: "status" };
const nameField: FieldRef = { kind: "attr", key: "name" };
const ownerField: FieldRef = { kind: "attr", key: "owner_id" };
const currencyField: FieldRef = { kind: "attr", key: "currency" };
const tagField: FieldRef = { kind: "attr", key: "tag" };
const threadField: FieldRef = { kind: "attr", key: "has_open_thread" };
const mentionField: FieldRef = { kind: "attr", key: "mentions_user" };
const approverField: FieldRef = { kind: "attr", key: "approver_id" };
const alertField: FieldRef = { kind: "attr", key: "alert_severity" };
const startField: FieldRef = { kind: "attr", key: "start_date" };
const createdField: FieldRef = { kind: "attr", key: "created_at" };

interface Case {
  id: string;
  field: FieldRef;
  op: ComparatorT;
  value?: PredicateT["value"];
  names?: string[];
  throws?: boolean;
  targets?: string[];
  userId?: string;
  workspaceId?: string;
}

function pred(field: FieldRef, op: ComparatorT, value?: PredicateT["value"]): PredicateT {
  return Predicate.parse(value === undefined ? { field, op } : { field, op, value });
}

const cases: Case[] = [
  { id: "dimension eq", field: region, op: "eq", value: "DE", names: [N.alpha] },
  { id: "dimension neq", field: region, op: "neq", value: "DE", names: EXCEPT([N.alpha]) },
  { id: "dimension in", field: region, op: "in", value: ["DE", "FR"], names: [N.alpha, N.france] },
  { id: "dimension nin", field: region, op: "nin", value: ["DE", "US"], names: [N.asof, N.bare, N.core, N.france] },
  { id: "dimension contains", field: region, op: "contains", value: "Germ", names: [N.alpha] },
  { id: "dimension starts_with", field: region, op: "starts_with", value: "United", names: [N.beta] },
  { id: "dimension is_empty", field: region, op: "is_empty", names: [N.bare] },
  { id: "dimension not_empty", field: region, op: "not_empty", names: EXCEPT([N.bare]) },
  { id: "dimension descends_from", field: region, op: "descends_from", value: "EMEA", names: [N.alpha, N.core, N.france] },
  { id: "dimension gt", field: region, op: "gt", value: "DE", throws: true },
  { id: "dimension gte", field: region, op: "gte", value: "DE", throws: true },
  { id: "dimension lt", field: region, op: "lt", value: "DE", throws: true },
  { id: "dimension lte", field: region, op: "lte", value: "DE", throws: true },
  { id: "dimension between", field: region, op: "between", value: ["A", "Z"], throws: true },
  { id: "dimension within", field: region, op: "within", value: { unit: "day", amount: -30, anchor: "today" }, throws: true },

  { id: "measure eq", field: budgetField, op: "eq", value: 100, names: [N.beta] },
  { id: "measure neq", field: budgetField, op: "neq", value: 100, names: [N.alpha, N.asof, N.core, N.france] },
  { id: "measure in", field: budgetField, op: "in", value: [50, 1000], names: [N.alpha, N.core] },
  { id: "measure gt", field: budgetField, op: "gt", value: 400, names: [N.alpha] },
  { id: "measure gte", field: budgetField, op: "gte", value: 400, names: [N.alpha, N.asof] },
  { id: "measure lt", field: budgetField, op: "lt", value: 100, names: [N.core] },
  { id: "measure lte", field: budgetField, op: "lte", value: 100, names: [N.beta, N.core] },
  { id: "measure between", field: budgetField, op: "between", value: [150, 250], names: [N.france] },
  { id: "measure is_empty", field: budgetField, op: "is_empty", names: [N.bare] },
  { id: "measure not_empty", field: budgetField, op: "not_empty", names: EXCEPT([N.bare]) },
  { id: "measure nin", field: budgetField, op: "nin", value: [100], throws: true },
  { id: "measure contains", field: budgetField, op: "contains", value: "1", throws: true },
  { id: "measure starts_with", field: budgetField, op: "starts_with", value: "1", throws: true },
  { id: "measure descends_from", field: budgetField, op: "descends_from", value: "x", throws: true },
  { id: "measure within", field: budgetField, op: "within", value: { unit: "day", amount: -1, anchor: "today" }, throws: true },

  { id: "target eq", field: targetValue, op: "eq", value: 12.5, names: [N.alpha] },
  { id: "target neq", field: targetValue, op: "neq", value: 12.5, names: [] },
  { id: "target in", field: targetValue, op: "in", value: [12.5, 99], names: [N.alpha] },
  { id: "target gt", field: targetValue, op: "gt", value: 12, names: [N.alpha] },
  { id: "target gte", field: targetValue, op: "gte", value: 12.5, names: [N.alpha] },
  { id: "target lt", field: targetValue, op: "lt", value: 12.5, names: [] },
  { id: "target lte", field: targetValue, op: "lte", value: 12.5, names: [N.alpha] },
  { id: "target between", field: targetValue, op: "between", value: [12, 13], names: [N.alpha] },
  { id: "target is_empty", field: targetValue, op: "is_empty", names: EXCEPT([N.alpha]) },
  { id: "target not_empty", field: targetValue, op: "not_empty", names: [N.alpha] },
  { id: "target nin", field: targetValue, op: "nin", value: [12.5], throws: true },
  { id: "target contains", field: targetValue, op: "contains", value: "1", throws: true },
  { id: "target starts_with", field: targetValue, op: "starts_with", value: "1", throws: true },
  { id: "target descends_from", field: targetValue, op: "descends_from", value: "x", throws: true },
  { id: "target within", field: targetValue, op: "within", value: { unit: "day", amount: -1, anchor: "today" }, throws: true },

  { id: "attr eq", field: statusField, op: "eq", value: "APPROVED", names: [N.alpha, N.asof, N.france] },
  { id: "attr neq", field: statusField, op: "neq", value: "APPROVED", names: [N.bare, N.beta, N.core] },
  { id: "attr in", field: statusField, op: "in", value: ["DRAFT", "PENDING"], names: [N.bare, N.beta, N.core] },
  { id: "attr gt", field: statusField, op: "gt", value: "DRAFT", names: [N.core] },
  { id: "attr gte", field: statusField, op: "gte", value: "DRAFT", names: [N.bare, N.beta, N.core] },
  { id: "attr lt", field: statusField, op: "lt", value: "DRAFT", names: [N.alpha, N.asof, N.france] },
  { id: "attr lte", field: statusField, op: "lte", value: "DRAFT", names: [N.alpha, N.asof, N.bare, N.beta, N.france] },
  { id: "attr between", field: statusField, op: "between", value: ["DRAFT", "PENDING"], names: [N.bare, N.beta, N.core] },
  { id: "attr is_empty", field: statusField, op: "is_empty", names: [] },
  { id: "attr not_empty", field: statusField, op: "not_empty", names: ALL },
  { id: "attr contains", field: nameField, op: "contains", value: "Germ", names: [N.alpha] },
  { id: "attr starts_with", field: statusField, op: "starts_with", value: "A", throws: true },
  { id: "attr nin", field: statusField, op: "nin", value: ["DRAFT"], throws: true },
  { id: "attr descends_from", field: statusField, op: "descends_from", value: "x", throws: true },
  {
    id: "attr within",
    field: startField,
    op: "within",
    value: { unit: "day", amount: -30, anchor: "today" },
    names: [N.alpha, N.bare],
  },
];

const ownerUrl = process.env["DATABASE_URL"] ?? "postgresql://budget:budget@localhost:5432/budget";
const client = new Client({ connectionString: ownerUrl });

async function sql(text: string, values: unknown[] = []): Promise<void> {
  await client.query(text, values);
}

async function queryRows<T extends Record<string, unknown>>(
  text: string,
  values: unknown[],
  userId?: string,
): Promise<T[]> {
  if (userId === undefined) {
    const result = await client.query<T>(text, values);
    return result.rows;
  }
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await client.query<T>(text, values);
    return result.rows;
  } finally {
    await client.query("COMMIT");
  }
}

function compile(c: Pick<Case, "field" | "op" | "value" | "targets" | "workspaceId"> & { filter?: FilterGroupT; asOf?: string; cursor?: string; limit?: number; groupBy?: string[]; measures?: string[] }) {
  const workspaceId = c.workspaceId ?? matrixWs;
  const filter = c.filter ?? { logic: "and" as const, children: [pred(c.field, c.op, c.value)] };
  const parsed = QueryRequest.parse({
    workspaceId,
    period: { kind: "range", start: PERIOD_START, end: PERIOD_END },
    filter,
    limit: c.limit ?? 50,
    measures: c.measures ?? ["budget", "actual", "projected"],
    ...(c.targets === undefined ? {} : { targets: c.targets }),
    ...(c.asOf === undefined ? {} : { asOf: c.asOf }),
    ...(c.cursor === undefined ? {} : { cursor: c.cursor }),
    ...(c.groupBy === undefined ? {} : { groupBy: c.groupBy }),
  });
  return compileQuery(parsed, PERIOD, TODAY);
}

async function leafNames(c: Case): Promise<string[]> {
  const compiled = compile(c);
  const rows = await queryRows<{ name: string }>(compiled.sql, compiled.values, c.userId);
  return rows.map((row) => row.name);
}

async function insertDimension(id: string, workspaceId: string, key: string, label: string): Promise<void> {
  await sql(
    `INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, allowed_parents, created_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'ENUM'::"DimensionDataType", '{}', $6::uuid)`,
    [id, orgId, workspaceId, key, label, me],
  );
}

async function insertValue(id: string, dimensionId: string, code: string, label: string, parent: string | null): Promise<void> {
  await sql(
    `INSERT INTO dimension_value (id, dimension_id, code, label, parent_value_id)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)`,
    [id, dimensionId, code, label, parent],
  );
}

interface Leaf {
  id: string;
  workspaceId: string;
  name: string;
  status: "DRAFT" | "PENDING" | "APPROVED";
  ownerId: string | null;
  currency: string;
  start: string;
  end: string;
  createdAt: string;
  regionValueId?: string;
  dimensionId?: string;
  versions?: Array<{ amount: string; approvedAt: string }>;
  spend?: string;
  projected?: string;
  conversions?: string;
}

async function insertLeaf(leaf: Leaf): Promise<void> {
  await sql(
    `INSERT INTO envelope (
       id, workspace_id, name, dimension_values, start_date, end_date, currency, status,
       owner_id, created_by, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4::jsonb, $5::date, $6::date, $7, $8::"EnvelopeStatus",
       $9::uuid, $10::uuid, $11::timestamptz, $11::timestamptz
     )`,
    [
      leaf.id,
      leaf.workspaceId,
      leaf.name,
      JSON.stringify(leaf.regionValueId === undefined ? {} : { region: leaf.name }),
      leaf.start,
      leaf.end,
      leaf.currency,
      leaf.status,
      leaf.ownerId,
      me,
      leaf.createdAt,
    ],
  );
  if (leaf.regionValueId !== undefined && leaf.dimensionId !== undefined) {
    await sql(
      `INSERT INTO envelope_dimension (envelope_id, dimension_id, value_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [leaf.id, leaf.dimensionId, leaf.regionValueId],
    );
  }
  let versionNo = 1;
  for (const version of leaf.versions ?? []) {
    await sql(
      `INSERT INTO envelope_version (
         id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::numeric, $4::numeric, 'APPROVED'::"VersionStatus", $5::uuid, $6::timestamptz
       )`,
      [newId(), leaf.id, versionNo, version.amount, me, version.approvedAt],
    );
    versionNo += 1;
  }
  if (leaf.spend !== undefined) {
    await sql(
      `INSERT INTO spend_fact (
         workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting,
         source_system, source_run_id, source_row_hash
       ) VALUES (
         $1::uuid, $2::uuid, '{}'::jsonb, '2026-09-15'::date, 'USD', $3::numeric, $3::numeric,
         'csv', $4::uuid, $5
       )`,
      [leaf.workspaceId, leaf.id, leaf.spend, newId(), newId()],
    );
  }
  if (leaf.projected !== undefined) {
    await sql(
      `INSERT INTO projection_fact (
         workspace_id, envelope_id, dimension_values, period_date, metric, value, value_reporting,
         formula_version, horizon_end, source_system, source_run_id
       ) VALUES (
         $1::uuid, $2::uuid, '{}'::jsonb, '2026-09-15'::date, 'spend', $3::numeric, $3::numeric,
         'v1', $4::date, 'csv', $5::uuid
       )`,
      [leaf.workspaceId, leaf.id, leaf.projected, PERIOD_END, newId()],
    );
  }
  if (leaf.conversions !== undefined) {
    await sql(
      `INSERT INTO kpi_fact (
         workspace_id, envelope_id, dimension_values, period_date, metric, value,
         source_system, source_run_id, source_row_hash
       ) VALUES (
         $1::uuid, $2::uuid, '{}'::jsonb, '2026-09-15'::date, 'conversions', $3::numeric,
         'csv', $4::uuid, $5
       )`,
      [leaf.workspaceId, leaf.id, leaf.conversions, newId(), newId()],
    );
  }
}

async function wipeWorkspace(workspaceId: string): Promise<void> {
  await sql(`DELETE FROM comment WHERE thread_id IN (SELECT id FROM thread WHERE workspace_id = $1::uuid)`, [workspaceId]);
  await sql(`DELETE FROM thread WHERE workspace_id = $1::uuid`, [workspaceId]);
  await sql(`DELETE FROM taggable WHERE workspace_id = $1::uuid`, [workspaceId]);
  await sql(`DELETE FROM tag WHERE workspace_id = $1::uuid`, [workspaceId]);
  await sql(`DELETE FROM alert WHERE workspace_id = $1::uuid`, [workspaceId]);
  await sql(`DELETE FROM approval_request WHERE workspace_id = $1::uuid`, [workspaceId]);
  await sql(`DELETE FROM role_assignment WHERE workspace_id = $1::uuid`, [workspaceId]);
  await sql(`DELETE FROM target_version WHERE target_id IN (SELECT id FROM target WHERE workspace_id = $1::uuid)`, [workspaceId]);
  await sql(`DELETE FROM target WHERE workspace_id = $1::uuid`, [workspaceId]);
  await sql(`DELETE FROM projection_fact WHERE workspace_id = $1::uuid`, [workspaceId]);
  await sql(`DELETE FROM kpi_fact WHERE workspace_id = $1::uuid`, [workspaceId]);
  await sql(`DELETE FROM spend_fact WHERE workspace_id = $1::uuid`, [workspaceId]);
  await sql(`DELETE FROM envelope_dimension WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)`, [workspaceId]);
  await sql(`DELETE FROM envelope_version WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)`, [workspaceId]);
  await sql(`DELETE FROM envelope WHERE workspace_id = $1::uuid`, [workspaceId]);
  await sql(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE workspace_id = $1::uuid)`, [workspaceId]);
  await sql(`DELETE FROM dimension WHERE workspace_id = $1::uuid`, [workspaceId]);
  await sql(`DELETE FROM workspace WHERE id = $1::uuid`, [workspaceId]);
}

describe.sequential("T-007 query planner", () => {
  beforeAll(async () => {
    await client.connect();
    await sql(`SELECT ensure_fact_partitions('2026-01-01'::date, 18)`);
    await sql(`INSERT INTO organization (id, name) VALUES ($1::uuid, 'Planner Org')`, [orgId]);
    for (const [id, slug] of [
      [matrixWs, "matrix"],
      [pageWs, "pages"],
      [propWs, "props"],
    ] as const) {
      await sql(
        `INSERT INTO workspace (id, org_id, slug, name, reporting_currency)
         VALUES ($1::uuid, $2::uuid, $3, $3, 'USD')`,
        [id, orgId, slug],
      );
    }
    await insertDimension(regionDim, matrixWs, "region", "Region");
    await insertValue(emea, regionDim, "EMEA", "EMEA Region", null);
    await insertValue(de, regionDim, "DE", "Germany", emea);
    await insertValue(fr, regionDim, "FR", "France", emea);
    await insertValue(us, regionDim, "US", "United States", null);
    await insertValue(hist, regionDim, "HIST", "History", null);
    await insertDimension(bucketDim, propWs, "bucket", "Bucket");
    await insertValue(bucketA, bucketDim, "A", "A", null);
    await insertValue(bucketB, bucketDim, "B", "B", null);

    const approved = "2026-09-01T00:00:00.000Z";
    await insertLeaf({
      id: newId(),
      workspaceId: matrixWs,
      name: N.alpha,
      status: "APPROVED",
      ownerId: me,
      currency: "USD",
      start: "2026-10-10",
      end: "2026-11-30",
      createdAt: "2026-10-10T00:00:00.000Z",
      regionValueId: de,
      dimensionId: regionDim,
      versions: [{ amount: "1000.00", approvedAt: approved }],
      spend: "400.00",
      projected: "900.00",
      conversions: "40",
    });
    await insertLeaf({
      id: newId(),
      workspaceId: matrixWs,
      name: N.beta,
      status: "DRAFT",
      ownerId: other,
      currency: "EUR",
      start: "2026-08-15",
      end: "2026-12-31",
      createdAt: "2026-08-15T00:00:00.000Z",
      regionValueId: us,
      dimensionId: regionDim,
      versions: [{ amount: "100.00", approvedAt: approved }],
      spend: "10.00",
      projected: "20.00",
    });
    await insertLeaf({
      id: newId(),
      workspaceId: matrixWs,
      name: N.core,
      status: "PENDING",
      ownerId: other,
      currency: "USD",
      start: "2026-09-05",
      end: "2026-11-30",
      createdAt: "2026-09-05T00:00:00.000Z",
      regionValueId: emea,
      dimensionId: regionDim,
      versions: [{ amount: "50.00", approvedAt: approved }],
    });
    await insertLeaf({
      id: newId(),
      workspaceId: matrixWs,
      name: N.france,
      status: "APPROVED",
      ownerId: me,
      currency: "USD",
      start: "2026-11-25",
      end: "2026-12-15",
      createdAt: "2026-11-25T00:00:00.000Z",
      regionValueId: fr,
      dimensionId: regionDim,
      versions: [{ amount: "200.00", approvedAt: approved }],
    });
    await insertLeaf({
      id: newId(),
      workspaceId: matrixWs,
      name: N.bare,
      status: "DRAFT",
      ownerId: null,
      currency: "GBP",
      start: "2026-09-20",
      end: "2026-09-30",
      createdAt: "2026-09-20T00:00:00.000Z",
    });
    await insertLeaf({
      id: newId(),
      workspaceId: matrixWs,
      name: N.asof,
      status: "APPROVED",
      ownerId: me,
      currency: "USD",
      start: "2026-09-01",
      end: "2026-11-30",
      createdAt: "2026-09-01T00:00:00.000Z",
      regionValueId: hist,
      dimensionId: regionDim,
      versions: [
        { amount: "100.00", approvedAt: "2026-01-15T00:00:00.000Z" },
        { amount: "250.00", approvedAt: "2026-06-01T00:00:00.000Z" },
        { amount: "400.00", approvedAt: "2026-08-01T00:00:00.000Z" },
      ],
    });
    await insertLeaf({
      id: newId(),
      workspaceId: matrixWs,
      name: N.outside,
      status: "APPROVED",
      ownerId: me,
      currency: "USD",
      start: "2026-07-01",
      end: "2026-08-01",
      createdAt: "2026-07-01T00:00:00.000Z",
      versions: [{ amount: "999.00", approvedAt: approved }],
    });

    const alpha = await client.query<{ id: string }>(`SELECT id::text AS id FROM envelope WHERE workspace_id = $1::uuid AND name = $2`, [
      matrixWs,
      N.alpha,
    ]);
    const alphaId = alpha.rows[0]?.id;
    if (alphaId === undefined) {
      throw new Error("alpha envelope missing");
    }
    const version = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM envelope_version WHERE envelope_id = $1::uuid ORDER BY version_no LIMIT 1`,
      [alphaId],
    );
    const versionId = version.rows[0]?.id;
    if (versionId === undefined) {
      throw new Error("alpha version missing");
    }

    const tagId = newId();
    await sql(
      `INSERT INTO tag (id, workspace_id, name, created_by) VALUES ($1::uuid, $2::uuid, 'priority', $3::uuid)`,
      [tagId, matrixWs, me],
    );
    await sql(
      `INSERT INTO taggable (workspace_id, tag_id, entity_type, entity_id, tagged_by)
       VALUES ($1::uuid, $2::uuid, 'envelope', $3::uuid, $4::uuid)`,
      [matrixWs, tagId, alphaId, me],
    );
    const threadId = newId();
    await sql(
      `INSERT INTO thread (id, workspace_id, anchor_type, anchor_id, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'envelope', $3::uuid, 'open', $4::uuid)`,
      [threadId, matrixWs, alphaId, me],
    );
    await sql(
      `INSERT INTO comment (id, thread_id, author_id, body_md, mentions)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'see this', $4::jsonb)`,
      [newId(), threadId, me, JSON.stringify([{ type: "user", id: mention }])],
    );
    const resolvedId = newId();
    const core = await client.query<{ id: string }>(`SELECT id::text AS id FROM envelope WHERE workspace_id = $1::uuid AND name = $2`, [
      matrixWs,
      N.core,
    ]);
    const coreId = core.rows[0]?.id;
    if (coreId === undefined) {
      throw new Error("core envelope missing");
    }
    await sql(
      `INSERT INTO thread (id, workspace_id, anchor_type, anchor_id, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'envelope', $3::uuid, 'resolved', $4::uuid)`,
      [resolvedId, matrixWs, coreId, me],
    );
    const policyId = newId();
    await sql(
      `INSERT INTO approval_request (
         id, workspace_id, entity_type, entity_id, policy_id, policy_version, policy_snapshot,
         current_step, status, summary, requested_by
       ) VALUES (
         $1::uuid, $2::uuid, 'envelope_version', $3::uuid, $4::uuid, 1, $5::jsonb,
         0, 'PENDING'::"RequestStatus", 'approve alpha', $6::uuid
       )`,
      [
        newId(),
        matrixWs,
        versionId,
        policyId,
        JSON.stringify({ blockSelfApproval: true, chain: [{ role: "APPROVER" }] }),
        other,
      ],
    );
    await sql(
      `INSERT INTO role_assignment (id, workspace_id, principal_type, principal_id, role, created_by)
       VALUES ($1::uuid, $2::uuid, 'user', $3::uuid, 'APPROVER'::"Role", $4::uuid)`,
      [newId(), matrixWs, approver, me],
    );
    const ruleId = newId();
    await sql(
      `INSERT INTO alert (id, workspace_id, rule_id, envelope_id, severity, status, metric_value, threshold, context)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'warning', 'OPEN'::"AlertStatus", 1, 1, '{}'::jsonb)`,
      [newId(), matrixWs, ruleId, alphaId],
    );
    const targetId = newId();
    const targetVersionId = newId();
    await sql(
      `INSERT INTO target (
         id, workspace_id, scope_type, envelope_id, metric_key, start_date, end_date, status
       ) VALUES (
         $1::uuid, $2::uuid, 'envelope', $3::uuid, 'cpa', $4::date, $5::date, 'active'
       )`,
      [targetId, matrixWs, alphaId, PERIOD_START, PERIOD_END],
    );
    await sql(
      `INSERT INTO target_version (
         id, target_id, version_no, value, comparator, status, created_by, approved_at
       ) VALUES (
         $1::uuid, $2::uuid, 1, 12.5, 'lte', 'APPROVED'::"VersionStatus", $3::uuid, $4::timestamptz
       )`,
      [targetVersionId, targetId, me, approved],
    );
    await sql(`UPDATE target SET current_version_id = $2::uuid WHERE id = $1::uuid`, [targetId, targetVersionId]);
    metricRegistry.set("cpa", { numerator: "spend", denominator: "kpi:conversions" });
  }, 30_000);

  afterAll(async () => {
    await wipeWorkspace(matrixWs);
    await wipeWorkspace(pageWs);
    await wipeWorkspace(propWs);
    await sql(`DELETE FROM organization WHERE id = $1::uuid`, [orgId]);
    metricRegistry.delete("cpa");
    await client.end();
  });

  it("covers every comparator on every field kind", () => {
    const kinds = ["dimension", "measure", "target", "attr"] as const;
    for (const kind of kinds) {
      for (const op of Comparator.options) {
        const hit = cases.some((c) => c.field.kind === kind && c.op === op);
        expect(hit, `${kind} ${op}`).toBe(true);
      }
    }
  });

  it.each(cases)("$id", async (c) => {
    if (c.throws === true) {
      expect(() => compile(c)).toThrow(/not valid|not supported/);
      return;
    }
    const names = await leafNames(c);
    expect(names.slice().sort()).toEqual((c.names ?? []).slice().sort());
  });

  it("filters nested region values with descends_from", async () => {
    const names = await leafNames({
      id: "nested",
      field: region,
      op: "descends_from",
      value: "EMEA",
      names: [N.alpha, N.core, N.france],
    });
    expect(names.slice().sort()).toEqual([N.alpha, N.core, N.france].sort());
    const paths = await client.query<{ code: string; path: string }>(
      `SELECT code, path::text AS path FROM dimension_value WHERE dimension_id = $1::uuid AND code IN ('DE', 'FR')`,
      [regionDim],
    );
    const byCode = new Map(paths.rows.map((row) => [row.code, row.path]));
    expect(byCode.get("DE")).toBe("emea.de");
    expect(byCode.get("FR")).toBe("emea.fr");
  });

  it("evaluates within for today, period_start, and period_end", async () => {
    const anchors: Array<{ anchor: "today" | "period_start" | "period_end"; amount: number; names: string[] }> = [
      { anchor: "today", amount: -30, names: [N.alpha, N.bare] },
      { anchor: "period_start", amount: 10, names: [N.asof, N.core] },
      { anchor: "period_end", amount: -7, names: [N.france] },
    ];
    for (const anchor of anchors) {
      const names = await leafNames({
        id: anchor.anchor,
        field: startField,
        op: "within",
        value: { unit: "day", amount: anchor.amount, anchor: anchor.anchor },
      });
      expect(names.slice().sort(), anchor.anchor).toEqual(anchor.names.slice().sort());
    }
    const created = await leafNames({
      id: "created",
      field: createdField,
      op: "within",
      value: { unit: "day", amount: -30, anchor: "today" },
    });
    expect(created.slice().sort()).toEqual([N.alpha, N.bare].sort());
  });

  it("returns the approved amount at three asOf timestamps", async () => {
    const points: Array<[string, string]> = [
      ["2026-02-01T00:00:00.000Z", "100.00"],
      ["2026-07-01T00:00:00.000Z", "250.00"],
      ["2026-09-01T00:00:00.000Z", "400.00"],
    ];
    for (const [asOf, amount] of points) {
      const compiled = compile({
        field: nameField,
        op: "eq",
        value: N.asof,
        asOf,
        measures: ["budget"],
      });
      const rows = await queryRows<{ name: string; budget: string | null }>(compiled.sql, compiled.values);
      expect(rows, asOf).toHaveLength(1);
      expect(rows[0]?.name).toBe(N.asof);
      expect(Number(rows[0]?.budget)).toBeCloseTo(Number(amount), 2);
    }
  });

  it("sums leaf budgets, actuals, and projections for an empty filter", async () => {
    const compiled = compile({
      field: statusField,
      op: "not_empty",
      measures: ["budget", "actual", "projected"],
    });
    const rows = await queryRows<{ name: string; budget: string | null; actual: string | null; projected: string | null }>(
      compiled.sql,
      compiled.values,
    );
    const names = rows.map((row) => row.name);
    expect(names).not.toContain(N.outside);
    expect(names.slice().sort()).toEqual(ALL.slice().sort());
    const budget = rows.reduce((sum, row) => sum + Number(row.budget ?? 0), 0);
    const actual = rows.reduce((sum, row) => sum + Number(row.actual ?? 0), 0);
    const projected = rows.reduce((sum, row) => sum + Number(row.projected ?? 0), 0);
    expect(budget).toBeCloseTo(1750, 2);
    expect(actual).toBeCloseTo(410, 2);
    expect(projected).toBeCloseTo(920, 2);
  });

  it("compiles or and not groups", async () => {
    const orFilter: FilterGroupT = {
      logic: "or",
      children: [pred(nameField, "eq", N.alpha), pred(nameField, "eq", N.beta)],
    };
    const orCompiled = compile({ field: nameField, op: "eq", filter: orFilter });
    const orRows = await queryRows<{ name: string }>(orCompiled.sql, orCompiled.values);
    expect(orRows.map((row) => row.name).sort()).toEqual([N.alpha, N.beta].sort());

    const notFilter: FilterGroupT = {
      logic: "and",
      not: true,
      children: [pred(statusField, "eq", "DRAFT")],
    };
    const notCompiled = compile({ field: statusField, op: "eq", filter: notFilter });
    const notRows = await queryRows<{ name: string }>(notCompiled.sql, notCompiled.values);
    expect(notRows.map((row) => row.name).sort()).toEqual(EXCEPT([N.bare, N.beta]).sort());
  });

  it("matches owner, currency, tag, thread, mention, approver, and alert attrs", async () => {
    const checks: Case[] = [
      { id: "owner me", field: ownerField, op: "eq", value: "@me", names: [N.alpha, N.asof, N.france], userId: me },
      { id: "owner other", field: ownerField, op: "eq", value: other, names: [N.beta, N.core] },
      { id: "owner empty", field: ownerField, op: "is_empty", names: [N.bare] },
      { id: "currency", field: currencyField, op: "eq", value: "USD", names: [N.alpha, N.asof, N.core, N.france] },
      { id: "tag eq", field: tagField, op: "eq", value: "priority", names: [N.alpha] },
      { id: "tag in", field: tagField, op: "in", value: ["priority", "later"], names: [N.alpha] },
      { id: "thread open", field: threadField, op: "eq", value: true, names: [N.alpha] },
      { id: "thread closed", field: threadField, op: "eq", value: false, names: EXCEPT([N.alpha]) },
      { id: "mention", field: mentionField, op: "eq", value: mention, names: [N.alpha] },
      { id: "approver", field: approverField, op: "eq", value: approver, names: [N.alpha] },
      { id: "approver me", field: approverField, op: "eq", value: "@me", names: [N.alpha], userId: approver },
      { id: "alert", field: alertField, op: "eq", value: "warning", names: [N.alpha] },
      { id: "target exists empty", field: targetExists, op: "is_empty", names: EXCEPT([N.alpha]) },
      { id: "target exists", field: targetExists, op: "not_empty", names: [N.alpha] },
      { id: "target actual", field: targetActual, op: "eq", value: 10, names: [N.alpha], targets: ["cpa"] },
      { id: "target vs", field: targetVs, op: "between", value: [0.7, 0.9], names: [N.alpha], targets: ["cpa"] },
    ];
    for (const check of checks) {
      const names = await leafNames(check);
      expect(names.slice().sort(), check.id).toEqual((check.names ?? []).slice().sort());
    }
    expect(() =>
      compile({
        field: { kind: "attr", key: "requested_by" },
        op: "eq",
        value: other,
      }),
    ).toThrow(/not supported/);
  });

  it("recomputes ratio measures from sums and keeps leaf sums equal to group totals", async () => {
    const elapsed = 45 / 91;
    await insertLeaf({
      id: newId(),
      workspaceId: propWs,
      name: "ratio-a",
      status: "APPROVED",
      ownerId: me,
      currency: "USD",
      start: PERIOD_START,
      end: PERIOD_END,
      createdAt: "2026-09-01T00:00:00.000Z",
      regionValueId: bucketA,
      dimensionId: bucketDim,
      versions: [{ amount: "100.00", approvedAt: "2026-09-01T00:00:00.000Z" }],
      spend: "100.00",
      projected: "150.00",
    });
    await insertLeaf({
      id: newId(),
      workspaceId: propWs,
      name: "ratio-b",
      status: "APPROVED",
      ownerId: me,
      currency: "USD",
      start: PERIOD_START,
      end: PERIOD_END,
      createdAt: "2026-09-01T00:00:00.000Z",
      regionValueId: bucketA,
      dimensionId: bucketDim,
      versions: [{ amount: "300.00", approvedAt: "2026-09-01T00:00:00.000Z" }],
      spend: "0.00",
      projected: "300.00",
    });
    const measures = ["budget", "actual", "projected", "pace_index", "variance_pct", "projected_close_pct", "spend_to_date_pct"];
    const grouped = compile({
      field: budgetField,
      op: "not_empty",
      workspaceId: propWs,
      groupBy: ["bucket"],
      measures,
    });
    const groups = await queryRows<{
      dim_bucket: string | null;
      budget: string | null;
      actual: string | null;
      projected: string | null;
      pace_index: string | null;
      variance_pct: string | null;
      projected_close_pct: string | null;
      spend_to_date_pct: string | null;
    }>(grouped.sql, grouped.values);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(Number(group?.budget)).toBeCloseTo(400, 2);
    expect(Number(group?.actual)).toBeCloseTo(100, 2);
    expect(Number(group?.projected)).toBeCloseTo(450, 2);
    const pace = Number(group?.pace_index);
    const recomputed = 100 / 400 / elapsed;
    const averaged = (1 / elapsed + 0) / 2;
    expect(pace).toBeCloseTo(recomputed, 5);
    expect(Math.abs(pace - averaged)).toBeGreaterThan(0.2);
    expect(Number(group?.variance_pct)).toBeCloseTo(0.125, 5);
    expect(Number(group?.projected_close_pct)).toBeCloseTo(1.125, 5);
    expect(Number(group?.spend_to_date_pct)).toBeCloseTo(0.25, 5);

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            group: fc.constantFrom("A" as const, "B" as const),
            budget: fc.integer({ min: 1, max: 500 }),
            actual: fc.integer({ min: 0, max: 500 }),
            projected: fc.integer({ min: 0, max: 500 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (leaves) => {
          await sql(`DELETE FROM projection_fact WHERE workspace_id = $1::uuid`, [propWs]);
          await sql(`DELETE FROM spend_fact WHERE workspace_id = $1::uuid`, [propWs]);
          await sql(
            `DELETE FROM envelope_dimension WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)`,
            [propWs],
          );
          await sql(
            `DELETE FROM envelope_version WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)`,
            [propWs],
          );
          await sql(`DELETE FROM envelope WHERE workspace_id = $1::uuid`, [propWs]);
          for (const leaf of leaves) {
            await insertLeaf({
              id: newId(),
              workspaceId: propWs,
              name: `leaf-${newId()}`,
              status: "APPROVED",
              ownerId: me,
              currency: "USD",
              start: PERIOD_START,
              end: PERIOD_END,
              createdAt: "2026-09-01T00:00:00.000Z",
              regionValueId: leaf.group === "A" ? bucketA : bucketB,
              dimensionId: bucketDim,
              versions: [{ amount: String(leaf.budget), approvedAt: "2026-09-01T00:00:00.000Z" }],
              spend: String(leaf.actual),
              projected: String(leaf.projected),
            });
          }
          const compiled = compile({
            field: budgetField,
            op: "not_empty",
            workspaceId: propWs,
            groupBy: ["bucket"],
            measures: ["budget", "actual", "projected"],
          });
          const rows = await queryRows<{
            dim_bucket: string | null;
            budget: string | null;
            actual: string | null;
            projected: string | null;
          }>(compiled.sql, compiled.values);
          const totals = { budget: 0, actual: 0, projected: 0 };
          for (const row of rows) {
            totals.budget += Number(row.budget ?? 0);
            totals.actual += Number(row.actual ?? 0);
            totals.projected += Number(row.projected ?? 0);
          }
          const leafTotals = leaves.reduce(
            (sum, leaf) => ({
              budget: sum.budget + leaf.budget,
              actual: sum.actual + leaf.actual,
              projected: sum.projected + leaf.projected,
            }),
            { budget: 0, actual: 0, projected: 0 },
          );
          expect(totals.budget).toBeCloseTo(leafTotals.budget, 2);
          expect(totals.actual).toBeCloseTo(leafTotals.actual, 2);
          expect(totals.projected).toBeCloseTo(leafTotals.projected, 2);
          for (const code of ["A", "B"] as const) {
            const members = leaves.filter((leaf) => leaf.group === code);
            const row = rows.find((item) => item.dim_bucket === code);
            if (members.length === 0) {
              expect(row).toBeUndefined();
              continue;
            }
            expect(Number(row?.budget)).toBeCloseTo(
              members.reduce((sum, leaf) => sum + leaf.budget, 0),
              2,
            );
            expect(Number(row?.actual)).toBeCloseTo(
              members.reduce((sum, leaf) => sum + leaf.actual, 0),
              2,
            );
            expect(Number(row?.projected)).toBeCloseTo(
              members.reduce((sum, leaf) => sum + leaf.projected, 0),
              2,
            );
          }
        },
      ),
      { numRuns: 20, seed: 7 },
    );
  }, 60_000);

  it("keeps an offset cursor stable under concurrent inserts", async () => {
    const names = ["page-a", "page-c", "page-e", "page-g", "page-i"];
    for (const name of names) {
      await insertLeaf({
        id: newId(),
        workspaceId: pageWs,
        name,
        status: "DRAFT",
        ownerId: null,
        currency: "USD",
        start: PERIOD_START,
        end: PERIOD_END,
        createdAt: "2026-09-01T00:00:00.000Z",
      });
    }
    const cursor = Buffer.from("2", "utf8").toString("base64url");
    const page = compile({
      field: statusField,
      op: "not_empty",
      workspaceId: pageWs,
      limit: 2,
      cursor,
      measures: ["budget"],
    });
    expect(Number(Buffer.from(cursor, "base64url").toString())).toBe(2);
    expect(page.values.at(-2)).toBe(3);
    expect(page.values.at(-1)).toBe(2);

    const otherClient = new Client({ connectionString: ownerUrl });
    await otherClient.connect();
    try {
      await otherClient.query("BEGIN");
      await otherClient.query(
        `INSERT INTO envelope (
           id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, 'page-b', '{}'::jsonb, $3::date, $4::date, 'USD', 'DRAFT'::"EnvelopeStatus", $5::uuid, now()
         )`,
        [newId(), pageWs, PERIOD_START, PERIOD_END, me],
      );
      const during = await queryRows<{ name: string }>(page.sql, page.values);
      expect(during.map((row) => row.name)).toEqual(["page-e", "page-g", "page-i"]);
      await otherClient.query("ROLLBACK");
      await otherClient.query(
        `INSERT INTO envelope (
           id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, 'page-z', '{}'::jsonb, $3::date, $4::date, 'USD', 'DRAFT'::"EnvelopeStatus", $5::uuid, now()
         )`,
        [newId(), pageWs, PERIOD_START, PERIOD_END, me],
      );
      const after = await queryRows<{ name: string }>(page.sql, page.values);
      expect(after.map((row) => row.name)).toEqual(["page-e", "page-g", "page-i"]);
    } finally {
      await otherClient.end();
    }
  });
});
