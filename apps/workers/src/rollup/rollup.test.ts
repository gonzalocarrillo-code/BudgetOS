import "../test-support/env.js";
import { randomUUID } from "node:crypto";
import { asOrgAdmin, ensurePartitions, outbox, withTenant } from "@budget/db";
import { compileTree } from "@budget/query-planner";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteWorkspaceForTests } from "../purge/purge.js";
import { handleRollupEvent, rebuildWorkspace } from "./rollup.js";

/**
 * T-022 rollup-worker on a small workspace: a missing dimension is a `∅` segment, a node knows the
 * envelope whose tuple it is, a parent counts only for what it has not split (ADR-059), and
 * archiving a leaf removes a node that becomes empty. The golden tree == pivot check is in apps/api/src/seed/golden.test.ts.
 */

const url = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set (packages/db/.env)`);
  return v;
};
const owner = new PrismaClient({ datasources: { db: { url: url("DATABASE_URL") } } });
const app = new PrismaClient({ datasources: { db: { url: url("APP_DATABASE_URL") } } });
const orgId = randomUUID();
const ws = randomUUID();
const userId = randomUUID();
const templateId = randomUUID();
const period = { start: "2026-01-01", end: "2026-12-31" };
const TODAY = "2026-06-30";
const env: Record<string, string> = {};

// W0-6: the owner has no BYPASSRLS; every raw owner.* read/write below (all scoped to this org's
// workspace, plus dimension/dimension_value which need an exact org_id match) needs the same
// org-admin tenant context real writes get from withTenant.
function asOwner<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return asOrgAdmin(owner, fn, orgId);
}
async function envelope(name: string, dims: Record<string, string>, budget: string, parentId: string | null = null): Promise<string> {
  const id = randomUUID();
  const v = randomUUID();
  await asOwner(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO envelope (id, workspace_id, parent_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $6::uuid, now())`,
      id, ws, parentId, name, JSON.stringify(dims), userId,
    );
    await tx.$executeRawUnsafe(`INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at) VALUES ($1::uuid, $2::uuid, 1, $3::numeric, $3::numeric, 'APPROVED', $4::uuid, '2026-01-02T00:00:00Z')`, v, id, budget, userId);
    await tx.$executeRawUnsafe(`UPDATE envelope SET current_version_id = $2::uuid WHERE id = $1::uuid`, id, v);
    for (const [key, code] of Object.entries(dims)) {
      await tx.$executeRawUnsafe(
        `INSERT INTO envelope_dimension (envelope_id, dimension_id, value_id) SELECT $1::uuid, d.id, dv.id FROM dimension d JOIN dimension_value dv ON dv.dimension_id = d.id WHERE d.org_id = $2::uuid AND d.key = $3 AND dv.code = $4`,
        id, orgId, key, code,
      );
    }
  });
  return id;
}
async function tree(): Promise<Record<string, string>> {
  const c = compileTree({ workspaceId: ws, templateId, period });
  const rows = await withTenant(app, { workspaceId: ws, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `t022-${randomUUID()}` }, (tx) => tx.$queryRawUnsafe<Array<{ node_path: string; measures: { budget: string | null } }>>(c.sql, ...c.values));
  return Object.fromEntries(rows.map((r) => [r.node_path, String(r.measures.budget)]));
}
const envelopeOfNode = async (path: string) =>
  (await asOwner((tx) => tx.$queryRawUnsafe<Array<{ envelope_id: string | null }>>(`SELECT envelope_id::text FROM rollup_cache WHERE template_id = $1::uuid AND node_path = $2`, templateId, path)))[0]?.envelope_id ?? null;

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t022" } });
  await asOwner((tx) => tx.workspace.create({ data: { id: ws, orgId, slug: `t022-${ws}`, name: "T-022", reportingCurrency: "USD", fiscalYearStartMonth: 1 } }));
  await owner.user.create({ data: { id: userId, orgId, email: `${userId}@t022.test`, name: "T-022", googleSub: `g-${userId}` } });
  await asOwner(async (tx) => {
    for (const [key, codes] of [["region", ["LATAM", "EMEA"]], ["platform", ["meta", "tiktok"]]] as const) {
      const id = randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, $3, $3, 'ENUM', $4::uuid)`, id, orgId, key, userId);
      for (const code of codes) await tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $3)`, randomUUID(), id, code);
    }
    await tx.hierarchyTemplate.create({ data: { id: templateId, workspaceId: ws, name: "Region > platform", path: ["region", "platform"], createdBy: userId } });
  });
  env["latam"] = await envelope("LATAM", { region: "LATAM" }, "1000.00"); // a parent: counts for the 500 it has not split
  env["latamMeta"] = await envelope("LATAM meta", { region: "LATAM", platform: "meta" }, "300.00", env["latam"]);
  env["latamTiktok"] = await envelope("LATAM tiktok", { region: "LATAM", platform: "tiktok" }, "200.00", env["latam"]);
  env["emea"] = await envelope("EMEA (no platform)", { region: "EMEA" }, "50.00");
});

afterAll(async () => {
  // W3-11 (audit I-32): deletes every row that FKs to this workspace (and the workspace row
  // itself, including envelope_dimension, which references dimension_value) in the same order
  // `purgeWorkspace` validates against production — before the org-level dimension cleanup below,
  // which would otherwise violate envelope_dimension_value_id_fkey.
  // W0-6: the owner has no BYPASSRLS; pass orgId so deleteWorkspaceForTests runs under org-admin
  // tenant context (asOwner wraps the rest the same way).
  await deleteWorkspaceForTests(owner, ws, orgId);
  await asOwner(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE dimension_value SET parent_value_id = NULL, merged_into_id = NULL WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId); // W3-11 (I-32): self-ref FK
    await tx.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
    await tx.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("rollup-worker", () => {
  it("builds the tree over what each budget holds: a parent adds only its unsplit part, a missing dimension is ∅", async () => {
    await rebuildWorkspace(app, { workspaceId: ws, orgId }, { today: TODAY, periods: [period] });
    // The root is the top-level budgets: LATAM 1000 + EMEA 50. LATAM's own 500 sits at LATAM/∅.
    expect(await tree()).toEqual({ "": "1050.00", EMEA: "50.00", "EMEA/∅": "50.00", LATAM: "1000.00", "LATAM/∅": "500.00", "LATAM/meta": "300.00", "LATAM/tiktok": "200.00" });
    expect(await envelopeOfNode("LATAM")).toBe(env["latam"]);
    expect(await envelopeOfNode("LATAM/meta")).toBe(env["latamMeta"]);
    expect(await envelopeOfNode("EMEA/∅")).toBeNull();
  });

  it("archiving a leaf refreshes its path and removes the node it leaves empty, once per event", async () => {
    await asOwner((tx) => tx.$executeRawUnsafe(`UPDATE envelope SET status = 'ARCHIVED' WHERE id = $1::uuid`, env["latamTiktok"]));
    await withTenant(app, { workspaceId: ws, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `t022-${randomUUID()}` }, (tx) => outbox(tx, { workspaceId: ws, topic: "budget.changed", payload: { envelopeId: env["latamTiktok"], kind: "archived" } }));
    const [row] = await asOwner((tx) => tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM outbox WHERE workspace_id = $1::uuid ORDER BY outbox.id DESC LIMIT 1`, ws));
    const body = { message: { data: Buffer.from(JSON.stringify({ envelopeId: env["latamTiktok"], kind: "archived" })).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic: "budget.changed" }, messageId: "m" }, subscription: "rollup-worker" };
    const first = await handleRollupEvent(app, body, TODAY);
    expect(first).toMatchObject({ outcome: "applied", deleted: 2 }); // LATAM/tiktok, in the fiscal year and the current quarter (ADR-038)
    // Its 200 goes back to what LATAM holds itself: the parent's node is refreshed with the leaf's.
    expect(await tree()).toEqual({ "": "1050.00", EMEA: "50.00", "EMEA/∅": "50.00", LATAM: "1000.00", "LATAM/∅": "700.00", "LATAM/meta": "300.00" });
    expect((await handleRollupEvent(app, body, TODAY)).outcome).toBe("duplicate");
  });

  it("a draft changes no cached measure: its event is skipped (T-034)", async () => {
    await withTenant(app, { workspaceId: ws, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `t022-${randomUUID()}` }, (tx) => outbox(tx, { workspaceId: ws, topic: "budget.changed", payload: { envelopeId: env["latamMeta"], kind: "draft" } }));
    const [row] = await asOwner((tx) => tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM outbox WHERE workspace_id = $1::uuid ORDER BY outbox.id DESC LIMIT 1`, ws));
    const body = { message: { data: Buffer.from(JSON.stringify({ envelopeId: env["latamMeta"], kind: "draft" })).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic: "budget.changed" }, messageId: `m-${row?.id}` }, subscription: "rollup-worker" };
    expect(await handleRollupEvent(app, body, TODAY)).toMatchObject({ outcome: "applied", templates: 0, upserted: 0, deleted: 0 });
  });

  it("a refresh leaves the cache equal to a full rebuild, in every measure and period (ADR-038)", async () => {
    const snapshot = async () =>
      (await asOwner((tx) => tx.$queryRawUnsafe<Array<{ k: string; m: unknown }>>(`SELECT period_start::text || '|' || node_path AS k, measures AS m FROM rollup_cache WHERE template_id = $1::uuid ORDER BY 1`, templateId))).map((r) => [r.k, r.m]);
    // A new leaf under a node that did not exist (EMEA/tiktok), and spend on an existing one.
    env["emeaTiktok"] = await envelope("EMEA tiktok", { region: "EMEA", platform: "tiktok" }, "70.00");
    // W0-5: every real write path ensures the month's partition first (packages/db/src/facts.ts);
    // this raw insert bypassed that, so it only ever passed by accident when some other test file
    // happened to have already created the 2026-05 partition first (non-deterministic file order).
    await withTenant(app, { workspaceId: ws, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `t022-${randomUUID()}` }, (tx) => ensurePartitions(tx, "2026-05-10", "2026-05-10"));
    await asOwner((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash)
         VALUES ($1::uuid, $2::uuid, '{}'::jsonb, '2026-05-10', 'USD', 12.34, 12.34, 'csv', $3::uuid, $4)`,
        ws, env["latamMeta"], randomUUID(), randomUUID(),
      ),
    );
    for (const envelopeId of [env["emeaTiktok"], env["latamMeta"]]) {
      await withTenant(app, { workspaceId: ws, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `t022-${randomUUID()}` }, (tx) => outbox(tx, { workspaceId: ws, topic: "budget.changed", payload: { envelopeId } }));
      const [row] = await asOwner((tx) => tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM outbox WHERE workspace_id = $1::uuid ORDER BY outbox.id DESC LIMIT 1`, ws));
      const body = { message: { data: Buffer.from(JSON.stringify({ envelopeId })).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic: "budget.changed" }, messageId: `m-${row?.id}` }, subscription: "rollup-worker" };
      expect((await handleRollupEvent(app, body, TODAY)).outcome).toBe("applied");
    }
    const refreshed = await snapshot();
    expect(await tree()).toEqual({ "": "1120.00", EMEA: "120.00", "EMEA/∅": "50.00", "EMEA/tiktok": "70.00", LATAM: "1000.00", "LATAM/∅": "700.00", "LATAM/meta": "300.00" });
    await rebuildWorkspace(app, { workspaceId: ws, orgId }, { today: TODAY, periods: [period] });
    expect(refreshed).toEqual(await snapshot());
  });

  it("a budget whose granularities change leaves its old path: the templates rebuild (product feedback 2026-09-28)", async () => {
    const id = env["emeaTiktok"] as string;
    // What PATCH /envelopes/:id does to the tuple: EMEA/tiktok becomes LATAM/tiktok.
    await asOwner(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE envelope SET dimension_values = dimension_values || '{"region":"LATAM"}'::jsonb WHERE id = $1::uuid`, id);
      await tx.$executeRawUnsafe(
        `UPDATE envelope_dimension ed SET value_id = v.id FROM dimension_value v WHERE ed.envelope_id = $1::uuid AND v.dimension_id = ed.dimension_id AND v.code = 'LATAM'`,
        id,
      );
    });
    const payload = { envelopeId: id, kind: "granularities" };
    await withTenant(app, { workspaceId: ws, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `t022-${randomUUID()}` }, (tx) => outbox(tx, { workspaceId: ws, topic: "budget.changed", payload }));
    const [row] = await asOwner((tx) => tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM outbox WHERE workspace_id = $1::uuid ORDER BY outbox.id DESC LIMIT 1`, ws));
    const body = { message: { data: Buffer.from(JSON.stringify(payload)).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic: "budget.changed" }, messageId: `m-${row?.id}` }, subscription: "rollup-worker" };
    expect(await handleRollupEvent(app, body, TODAY)).toMatchObject({ outcome: "applied", rebuilt: true });
    const t = await tree();
    expect(t["EMEA/tiktok"]).toBeUndefined();
    expect(t["LATAM/tiktok"]).toBe("70.00");
  });

  it("status-only events (approval.changed, period.closed / restated) refresh pendingCount to what a rebuild gives (ADR-044)", async () => {
    const snapshot = async () =>
      (await asOwner((tx) => tx.$queryRawUnsafe<Array<{ k: string; m: unknown }>>(`SELECT period_start::text || '|' || node_path AS k, measures AS m FROM rollup_cache WHERE template_id = $1::uuid ORDER BY 1`, templateId))).map((r) => [r.k, r.m]);
    const pending = async () =>
      Object.fromEntries(
        (
          await asOwner((tx) =>
            tx.$queryRawUnsafe<Array<{ p: string; n: number }>>(`SELECT node_path AS p, (measures->>'pendingCount')::int AS n FROM rollup_cache WHERE template_id = $1::uuid AND period_start = $2::date AND node_path IN ('', 'LATAM', 'LATAM/meta')`, templateId, period.start),
          )
        ).map((r) => [r.p, r.n]),
      );
    // The status write happens (as the API does it), then its single outbox row reaches the worker; the cache must equal a rebuild.
    const step = async (sql: string[], topic: string, payload: Record<string, unknown>) => {
      await asOwner(async (tx) => {
        for (const q of sql) await tx.$executeRawUnsafe(q);
      });
      await withTenant(app, { workspaceId: ws, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `t022-${randomUUID()}` }, (tx) => outbox(tx, { workspaceId: ws, topic, payload }));
      const [row] = await asOwner((tx) => tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM outbox WHERE workspace_id = $1::uuid ORDER BY outbox.id DESC LIMIT 1`, ws));
      const body = { message: { data: Buffer.from(JSON.stringify(payload)).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic }, messageId: `m-${row?.id}` }, subscription: "rollup-worker" };
      const r = await handleRollupEvent(app, body, TODAY);
      expect(r).toMatchObject({ outcome: "applied", rebuilt: false });
      expect(r.upserted).toBeGreaterThan(0);
      const refreshed = await snapshot();
      const counts = await pending();
      await rebuildWorkspace(app, { workspaceId: ws, orgId }, { today: TODAY, periods: [period] });
      expect(refreshed).toEqual(await snapshot());
      return counts;
    };
    const meta = env["latamMeta"] as string;
    const draft = randomUUID();
    const requestId = randomUUID();
    const closureId = randomUUID();
    const periodId = randomUUID();
    await asOwner((tx) => tx.$executeRawUnsafe(`INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by) VALUES ($1::uuid, $2::uuid, 2, 320, 320, 'DRAFT', $3::uuid)`, draft, meta, userId));
    expect(await pending()).toEqual({ "": 0, LATAM: 0, "LATAM/meta": 0 });

    // submit-version: version and envelope PENDING, one approval.changed row (action approval.requested).
    const submitted = await step(
      [
        `UPDATE envelope_version SET status = 'PENDING' WHERE id = '${draft}'`,
        `UPDATE envelope SET status = 'PENDING', draft_version_id = '${draft}' WHERE id = '${meta}'`,
        `INSERT INTO approval_request (id, workspace_id, entity_type, entity_id, policy_id, policy_version, policy_snapshot, summary, requested_by) VALUES ('${requestId}', '${ws}', 'envelope_version', '${draft}', '${randomUUID()}', 1, '{}'::jsonb, 't022', '${userId}')`,
      ],
      "approval.changed",
      { requestId, action: "approval.requested", versionId: draft, envelopeId: meta, status: "PENDING", step: 0 },
    );
    expect(submitted).toEqual({ "": 1, LATAM: 1, "LATAM/meta": 1 });

    // close-period locks it (prior status PENDING); restate gives PENDING back.
    const closed = await step(
      [
        `INSERT INTO fiscal_period (id, workspace_id, key, kind, start_date, end_date) VALUES ('${periodId}', '${ws}', 'FY26', 'year', '2026-01-01', '2026-12-31')`,
        `INSERT INTO period_closure (id, workspace_id, period_id, closed_by, registry_version, bq_table, variance_summary) VALUES ('${closureId}', '${ws}', '${periodId}', '${userId}', '{}'::jsonb, 't022', '{}'::jsonb)`,
        `INSERT INTO closure_envelope (closure_id, envelope_id, prior_status) SELECT '${closureId}', id, status FROM envelope WHERE workspace_id = '${ws}' AND status <> 'ARCHIVED'`,
        `UPDATE envelope SET status = 'LOCKED' WHERE workspace_id = '${ws}' AND status <> 'ARCHIVED'`,
      ],
      "period.closed",
      { closureId, periodId, periodKey: "FY26", lockedEnvelopes: 5 },
    );
    expect(closed).toEqual({ "": 0, LATAM: 0, "LATAM/meta": 0 });
    const restated = await step(
      [`UPDATE period_closure SET status = 'restated' WHERE id = '${closureId}'`, `UPDATE envelope e SET status = ce.prior_status FROM closure_envelope ce WHERE ce.closure_id = '${closureId}' AND e.id = ce.envelope_id`],
      "period.restated",
      { closureId, periodId, periodKey: "FY26", unlockedEnvelopes: 5, reason: "t022" },
    );
    expect(restated).toEqual({ "": 1, LATAM: 1, "LATAM/meta": 1 });

    // withdraw: the payload names only the request; the worker resolves its envelope.
    const withdrawn = await step(
      [
        `UPDATE envelope_version SET status = 'WITHDRAWN' WHERE id = '${draft}'`,
        `UPDATE envelope SET status = 'APPROVED', draft_version_id = NULL WHERE id = '${meta}'`,
        `UPDATE approval_request SET status = 'WITHDRAWN', resolved_at = now() WHERE id = '${requestId}'`,
      ],
      "approval.changed",
      { requestId, action: "approval.withdrawn", comment: null, status: "WITHDRAWN" },
    );
    expect(withdrawn).toEqual({ "": 0, LATAM: 0, "LATAM/meta": 0 });
  });

  it("a bulk change's request event refreshes nothing: the budget.changed written with it already did (S-003)", async () => {
    // A real bulk change over a real envelope: without the skip, its request event would refresh that path.
    const requestId = randomUUID();
    const versionId = randomUUID();
    const bulkChangeId = randomUUID();
    await asOwner(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by) VALUES ($1::uuid, $2::uuid, 3, 330, 330, 'PENDING', $3::uuid)`, versionId, env["latamMeta"], userId);
      await tx.$executeRawUnsafe(`INSERT INTO bulk_change (id, workspace_id, kind, version_ids, archive_ids, created_ids, created_by, payload) VALUES ($1::uuid, $2::uuid, 'edit', ARRAY[$3::uuid], '{}', '{}', $4::uuid, '{}'::jsonb)`, bulkChangeId, ws, versionId, userId);
      await tx.$executeRawUnsafe(`INSERT INTO approval_request (id, workspace_id, entity_type, entity_id, policy_id, policy_version, policy_snapshot, summary, requested_by) VALUES ($1::uuid, $2::uuid, 'bulk_change', $3::uuid, $4::uuid, 1, '{}'::jsonb, 's003', $5::uuid)`, requestId, ws, bulkChangeId, randomUUID(), userId);
    });
    const payload = { requestId, action: "approval.requested", bulkChangeId, status: "PENDING", step: 0 };
    await withTenant(app, { workspaceId: ws, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `s003-${randomUUID()}` }, (tx) => outbox(tx, { workspaceId: ws, topic: "approval.changed", payload }));
    const [row] = await asOwner((tx) => tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM outbox WHERE workspace_id = $1::uuid ORDER BY outbox.id DESC LIMIT 1`, ws));
    const body = { message: { data: Buffer.from(JSON.stringify(payload)).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic: "approval.changed" }, messageId: `m-${row?.id}` }, subscription: "rollup-worker" };
    expect(await handleRollupEvent(app, body, TODAY)).toMatchObject({ outcome: "applied", upserted: 0, rebuilt: false });
  });
});
