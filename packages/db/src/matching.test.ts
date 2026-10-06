import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePartitions, matchFacts, matchRunFacts } from "./facts.js";
import { matchCoverage } from "./match-coverage.js";
import { asOrgAdmin, withTenant, type TenantContext } from "./tenant.js";
import type { Tx } from "./sql.js";

/**
 * EX-1 (ADR-0085): every fact lands on exactly one budget, or is visibly unassigned or ambiguous.
 * Order: manual pin > match rules > tuple; a tie at the deciding level is `ambiguous` (never an
 * arbitrary pick by id). Matching and coverage run as budget_app under RLS.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i === -1) continue;
    const key = trimmed.slice(0, i).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(i + 1).trim();
  }
}
loadEnv(join(packageRoot, ".env"));

const owner = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
const app = new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });
const orgId = randomUUID();
const ws = randomUUID();
const otherWs = randomUUID();
const userId = randomUUID();
const runId = randomUUID();
const env: Record<string, string> = {};
const ctx = (workspaceId = ws): TenantContext => ({ workspaceId, orgId, userId, isOrgAdmin: false, actorType: "user", requestId: `ex1-${randomUUID()}` });
const asApp = <T>(fn: (tx: Tx) => Promise<T>, workspaceId = ws) => withTenant(app, ctx(workspaceId), fn);
const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, orgId);

async function envelope(name: string, dims: Record<string, string>, workspaceId = ws, parentId: string | null = null): Promise<string> {
  const id = randomUUID();
  await asOwner((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at, parent_id)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $5::uuid, now(), $6::uuid)`,
      id,
      workspaceId,
      name,
      JSON.stringify(dims),
      userId,
      parentId,
    ),
  );
  env[name] = id;
  return id;
}
let seq = 0;
async function fact(dims: Record<string, string>, amount: string, opts: { date?: string; envelopeId?: string; method?: string; superseded?: boolean; run?: string } = {}): Promise<string> {
  const id = randomUUID();
  await asOwner((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO spend_fact (id, workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, natural_key, match_method, superseded_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::date, 'USD', $6::numeric, $6::numeric, 'test', $7::uuid, $8, $8, $9, $10::timestamptz)`,
      id,
      ws,
      opts.envelopeId ?? null,
      JSON.stringify(dims),
      opts.date ?? "2026-03-01",
      amount,
      opts.run ?? runId,
      `ex1-${++seq}-${id}`,
      opts.method ?? null,
      opts.superseded ? new Date().toISOString() : null,
    ),
  );
  return id;
}
async function rule(envelopeId: string, predicate: unknown, dates: { start?: string; end?: string } = {}, workspaceId = ws): Promise<string> {
  const id = randomUUID();
  await asOwner((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO match_rule (id, workspace_id, envelope_id, predicate, start_date, end_date, created_by) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::date, $6::date, $7::uuid)`,
      id,
      workspaceId,
      envelopeId,
      JSON.stringify(predicate),
      dates.start ?? null,
      dates.end ?? null,
      userId,
    ),
  );
  return id;
}
const campaignIs = (c: string) => ({ logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "eq", value: c }] });
const state = async (id: string) =>
  (
    await asOwner((tx) =>
      tx.$queryRawUnsafe<Array<{ envelope_id: string | null; match_method: string | null; match_status: string | null; match_candidates: string[] | null }>>(
        `SELECT envelope_id::text, match_method, match_status, match_candidates::text[] FROM spend_fact WHERE id = $1::uuid`,
        id,
      ),
    )
  )[0];

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "ex1" } });
  await asOwner((tx) => tx.workspace.createMany({ data: [ws, otherWs].map((id) => ({ id, orgId, slug: `ex1-${id}`, name: "EX-1", reportingCurrency: "USD" })) }));
  await owner.user.create({ data: { id: userId, orgId, email: `${userId}@ex1.test`, name: "EX-1", googleSub: `g-${userId}` } });
  await ensurePartitions(owner, "2026-01-01", "2026-12-31");
  await envelope("mx1", { country: "MX" });
  await envelope("mx2", { country: "MX" });
  await envelope("brMeta", { country: "BR", platform: "meta" });
  await envelope("ruleTarget", { country: "AR" });
  await envelope("ruleTarget2", { country: "CL" });
  // A chain with identical tuples (parent > child > grandchild) and two siblings with identical tuples.
  await envelope("peParent", { country: "PE" });
  await envelope("peChild", { country: "PE" }, ws, env["peParent"]);
  await envelope("peGrandchild", { country: "PE" }, ws, env["peChild"]);
  await envelope("coParent", { country: "UY" });
  await envelope("coA", { country: "CO" }, ws, env["coParent"]);
  await envelope("coB", { country: "CO" }, ws, env["coParent"]);
});

afterAll(async () => {
  await asOwner(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE envelope SET parent_id = NULL WHERE workspace_id = ANY($1::uuid[])`, [ws, otherWs]);
    for (const t of ["match_rule", "spend_fact", "kpi_fact", "projection_fact", "envelope"]) await tx.$executeRawUnsafe(`DELETE FROM ${t} WHERE workspace_id = ANY($1::uuid[])`, [ws, otherWs]);
    await tx.$executeRawUnsafe(`DELETE FROM workspace WHERE id = ANY($1::uuid[])`, [ws, otherWs]);
  });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("EX-1 matching order", () => {
  it("a tie at the top tuple rank is ambiguous with both candidates, never an arbitrary pick", async () => {
    const f = await fact({ country: "MX", platform: "google" }, "10.00");
    await asApp((tx) => matchRunFacts(tx, ws, runId));
    expect(await state(f)).toEqual({ envelope_id: null, match_method: null, match_status: "ambiguous", match_candidates: [env["mx1"], env["mx2"]].sort() });
  });

  it("tied candidates on one ancestor chain: the deepest (the leaf) takes the fact, with the usual method", async () => {
    const f = await fact({ country: "PE", campaign: "c-pe" }, "8.00");
    await asApp((tx) => matchRunFacts(tx, ws, runId));
    expect(await state(f)).toEqual({ envelope_id: env["peGrandchild"], match_method: "tuple", match_status: null, match_candidates: null });
  });

  it("two siblings with identical tuples are ambiguous", async () => {
    const f = await fact({ country: "CO", campaign: "c-co" }, "9.00");
    await asApp((tx) => matchRunFacts(tx, ws, runId));
    expect(await state(f)).toEqual({ envelope_id: null, match_method: null, match_status: "ambiguous", match_candidates: [env["coA"], env["coB"]].sort() });
  });

  it("rule conflicts follow the same chain rule: parent and child → child", async () => {
    const f = await fact({ country: "ZZ", campaign: "c-chain" }, "11.00");
    await rule(env["peParent"] as string, campaignIs("c-chain"));
    await rule(env["peChild"] as string, campaignIs("c-chain"));
    await asApp((tx) => matchRunFacts(tx, ws, runId));
    expect(await state(f)).toMatchObject({ envelope_id: env["peChild"], match_method: "rule", match_status: null });
  });

  it("a match rule beats the tuple match", async () => {
    const f = await fact({ country: "BR", platform: "meta", campaign: "c-rule" }, "20.00");
    const plain = await fact({ country: "BR", platform: "meta", campaign: "c-other" }, "5.00");
    await rule(env["ruleTarget"] as string, campaignIs("c-rule"));
    await asApp((tx) => matchRunFacts(tx, ws, runId));
    expect(await state(f)).toMatchObject({ envelope_id: env["ruleTarget"], match_method: "rule", match_status: null });
    expect(await state(plain)).toMatchObject({ envelope_id: env["brMeta"], match_method: "tuple", match_status: null });
  });

  it("two rules naming different budgets for one fact make it ambiguous", async () => {
    const f = await fact({ country: "BR", platform: "meta", campaign: "c-conflict" }, "7.00");
    await rule(env["ruleTarget"] as string, campaignIs("c-conflict"));
    await rule(env["ruleTarget2"] as string, { logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "in", value: ["c-conflict", "x"] }] });
    await asApp((tx) => matchRunFacts(tx, ws, runId));
    expect(await state(f)).toEqual({ envelope_id: null, match_method: null, match_status: "ambiguous", match_candidates: [env["ruleTarget"], env["ruleTarget2"]].sort() });
  });

  it("a rule only applies inside its own dates and the budget's", async () => {
    const before = await fact({ country: "ZZ", campaign: "c-dated" }, "1.00", { date: "2026-02-01" });
    const inside = await fact({ country: "ZZ", campaign: "c-dated" }, "2.00", { date: "2026-05-01" });
    await rule(env["ruleTarget"] as string, campaignIs("c-dated"), { start: "2026-04-01" });
    await asApp((tx) => matchRunFacts(tx, ws, runId));
    expect(await state(before)).toMatchObject({ envelope_id: null, match_status: null });
    expect(await state(inside)).toMatchObject({ envelope_id: env["ruleTarget"], match_method: "rule" });
  });

  it("re-matching loaded facts after a rule is created assigns them; a manual pin and closed periods are left alone", async () => {
    const loose = await fact({ country: "ZZ", campaign: "c-late" }, "30.00", { run: randomUUID() });
    const pinned = await fact({ country: "ZZ", campaign: "c-late" }, "4.00", { envelopeId: env["mx1"] as string, method: "manual" });
    const closed = await fact({ country: "ZZ", campaign: "c-late" }, "6.00", { date: "2026-01-15" });
    const elsewhere = await fact({ country: "ZZ", campaign: "c-unrelated" }, "3.00");
    expect(await state(loose)).toMatchObject({ envelope_id: null });
    const predicate = campaignIs("c-late");
    await rule(env["ruleTarget2"] as string, predicate);
    const pass = await asApp((tx) => matchFacts(tx, ws, { predicate, keep: [{ start: "2026-01-01", end: "2026-01-31" }] }));
    expect(pass.spend).toBe(1);
    expect(pass.envelopeIds).toEqual([env["ruleTarget2"]]);
    expect(await state(loose)).toMatchObject({ envelope_id: env["ruleTarget2"], match_method: "rule" });
    expect(await state(pinned)).toMatchObject({ envelope_id: env["mx1"], match_method: "manual" });
    expect(await state(closed)).toMatchObject({ envelope_id: null });
    expect(await state(elsewhere)).toMatchObject({ envelope_id: null });
    // Deleting the rule and re-matching the same scope sends the fact back to unmatched.
    await asOwner((tx) => tx.$executeRawUnsafe(`UPDATE match_rule SET deleted_at = now() WHERE workspace_id = $1::uuid AND predicate = $2::jsonb`, ws, JSON.stringify(predicate)));
    const back = await asApp((tx) => matchFacts(tx, ws, { predicate }));
    expect(back.envelopeIds).toEqual([env["ruleTarget2"]]);
    expect(await state(loose)).toMatchObject({ envelope_id: null, match_method: null });
    // A second identical pass changes nothing.
    expect((await asApp((tx) => matchFacts(tx, ws, {}))).spend).toBe(0);
  });

  it("coverage: matched + unmatched + ambiguous = Σ live spend of the period; superseded facts are excluded", async () => {
    await fact({ country: "MX", campaign: "c-superseded" }, "999.00", { superseded: true });
    const cov = await asApp((tx) => matchCoverage(tx, ws, { from: "2026-01-01", to: "2026-12-31", limit: 100, campaignKey: "campaign" }));
    const [sum] = await asOwner((tx) =>
      tx.$queryRawUnsafe<Array<{ s: string; n: bigint }>>(`SELECT coalesce(sum(amount_reporting), 0)::text AS s, count(*) AS n FROM spend_fact WHERE workspace_id = $1::uuid AND superseded_at IS NULL`, ws),
    );
    const t = cov.totals;
    expect(new Decimal(t.matched).plus(t.unmatched).plus(t.ambiguous).toFixed(2)).toBe(new Decimal(sum?.s ?? "0").toFixed(2));
    expect(t.total).toBe(new Decimal(sum?.s ?? "0").toFixed(2));
    expect(t.totalRows).toBe(Number(sum?.n));
    expect(new Decimal(t.ambiguous).greaterThan(0)).toBe(true);
    // The per-source and per-campaign splits add up to the same total.
    const add = (rows: Array<{ total: string }>) => rows.reduce((s, r) => s.plus(r.total), new Decimal(0)).toFixed(2);
    expect(add(cov.bySource)).toBe(t.total);
    expect(add(cov.byCampaign)).toBe(t.total);
    // Open campaigns, largest first, ambiguous ones with their candidates.
    const amounts = cov.open.map((o) => new Decimal(o.amount));
    expect(amounts.every((a, i) => i === 0 || (amounts[i - 1] as Decimal).gte(a))).toBe(true);
    const conflict = cov.open.find((o) => o.campaign === "c-conflict");
    expect(conflict).toMatchObject({ status: "ambiguous", amount: "7.00", candidates: [{ id: env["ruleTarget"] }, { id: env["ruleTarget2"] }].sort((a, b) => String(a.id).localeCompare(String(b.id))) });
    expect(cov.open.some((o) => o.campaign === "c-superseded")).toBe(false);
    // A narrower period only counts its own facts.
    const feb = await asApp((tx) => matchCoverage(tx, ws, { from: "2026-02-01", to: "2026-02-28", limit: 100, campaignKey: "campaign" }));
    expect(feb.totals).toMatchObject({ total: "1.00", unmatched: "1.00", totalRows: 1 });
  });

  it("RLS: another workspace sees none of this workspace's rules, and its matching never uses them", async () => {
    const visible = await asApp((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM match_rule WHERE workspace_id = $1::uuid`, ws), otherWs);
    expect(Number(visible[0]?.n)).toBe(0);
    const own = await asApp((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM match_rule`));
    expect(Number(own[0]?.n)).toBeGreaterThan(0);
    await expect(asApp((tx) => tx.$executeRawUnsafe(`INSERT INTO match_rule (id, workspace_id, envelope_id, predicate, created_by) VALUES ($1::uuid, $2::uuid, $3::uuid, '{}'::jsonb, $4::uuid)`, randomUUID(), ws, env["mx1"], userId), otherWs)).rejects.toThrow();
  });
});
