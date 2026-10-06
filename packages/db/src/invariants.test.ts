import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AssignRoleInput, SavedViewVisibility } from "@budget/domain";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type TenantContext } from "./tenant.js";

/**
 * W3-11 (audit I-32, I-34, I-35, I-37, I-38; docs/STACK_HARDENING_PLAN.md): one case per
 * constraint class proving the database itself now refuses the violation, not just the
 * application. Each `it` is independent (its own ids) so failures do not cascade.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  const contents = readFileSync(path, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv(join(packageRoot, ".env"));

const ownerUrl = process.env["DATABASE_URL"] ?? "postgresql://budget:budget@localhost:5432/budget";
const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });

const orgId = randomUUID();
const workspaceId = randomUUID();
const userId = randomUUID();
const ctx: TenantContext = { workspaceId, orgId, userId, isOrgAdmin: false, actorType: "user", requestId: "invariants-test" };
const adminCtx: TenantContext = { ...ctx, isOrgAdmin: true };

const START = new Date("2026-01-01T00:00:00Z");
const END = new Date("2026-12-31T00:00:00Z");

let fiscalPeriodId: string;
let dataSourceId: string;

beforeAll(async () => {
  await withTenant(owner, adminCtx, async (tx) => {
    await tx.organization.create({ data: { id: orgId, name: "W3-11 invariants" } });
    await tx.workspace.create({ data: { id: workspaceId, orgId, slug: `invariants-${workspaceId.slice(0, 8)}`, name: "Invariants", reportingCurrency: "USD" } });
    await tx.user.create({ data: { id: userId, orgId, email: `${userId}@invariants.test`, name: "Invariants Tester" } });
  });
  fiscalPeriodId = randomUUID();
  dataSourceId = randomUUID();
  await withTenant(owner, ctx, async (tx) => {
    await tx.fiscalPeriod.create({ data: { id: fiscalPeriodId, workspaceId, key: "2026-FY", kind: "year", startDate: START, endDate: END } });
    await tx.dataSource.create({ data: { id: dataSourceId, workspaceId, kind: "csv", name: "fixture", config: {}, mapping: {} } });
  });
}, 30_000);

afterAll(async () => {
  await withTenant(owner, ctx, async (tx) => {
    await tx.ingestRun.deleteMany({ where: { sourceId: dataSourceId } });
    await tx.dataSource.deleteMany({ where: { id: dataSourceId } });
    // period_closure.status test creates its own fiscal_period per status, not only the fixture's.
    await tx.periodClosure.deleteMany({ where: { workspaceId } });
    await tx.fiscalPeriod.deleteMany({ where: { workspaceId } });
    await tx.savedView.deleteMany({ where: { workspaceId } });
    await tx.roleAssignment.deleteMany({ where: { workspaceId } });
    await tx.approvalDecision.deleteMany({ where: { request: { workspaceId } } });
    await tx.approvalRequest.deleteMany({ where: { workspaceId } });
    await tx.target.deleteMany({ where: { workspaceId } });
    await tx.thread.deleteMany({ where: { workspaceId } });
    await tx.envelopeLineage.deleteMany({ where: { workspaceId } });
    await tx.envelope.deleteMany({ where: { workspaceId } });
  });
  await withTenant(owner, adminCtx, async (tx) => {
    await tx.workspace.deleteMany({ where: { id: workspaceId } });
    await tx.user.deleteMany({ where: { id: userId } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await owner.$disconnect();
});

describe("foreign keys (audit I-32)", () => {
  it("a tenant table's workspace_id must reference an existing workspace", async () => {
    const bogusWorkspace = randomUUID();
    const bogusCtx: TenantContext = { ...ctx, workspaceId: bogusWorkspace };
    await expect(
      withTenant(owner, bogusCtx, (tx) =>
        tx.envelope.create({ data: { id: randomUUID(), workspaceId: bogusWorkspace, name: "orphan", dimensionValues: {}, startDate: START, endDate: END, currency: "USD", createdBy: userId } }),
      ),
    ).rejects.toThrow(/envelope_workspace_id_fkey|violates foreign key constraint/i);
  });

  it("RESTRICT on envelope.parent_id: a parent with a child cannot be deleted directly (the previous ON DELETE SET NULL would have silently reparented the child)", async () => {
    const parentId = randomUUID();
    const childId = randomUUID();
    await withTenant(owner, ctx, async (tx) => {
      await tx.envelope.create({ data: { id: parentId, workspaceId, name: "parent", dimensionValues: {}, startDate: START, endDate: END, currency: "USD", createdBy: userId } });
      await tx.envelope.create({ data: { id: childId, workspaceId, parentId, name: "child", dimensionValues: {}, startDate: START, endDate: END, currency: "USD", createdBy: userId } });
    });
    await expect(withTenant(owner, ctx, (tx) => tx.envelope.delete({ where: { id: parentId } }))).rejects.toThrow(/envelope_parent_id_fkey|violates foreign key constraint/i);
    // The workspace purge nulls parentId first (apps/workers/src/purge/purge.ts); doing the same
    // here proves that is the correct unblocking move, then cleans up.
    await withTenant(owner, ctx, async (tx) => {
      await tx.envelope.update({ where: { id: childId }, data: { parentId: null } });
      await tx.envelope.delete({ where: { id: childId } });
      await tx.envelope.delete({ where: { id: parentId } });
    });
  });
});

describe("CHECK constraints (audit I-34)", () => {
  it("date order: envelope.end_date must be >= start_date", async () => {
    await expect(
      withTenant(owner, ctx, (tx) =>
        tx.envelope.create({ data: { id: randomUUID(), workspaceId, name: "backwards", dimensionValues: {}, startDate: END, endDate: START, currency: "USD", createdBy: userId } }),
      ),
    ).rejects.toThrow(/envelope_date_order_check|violates check constraint/i);
  });

  it("currency shape: envelope.currency must be three uppercase letters", async () => {
    await expect(
      withTenant(owner, ctx, (tx) =>
        tx.envelope.create({ data: { id: randomUUID(), workspaceId, name: "lowercase-currency", dimensionValues: {}, startDate: START, endDate: END, currency: "usd", createdBy: userId } }),
      ),
    ).rejects.toThrow(/envelope_currency_check|violates check constraint/i);
  });

  it("status enum: saved_view.visibility accepts every @budget/domain SavedViewVisibility value and refuses a bogus one", async () => {
    await withTenant(owner, ctx, async (tx) => {
      for (const visibility of SavedViewVisibility.options) {
        await tx.savedView.create({ data: { id: randomUUID(), workspaceId, name: `view-${visibility}`, screen: "explorer", definition: {}, visibility, createdBy: userId } });
      }
    });
    await expect(
      withTenant(owner, ctx, (tx) =>
        tx.savedView.create({ data: { id: randomUUID(), workspaceId, name: "bogus-visibility", screen: "explorer", definition: {}, visibility: "public", createdBy: userId } }),
      ),
    ).rejects.toThrow(/saved_view_visibility_check|violates check constraint/i);
  });

  it("status enum: role_assignment.principal_type accepts every @budget/domain AssignRoleInput value and refuses a bogus one", async () => {
    const principalTypes = AssignRoleInput.shape.principalType.options;
    await withTenant(owner, ctx, async (tx) => {
      for (const principalType of principalTypes) {
        await tx.roleAssignment.create({ data: { id: randomUUID(), workspaceId, principalType, principalId: randomUUID(), role: "VIEWER", createdBy: userId } });
      }
    });
    await expect(
      withTenant(owner, ctx, (tx) =>
        tx.roleAssignment.create({ data: { id: randomUUID(), workspaceId, principalType: "robot", principalId: randomUUID(), role: "VIEWER", createdBy: userId } }),
      ),
    ).rejects.toThrow(/role_assignment_principal_type_check|violates check constraint/i);
  });

  it("status enum: approval_decision.decision accepts every @budget/domain DecideInput value plus 'external_evidence', and refuses a bogus one", async () => {
    const requestId = randomUUID();
    await withTenant(owner, ctx, (tx) =>
      tx.approvalRequest.create({
        data: { id: requestId, workspaceId, entityType: "envelope_version", entityId: randomUUID(), policyId: randomUUID(), policyVersion: 1, policySnapshot: {}, summary: "fixture", requestedBy: userId },
      }),
    );
    // DecideInput (packages/domain/src/approvals.ts:55-62) is a ZodEffects (.refine()-wrapped), so
    // its enum isn't reachable via .shape; the three values are copied from its definition.
    // 'external_evidence' is a fourth value external-evidence.ts writes outside that zod schema.
    const decisions = ["approve", "reject", "request_changes", "external_evidence"] as const;
    await withTenant(owner, ctx, async (tx) => {
      // W3-3 (audit I-18): a distinct decidedBy per row -- approval_decision_request_step_decider
      // (one decision per decider per step) would otherwise refuse every row after the first here.
      for (const decision of decisions) {
        await tx.approvalDecision.create({ data: { id: randomUUID(), requestId, stepIndex: 0, decidedBy: randomUUID(), decision } });
      }
    });
    await expect(withTenant(owner, ctx, (tx) => tx.approvalDecision.create({ data: { id: randomUUID(), requestId, stepIndex: 0, decidedBy: userId, decision: "shrug" } }))).rejects.toThrow(
      /approval_decision_decision_check|violates check constraint/i,
    );
    await withTenant(owner, ctx, async (tx) => {
      await tx.approvalDecision.deleteMany({ where: { requestId } });
      await tx.approvalRequest.delete({ where: { id: requestId } });
    });
  });

  it("status enum: thread.status is open | resolved only", async () => {
    await withTenant(owner, ctx, async (tx) => {
      await tx.thread.create({ data: { id: randomUUID(), workspaceId, anchorType: "envelope", anchorId: randomUUID(), status: "open", createdBy: userId } });
      await tx.thread.create({ data: { id: randomUUID(), workspaceId, anchorType: "envelope", anchorId: randomUUID(), status: "resolved", createdBy: userId } });
    });
    await expect(
      withTenant(owner, ctx, (tx) => tx.thread.create({ data: { id: randomUUID(), workspaceId, anchorType: "envelope", anchorId: randomUUID(), status: "archived", createdBy: userId } })),
    ).rejects.toThrow(/thread_status_check|violates check constraint/i);
  });

  it("status enum: envelope_lineage.kind is move | split | merge | continues only (structure.ts, get-envelope.ts)", async () => {
    await withTenant(owner, ctx, (tx) =>
      tx.envelopeLineage.create({ data: { id: randomUUID(), workspaceId, fromEnvelopeId: randomUUID(), toEnvelopeId: randomUUID(), kind: "continues", actorId: userId } }),
    );
    await expect(
      withTenant(owner, ctx, (tx) => tx.envelopeLineage.create({ data: { id: randomUUID(), workspaceId, fromEnvelopeId: randomUUID(), toEnvelopeId: randomUUID(), kind: "teleport", actorId: userId } })),
    ).rejects.toThrow(/envelope_lineage_kind_check|violates check constraint/i);
  });

  it("status enum: target.status is 'active' only (nothing in the codebase ever writes another value — create-target.ts, target-writer.ts)", async () => {
    await withTenant(owner, ctx, (tx) =>
      tx.target.create({ data: { id: randomUUID(), workspaceId, scopeType: "filter", scopeFilter: {}, metricKey: "cpa", startDate: START, endDate: END, status: "active" } }),
    );
    await expect(
      withTenant(owner, ctx, (tx) => tx.target.create({ data: { id: randomUUID(), workspaceId, scopeType: "filter", scopeFilter: {}, metricKey: "cpa", startDate: START, endDate: END, status: "paused" } })),
    ).rejects.toThrow(/target_status_check|violates check constraint/i);
  });

  it("status enum: ingest_run.status is queued | running | ok | failed (pipeline.ts, worker.ts)", async () => {
    // W3-3 (audit I-19): ingest_run_source_open_run (at most one queued-or-running row per source)
    // would otherwise refuse 'running' right after 'queued' for the same fixture source; clear each
    // open row before the next so this test only has to prove the status CHECK, not coexistence.
    await withTenant(owner, ctx, async (tx) => {
      for (const status of ["queued", "running", "ok", "failed"] as const) {
        const id = randomUUID();
        await tx.ingestRun.create({ data: { id, sourceId: dataSourceId, status } });
        if (status === "queued" || status === "running") await tx.ingestRun.delete({ where: { id } });
      }
    });
    await expect(withTenant(owner, ctx, (tx) => tx.ingestRun.create({ data: { id: randomUUID(), sourceId: dataSourceId, status: "paused" } }))).rejects.toThrow(
      /ingest_run_status_check|violates check constraint/i,
    );
  });

  it("status enum: period_closure.status is closing | closed | failed | restated (W3-1, close-period.ts, fail-closure.ts, restate.ts)", async () => {
    // period_closure_one_closed (migration 20261010030000) allows at most one row with status
    // IN ('closing', 'closed') per (workspace_id, period_id) — a real, independent invariant, not
    // one this test is about — so each status here gets its own fiscal_period to avoid tripping it.
    await withTenant(owner, ctx, async (tx) => {
      let i = 0;
      for (const status of ["closing", "closed", "failed", "restated"] as const) {
        const periodId = randomUUID();
        await tx.fiscalPeriod.create({ data: { id: periodId, workspaceId, key: `2026-status-${status}`, kind: "year", startDate: START, endDate: END } });
        await tx.periodClosure.create({
          data: { id: randomUUID(), workspaceId, periodId, status, closedBy: userId, registryVersion: {}, bqTable: `t${i++}`, varianceSummary: {} },
        });
      }
    });
    await expect(
      withTenant(owner, ctx, (tx) =>
        tx.periodClosure.create({ data: { id: randomUUID(), workspaceId, periodId: fiscalPeriodId, status: "open", closedBy: userId, registryVersion: {}, bqTable: "bogus", varianceSummary: {} } }),
      ),
    ).rejects.toThrow(/period_closure_status_check|violates check constraint/i);
  });
});

describe("NOT NULL (audit I-35)", () => {
  it("outbox.workspace_id cannot be null (a NULL row could never be published — ADR-010)", async () => {
    await expect(withTenant(owner, adminCtx, (tx) => tx.$executeRaw`INSERT INTO outbox (workspace_id, topic, payload) VALUES (NULL, 'test.topic', '{}'::jsonb)`)).rejects.toThrow(
      /23502|null value in column "workspace_id"|violates not-null constraint/i, // 23502 = Postgres not_null_violation
    );
  });
});

describe("partition coverage (audit I-37)", () => {
  // No DEFAULT partition (tried in this migration and reverted): PostgreSQL 16 takes an ACCESS
  // EXCLUSIVE lock on a DEFAULT partition, and scans it, every time a sibling range partition is
  // attached, which deadlocked concurrent partition creation against ordinary readers (the W3-10
  // deadlock class). ensure_fact_partitions keeps month partitions six months ahead instead
  // (migrate time, the ingest pipeline, the pacing evaluator, and local-runner.ts's daily
  // partitionPass — all calling this same function); this proves a fact five months out, which
  // none of the golden seed's fixed dates would otherwise cover, inserts cleanly right after it.
  it("a fact dated five months ahead inserts fine once ensure_fact_partitions has covered that month", async () => {
    const target = new Date();
    target.setUTCMonth(target.getUTCMonth() + 5, 15);
    const periodDate = target.toISOString().slice(0, 10);
    const expectedPartition = `spend_fact_${target.getUTCFullYear()}${String(target.getUTCMonth() + 1).padStart(2, "0")}`;
    await owner.$executeRaw`SELECT ensure_fact_partitions(CURRENT_DATE, 6)`;
    const hash = randomUUID();
    await withTenant(owner, ctx, (tx) => tx.$executeRaw`
      INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash)
      VALUES (${workspaceId}::uuid, NULL, '{}'::jsonb, ${periodDate}::date, 'USD', 1.00, 1.00, 'invariants-test', ${randomUUID()}::uuid, ${hash})
    `);
    const rows = await withTenant(owner, ctx, (tx) => tx.$queryRaw<Array<{ partition: string }>>`
      SELECT (SELECT relname FROM pg_class WHERE oid = s.tableoid) AS partition FROM spend_fact s WHERE source_row_hash = ${hash}
    `);
    expect(rows[0]?.partition).toBe(expectedPartition);
    await withTenant(owner, ctx, (tx) => tx.$executeRaw`DELETE FROM spend_fact WHERE source_row_hash = ${hash}`);
  });
});
