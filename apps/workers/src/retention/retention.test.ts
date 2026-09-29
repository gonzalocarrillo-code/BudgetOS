import "../test-support/env.js";
import { randomUUID } from "node:crypto";
import { ensurePartitions, factMonthTotals, withTenant, type MonthTotals } from "@budget/db";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../ingest/object-store.js";
import { pruneRawFiles, pruneWorkspaceFacts, retentionCutoff, runRetention, type ReplicaTotals } from "./retention.js";

/**
 * D-002 done-when (docs/DATA_PLAN.md §1): a month of facts leaves Postgres only once the replica
 * holds exactly the same rows and totals; months go oldest first and the job stops at the first
 * mismatch; another workspace's facts are never touched; the workspace records factsPrunedBefore;
 * each month pruned writes one audit and one outbox row. Raw uploads past their retention go,
 * except a file a source still reads.
 */
const url = (k: string) => process.env[k] ?? "";
const owner = new PrismaClient({ datasources: { db: { url: url("DATABASE_URL") } } });
const app = new PrismaClient({ datasources: { db: { url: url("APP_DATABASE_URL") } } });
const orgId = randomUUID();
const wsA = randomUUID();
const wsB = randomUUID();
const envA = randomUUID();
const envB = randomUUID();
const user = randomUUID();
const NOW = new Date("2026-09-28T12:00:00Z");
const ctx = (workspaceId: string) => ({ workspaceId, orgId, userId: null, isOrgAdmin: false, actorType: "system" as const, requestId: `t-${workspaceId}` });

async function spend(workspaceId: string, envelopeId: string, date: string, amount: string) {
  await owner.$executeRawUnsafe(
    `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash)
     VALUES ($1::uuid, $2::uuid, '{}', $3::date, 'USD', $4::numeric, $4::numeric, 'test', $5::uuid, $6)`,
    workspaceId, envelopeId, date, amount, randomUUID(), randomUUID(),
  );
}

/** The replica, read from Postgres itself; `tamper` makes one month differ. */
class PostgresReplica implements ReplicaTotals {
  tamper: string | null = null;
  async monthTotals(workspaceId: string, month: string): Promise<MonthTotals[]> {
    const t = await withTenant(app, ctx(workspaceId), (tx) => factMonthTotals(tx, workspaceId, month));
    return month === this.tamper ? t.map((x) => (x.table === "spend_fact" ? { ...x, rows: x.rows - 1 } : x)) : t;
  }
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "retention" } });
  for (const [id, slug] of [[wsA, "a"], [wsB, "b"]] as const) await owner.workspace.create({ data: { id, orgId, slug: `retention-${slug}-${id}`, name: `Retention ${slug}`, reportingCurrency: "USD" } });
  await owner.user.create({ data: { id: user, orgId, email: `${user}@retention.test`, name: "r", googleSub: user } });
  for (const [id, ws] of [[envA, wsA], [envB, wsB]] as const) {
    await owner.$executeRawUnsafe(
      `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at) VALUES ($1::uuid, $2::uuid, 'e', '{}', '2024-01-01', '2026-12-31', 'USD', 'APPROVED', $3::uuid, now())`,
      id, ws, user,
    );
  }
  await withTenant(owner, ctx(wsA), (tx) => ensurePartitions(tx, "2024-01-01", "2025-12-01"));
  for (const [d, a] of [["2024-01-10", "100.00"], ["2024-01-20", "50.00"], ["2024-02-05", "70.00"], ["2025-09-03", "30.00"]] as const) await spend(wsA, envA, d, a);
  await spend(wsB, envB, "2024-01-15", "999.00");
});

afterAll(async () => {
  for (const t of ["spend_fact", "spend_month", "outbox", "data_source", "envelope"]) await owner.$executeRawUnsafe(`DELETE FROM ${t} WHERE workspace_id = ANY($1::uuid[])`, [wsA, wsB]);
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

const monthsLeft = async (workspaceId: string) =>
  (await owner.$queryRawUnsafe<Array<{ m: string }>>(`SELECT DISTINCT to_char(period_date, 'YYYY-MM') AS m FROM spend_fact WHERE workspace_id = $1::uuid ORDER BY 1`, workspaceId)).map((r) => r.m);

describe("fact retention (D-002)", () => {
  it("keeps 13 months: the cutoff is the first day of the month 12 months before this one", () => {
    expect(retentionCutoff(NOW)).toBe("2025-09-01");
    expect(retentionCutoff(new Date("2026-01-01T00:00:00Z"))).toBe("2025-01-01");
  });

  it("a mismatch on the oldest month keeps everything, and says what differs", async () => {
    const replica = new PostgresReplica();
    replica.tamper = "2024-01-01";
    const r = await pruneWorkspaceFacts(app, { workspaceId: wsA, orgId }, replica, { now: NOW });
    expect(r.pruned).toEqual([]);
    expect(r.held?.month).toBe("2024-01-01");
    expect(r.held?.postgres.find((x) => x.table === "spend_fact")).toMatchObject({ rows: 2, amount: "150.00" });
    expect(await monthsLeft(wsA)).toEqual(["2024-01", "2024-02", "2025-09"]);
  });

  it("prunes month by month once the replica matches, stops at the first mismatch, touches no other workspace", async () => {
    const replica = new PostgresReplica();
    replica.tamper = "2024-02-01";
    const first = await pruneWorkspaceFacts(app, { workspaceId: wsA, orgId }, replica, { now: NOW });
    expect(first.pruned.map((p) => p.month)).toEqual(["2024-01-01"]);
    expect(first.held?.month).toBe("2024-02-01");
    expect(await monthsLeft(wsA)).toEqual(["2024-02", "2025-09"]);
    const settings = (await owner.workspace.findUniqueOrThrow({ where: { id: wsA } })).settings as { factsPrunedBefore?: string };
    expect(settings.factsPrunedBefore).toBe("2024-02-01");

    replica.tamper = null;
    const second = await pruneWorkspaceFacts(app, { workspaceId: wsA, orgId }, replica, { now: NOW });
    expect(second.pruned.map((p) => p.month)).toEqual(["2024-02-01"]);
    expect(await monthsLeft(wsA)).toEqual(["2025-09"]); // the hot month stays
    expect(((await owner.workspace.findUniqueOrThrow({ where: { id: wsA } })).settings as { factsPrunedBefore?: string }).factsPrunedBefore).toBe("2024-03-01");
    expect(await monthsLeft(wsB)).toEqual(["2024-01"]); // never pruned by A's run

    const audits = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE workspace_id = $1::uuid AND action = 'facts.pruned'`, wsA);
    const out = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'facts.pruned'`, wsA);
    expect([Number(audits[0]?.n), Number(out[0]?.n)]).toEqual([2, 2]);
  });

  it("does nothing unless enabled, and never prunes facts without a replica", async () => {
    const store = new MemoryObjectStore();
    expect(await runRetention(app, [orgId], { enabled: false, replica: new PostgresReplica(), store, now: NOW })).toEqual({ facts: [], files: [] });
    const r = await runRetention(app, [orgId], { enabled: true, replica: null, store, now: NOW });
    expect(r.facts).toEqual([]);
    expect(await monthsLeft(wsB)).toEqual(["2024-01"]);
  });
});

describe("raw file retention (D-002)", () => {
  it("removes uploads older than the workspace's retention, keeps recent ones and files a source still reads", async () => {
    const store = new MemoryObjectStore();
    const prefix = `gs://budget-os-uploads/uploads/${wsA}/`;
    const put = async (name: string, daysAgo: number) => {
      await store.write(`${prefix}${name}`, "a,b\n1,2\n", "text/csv");
      (store.objects.get(`${prefix}${name}`) as { updated?: Date }).updated = new Date(NOW.getTime() - daysAgo * 86_400_000);
    };
    await put("old.csv", 500);
    await put("in-use.csv", 500);
    await put("recent.csv", 10);
    await store.write(`gs://budget-os-uploads/uploads/${wsB}/other.csv`, "x", "text/csv");
    (store.objects.get(`gs://budget-os-uploads/uploads/${wsB}/other.csv`) as { updated?: Date }).updated = new Date(0);
    await owner.dataSource.create({ data: { id: randomUUID(), workspaceId: wsA, kind: "csv", name: "keeps its file", config: { kind: "csv", uri: `${prefix}in-use.csv` }, mapping: {} } });

    const r = await pruneRawFiles(app, { workspaceId: wsA, orgId }, store, { now: NOW, bucket: "budget-os-uploads" });
    expect(r.removed).toEqual([`${prefix}old.csv`]);
    expect([...store.objects.keys()].sort()).toEqual([`${prefix}in-use.csv`, `${prefix}recent.csv`, `gs://budget-os-uploads/uploads/${wsB}/other.csv`].sort());

    await owner.workspace.update({ where: { id: wsA }, data: { settings: { ...((await owner.workspace.findUniqueOrThrow({ where: { id: wsA } })).settings as object), rawFileRetentionDays: 5 } } });
    expect((await pruneRawFiles(app, { workspaceId: wsA, orgId }, store, { now: NOW, bucket: "budget-os-uploads" })).removed).toEqual([`${prefix}recent.csv`]);
  });
});
