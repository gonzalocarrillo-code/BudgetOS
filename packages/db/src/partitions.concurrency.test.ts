import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ensurePartitions, upsertKpiFacts, upsertSpendFacts } from "./facts.js";
import { audit, outbox } from "./sql.js";
import { withTenant, type TenantContext } from "./tenant.js";
import { dropFactPartitionsForTests } from "./test-support/partitions.js";

/**
 * W3-10: month-partition creation must not deadlock concurrent writers or readers. CI hit `40P01`
 * when ensure_fact_partitions created a month (CREATE TABLE ... PARTITION OF takes ACCESS EXCLUSIVE
 * on each of the four parents in turn) inside a transaction while other sessions held, and then
 * asked for, ordinary locks on those parents. Each attempt here is a realistic tenant write — audit
 * + outbox, a read of the fact tables, then a new month's partitions and a fact in it — run
 * 4 writers × 5 attempts at once, next to a reader that holds every parent the way the BigQuery
 * view check (bigquery-views.test.ts) does. Every attempt creates a month nobody has created yet.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const line of existsSync(join(packageRoot, ".env")) ? readFileSync(join(packageRoot, ".env"), "utf8").split("\n") : []) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m?.[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const owner = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
const app = new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });

const WRITERS = 4;
const ATTEMPTS = 5;
const PARENTS = ["spend_fact", "kpi_fact", "projection_fact", "audit_event"] as const;
const orgId = randomUUID();
const workspaceId = randomUUID();
const ctx: TenantContext = { workspaceId, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: "w3-10" };

/**
 * Months nobody has created: the test needs every attempt to create one. They are drawn from
 * 2000–2019 and 2090–2099, which no data and no other suite uses (rls.org-admin draws from
 * 2040–2089), and dropped afterwards (dropFactPartitionsForTests: lock_timeout, never a deadlock).
 */
let months: string[] = [];
const suffix = (month: string) => month.slice(0, 4) + month.slice(5, 7);

beforeAll(async () => {
  const candidates = [...Array.from({ length: 240 }, (_, n) => 2000 * 12 + n), ...Array.from({ length: 120 }, (_, n) => 2090 * 12 + n)].map(
    (n) => `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}-01`,
  );
  const existing = await owner.$queryRaw<Array<{ relname: string }>>`
    SELECT c.relname FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE parent.relname = 'spend_fact'`;
  const taken = new Set(existing.map((r) => r.relname));
  const fresh = candidates.filter((m) => !taken.has(`spend_fact_${suffix(m)}`)).sort(() => Math.random() - 0.5);
  if (fresh.length < WRITERS * ATTEMPTS) throw new Error("No unused test months left in this database");
  months = fresh.slice(0, WRITERS * ATTEMPTS);
  await owner.$executeRaw`INSERT INTO organization (id, name) VALUES (${orgId}::uuid, 'W3-10 partitions')`;
  await owner.$executeRaw`INSERT INTO workspace (id, org_id, slug, name, reporting_currency) VALUES (${workspaceId}::uuid, ${orgId}::uuid, ${`w3-10-${workspaceId}`}, 'W3-10', 'USD')`;
}, 60_000);

afterAll(async () => {
  // The test months' facts go with their partitions; then the FK-safe order of tenant.isolation.test.ts.
  await dropFactPartitionsForTests(owner, months.map(suffix));
  await owner.$executeRaw`DELETE FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid`;
  await owner.$executeRaw`DELETE FROM kpi_fact WHERE workspace_id = ${workspaceId}::uuid`;
  await owner.$executeRaw`DELETE FROM outbox WHERE workspace_id = ${workspaceId}::uuid`;
  await owner.$executeRaw`ALTER TABLE audit_event DISABLE TRIGGER audit_event_immutable`;
  await owner.$executeRaw`DELETE FROM audit_event WHERE workspace_id = ${workspaceId}::uuid`;
  await owner.$executeRaw`ALTER TABLE audit_event ENABLE TRIGGER audit_event_immutable`;
  await owner.$executeRaw`DELETE FROM workspace WHERE id = ${workspaceId}::uuid`;
  await owner.$executeRaw`DELETE FROM organization WHERE id = ${orgId}::uuid`;
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
}, 120_000);

const sqlState = (error: unknown): string | null => {
  const e = error as { code?: unknown; meta?: { code?: unknown } };
  if (typeof e.meta?.code === "string") return e.meta.code;
  return typeof e.code === "string" ? e.code : null;
};

it("4 writers × 5 attempts, each creating a new month's partitions inside its write, never deadlock", async () => {
  const failures: Array<{ month: string; code: string | null; message: string }> = [];
  let writing = true;

  const write = async (month: string) => {
    try {
      await withTenant(
        app,
        ctx,
        async (tx) => {
          await audit(tx, { workspaceId, actorId: null, actorType: "system", action: "w3_10.write", entityType: "workspace", entityId: workspaceId, after: { month }, requestId: ctx.requestId });
          await outbox(tx, { workspaceId, topic: "facts.loaded", payload: { sourceSystem: "w3-10", month } });
          await tx.$queryRaw`SELECT count(*) FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid`;
          await tx.$queryRaw`SELECT count(*) FROM kpi_fact WHERE workspace_id = ${workspaceId}::uuid`;
          await ensurePartitions(tx, month, month);
          const load = { workspaceId, sourceSystem: "w3-10", sourceRunId: randomUUID() };
          await upsertSpendFacts(tx, load, [{ dimensionValues: {}, periodDate: month, currency: "USD", amount: "10.00", amountReporting: "10.00", fxRateId: null, rowHash: `w3-10:${month}` }]);
          await upsertKpiFacts(tx, load, [{ dimensionValues: {}, periodDate: month, metric: "conversions", value: "1", attributionModel: null, rowHash: `w3-10:${month}:conversions` }]);
        },
        { timeoutMs: 60_000 },
      );
    } catch (error) {
      failures.push({ month, code: sqlState(error), message: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
  };

  // A long reader over every parent, in a different order from the writers (kpi before spend, audit
  // last), as bigquery-views.test.ts's temp views do.
  const read = async () => {
    while (writing) {
      try {
        await owner.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT count(*) FROM kpi_fact WHERE workspace_id = ${workspaceId}::uuid`;
          await tx.$executeRaw`SELECT pg_sleep(0.02)`;
          await tx.$queryRaw`SELECT count(*) FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid`;
          await tx.$queryRaw`SELECT count(*) FROM projection_fact WHERE workspace_id = ${workspaceId}::uuid`;
          await tx.$queryRaw`SELECT count(*) FROM audit_event WHERE workspace_id = ${workspaceId}::uuid`;
        });
      } catch (error) {
        failures.push({ month: "reader", code: sqlState(error), message: error instanceof Error ? error.message.slice(0, 300) : String(error) });
      }
    }
  };

  const reader = read();
  await Promise.all(
    Array.from({ length: WRITERS }, async (_, w) => {
      for (let a = 0; a < ATTEMPTS; a += 1) await write(months[w * ATTEMPTS + a] as string);
    }),
  );
  writing = false;
  await reader;

  expect(failures.filter((f) => f.code === "40P01")).toEqual([]);
  expect(failures).toEqual([]);
  // Every attempt really created its month (all four parents) and its fact landed there.
  for (const month of months) {
    const created = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid WHERE c.relname = ANY($1::text[])`,
      PARENTS.map((p) => `${p}_${suffix(month)}`),
    );
    expect(Number(created[0]?.n), month).toBe(PARENTS.length);
  }
  const facts = await owner.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid`;
  expect(Number(facts[0]?.n)).toBe(WRITERS * ATTEMPTS);
}, 120_000);
