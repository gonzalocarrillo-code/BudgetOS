import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePartitions, matchFacts, matchRunFacts, upsertSpendFacts } from "./facts.js";
import { matchCoverage } from "./match-coverage.js";
import { asOrgAdmin, withTenant, type TenantContext } from "./tenant.js";
import type { Tx } from "./sql.js";

/**
 * EX-5 (ADR-0090): mapping rules of three kinds. Order: manual pin > database reference (the
 * source row names its budget) > campaign → budget rule > tuple enriched by the workspace's naming
 * conventions > plain tuple. A reference to an unknown budget, or a campaign name that fits no
 * convention, leaves the fact unassigned with that reason. Runs as budget_app under RLS.
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
const ctx = (workspaceId = ws): TenantContext => ({ workspaceId, orgId, userId, isOrgAdmin: false, actorType: "user", requestId: `ex5-${randomUUID()}` });
const asApp = <T>(fn: (tx: Tx) => Promise<T>, workspaceId = ws) => withTenant(app, ctx(workspaceId), fn);
const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, orgId);

async function envelope(name: string, dims: Record<string, string>, opts: { matchKey?: string; start?: string; end?: string } = {}): Promise<string> {
  const id = randomUUID();
  await asOwner((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at, match_key)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::date, $6::date, 'USD', 'APPROVED', $7::uuid, now(), $8)`,
      id,
      ws,
      name,
      JSON.stringify(dims),
      opts.start ?? "2026-01-01",
      opts.end ?? "2026-12-31",
      userId,
      opts.matchKey ?? null,
    ),
  );
  env[name] = id;
  return id;
}
let seq = 0;
async function fact(dims: Record<string, string>, amount: string, opts: { date?: string; envelopeId?: string; method?: string; ref?: string; run?: string } = {}): Promise<string> {
  const id = randomUUID();
  await asOwner((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO spend_fact (id, workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, natural_key, match_method, budget_ref)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::date, 'USD', $6::numeric, $6::numeric, 'test', $7::uuid, $8, $8, $9, $10)`,
      id,
      ws,
      opts.envelopeId ?? null,
      JSON.stringify(dims),
      opts.date ?? "2026-03-01",
      amount,
      opts.run ?? runId,
      `ex5-${++seq}-${id}`,
      opts.method ?? null,
      opts.ref ?? null,
    ),
  );
  return id;
}
async function rule(envelopeId: string, campaign: string): Promise<string> {
  const id = randomUUID();
  await asOwner((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO match_rule (id, workspace_id, envelope_id, predicate, created_by) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::uuid)`,
      id,
      ws,
      envelopeId,
      JSON.stringify({ logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "eq", value: campaign }] }),
      userId,
    ),
  );
  return id;
}
const TOKENS = [
  { dimension: "country", aliases: {} },
  { dimension: "platform", aliases: { FB: "meta" } },
  { dimension: "objective", aliases: {} },
  { dimension: null, aliases: {} },
  { dimension: null, aliases: {} },
];
async function convention(tokens: unknown = TOKENS, delimiter = "_", workspaceId = ws): Promise<string> {
  const id = randomUUID();
  await asOwner((tx) =>
    tx.$executeRawUnsafe(`INSERT INTO naming_convention (id, workspace_id, delimiter, tokens, created_by) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::uuid)`, id, workspaceId, delimiter, JSON.stringify(tokens), userId),
  );
  return id;
}
/** A campaign value in the registry: code = stable id, label = the campaign's name. */
let campaignDim = "";
async function campaign(code: string, label: string): Promise<string> {
  await asOwner((tx) => tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $4)`, randomUUID(), campaignDim, code, label));
  return code;
}
const state = async (id: string) =>
  (
    await asOwner((tx) =>
      tx.$queryRawUnsafe<Array<{ envelope_id: string | null; match_method: string | null; match_status: string | null }>>(`SELECT envelope_id::text, match_method, match_status FROM spend_fact WHERE id = $1::uuid`, id),
    )
  )[0];
const live = (key: string) => ({ logic: "and", children: [{ field: { kind: "dimension", key }, op: "not_empty" }] });

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "ex5" } });
  await asOwner((tx) => tx.workspace.createMany({ data: [ws, otherWs].map((id) => ({ id, orgId, slug: `ex5-${id}`, name: "EX-5", reportingCurrency: "USD" })) }));
  await owner.user.create({ data: { id: userId, orgId, email: `${userId}@ex5.test`, name: "EX-5", googleSub: `g-${userId}` } });
  await ensurePartitions(owner, "2026-01-01", "2026-12-31");
  await asOwner(async (tx) => {
    for (const [key, codes] of [["country", ["BR", "MX"]], ["platform", ["meta", "google"]], ["objective", ["prospecting", "retargeting"]], ["campaign", []]] as const) {
      const dim = randomUUID();
      if (key === "campaign") campaignDim = dim;
      await tx.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, $3, $3, 'ENUM', $4::uuid)`, dim, orgId, key, userId);
      for (const code of codes) await tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $3)`, randomUUID(), dim, code);
    }
  });
  await envelope("br", { country: "BR" });
  await envelope("brMetaPros", { country: "BR", platform: "meta", objective: "prospecting" });
  await envelope("mx", { country: "MX" }, { matchKey: "MX_Always_On" });
  await envelope("ruleTarget", { country: "AR" });
  await envelope("early", { country: "CL" }, { start: "2026-01-01", end: "2026-01-31" });
});

afterAll(async () => {
  await asOwner(async (tx) => {
    for (const t of ["match_rule", "naming_convention", "spend_fact", "kpi_fact", "projection_fact", "envelope"]) await tx.$executeRawUnsafe(`DELETE FROM ${t} WHERE workspace_id = ANY($1::uuid[])`, [ws, otherWs]);
    await tx.$executeRawUnsafe(`DELETE FROM workspace WHERE id = ANY($1::uuid[])`, [ws, otherWs]);
    await tx.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
    await tx.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("database reference", () => {
  it("a row naming a budget by id lands on it (`reference`), ahead of a campaign rule and the tuple", async () => {
    const f = await fact({ country: "BR", campaign: "c-ref" }, "10.00", { ref: (env["mx"] as string).toUpperCase() });
    await rule(env["ruleTarget"] as string, "c-ref");
    await asApp((tx) => matchRunFacts(tx, ws, runId));
    expect(await state(f)).toEqual({ envelope_id: env["mx"], match_method: "reference", match_status: null });
  });

  it("a row naming a budget by its match key (any case) lands on it", async () => {
    const f = await fact({ country: "BR" }, "4.00", { ref: "mx_always_on" });
    await asApp((tx) => matchRunFacts(tx, ws, runId));
    expect(await state(f)).toEqual({ envelope_id: env["mx"], match_method: "reference", match_status: null });
  });

  it("an unknown budget, or one whose dates do not cover the fact, leaves it unassigned with the reason (no fall-through to the tuple)", async () => {
    const unknown = await fact({ country: "BR" }, "3.00", { ref: "no-such-budget" });
    const outside = await fact({ country: "BR" }, "2.00", { ref: env["early"] as string, date: "2026-06-01" });
    await asApp((tx) => matchRunFacts(tx, ws, runId));
    expect(await state(unknown)).toEqual({ envelope_id: null, match_method: null, match_status: "unknown_budget_ref" });
    expect(await state(outside)).toEqual({ envelope_id: null, match_method: null, match_status: "budget_ref_outside_dates" });
  });

  it("a reloaded row whose reference changed is unmatched again so the run's pass reassigns it", async () => {
    const load = { workspaceId: ws, sourceSystem: "test", sourceRunId: randomUUID() };
    const row = { dimensionValues: { country: "BR" }, periodDate: "2026-03-05", currency: "USD", amount: "1.00", amountReporting: "1.00", fxRateId: null, rowHash: `ex5-reload-${randomUUID()}` };
    await asApp((tx) => upsertSpendFacts(tx, load, [{ ...row, budgetRef: env["mx"] as string }]));
    await asApp((tx) => matchRunFacts(tx, ws, load.sourceRunId));
    const id = (await asOwner((tx) => tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM spend_fact WHERE natural_key = $1`, row.rowHash)))[0]?.id as string;
    expect(await state(id)).toMatchObject({ envelope_id: env["mx"], match_method: "reference" });
    const again = { ...load, sourceRunId: randomUUID() };
    await asApp((tx) => upsertSpendFacts(tx, again, [{ ...row, budgetRef: env["br"] as string }]));
    await asApp((tx) => matchRunFacts(tx, ws, again.sourceRunId));
    expect(await state(id)).toMatchObject({ envelope_id: env["br"], match_method: "reference" });
  });
});

describe("naming convention", () => {
  let conventionId = "";
  let named: string;
  let aliased: string;
  let odd: string;
  let lost: string;
  let plain: string;
  let ruled: string;
  let pinned: string;
  let referenced: string;

  it("before any convention, campaign facts match on their plain tuple", async () => {
    named = await fact({ country: "BR", campaign: await campaign("c-named", "BR_Meta_Prospecting_Q4_VideoA") }, "20.00", { run: randomUUID() });
    aliased = await fact({ campaign: await campaign("c-alias", "br_FB_prospecting_Q4_x") }, "6.00", { run: randomUUID() });
    odd = await fact({ country: "BR", campaign: await campaign("c-odd", "Spring sale Brazil") }, "5.00", { run: randomUUID() });
    lost = await fact({ campaign: await campaign("c-lost", "Winter promo") }, "4.00", { run: randomUUID() });
    plain = await fact({ country: "BR" }, "1.00", { run: randomUUID() });
    ruled = await fact({ country: "BR", campaign: await campaign("c-ruled", "BR_Meta_Prospecting_Q4_x") }, "7.00", { run: randomUUID() });
    pinned = await fact({ country: "BR", campaign: "c-pinned" }, "8.00", { envelopeId: env["ruleTarget"] as string, method: "manual", run: randomUUID() });
    referenced = await fact({ country: "BR", campaign: "c-odd" }, "9.00", { ref: env["mx"] as string, run: randomUUID() });
    await rule(env["ruleTarget"] as string, "c-ruled");
    await asApp((tx) => matchFacts(tx, ws, {}));
    expect(await state(named)).toMatchObject({ envelope_id: env["br"], match_method: "tuple" });
    expect(await state(aliased)).toMatchObject({ envelope_id: null, match_status: null });
    expect(await state(odd)).toMatchObject({ envelope_id: env["br"], match_method: "tuple" });
  });

  it("creating a convention re-matches: names are parsed (aliases applied) into the tuple; a name that does not fit falls through to the plain tuple", async () => {
    conventionId = await convention();
    const pass = await asApp((tx) => matchFacts(tx, ws, { predicate: live("campaign") }));
    expect(pass.envelopeIds).toEqual([env["br"], env["brMetaPros"]].sort());
    expect(await state(named)).toEqual({ envelope_id: env["brMetaPros"], match_method: "naming", match_status: null });
    expect(await state(aliased)).toEqual({ envelope_id: env["brMetaPros"], match_method: "naming", match_status: null });
    // An existing tuple-matched fact whose name does not fit the new convention stays on its budget.
    expect(await state(odd)).toEqual({ envelope_id: env["br"], match_method: "tuple", match_status: null });
    // Only when the plain tuple also finds nothing is "name doesn't match convention" the reason.
    expect(await state(lost)).toEqual({ envelope_id: null, match_method: null, match_status: "name_mismatch" });
    // A fact without a campaign is not touched by conventions: the plain tuple decides.
    expect(await state(plain)).toMatchObject({ envelope_id: env["br"], match_method: "tuple" });
  });

  it("precedence: manual pin > database reference > campaign rule > convention tuple > plain tuple", async () => {
    expect(await state(pinned)).toMatchObject({ envelope_id: env["ruleTarget"], match_method: "manual" });
    expect(await state(referenced)).toMatchObject({ envelope_id: env["mx"], match_method: "reference" });
    expect(await state(ruled)).toMatchObject({ envelope_id: env["ruleTarget"], match_method: "rule" });
    expect(await state(named)).toMatchObject({ envelope_id: env["brMetaPros"], match_method: "naming" });
    expect(await state(plain)).toMatchObject({ envelope_id: env["br"], match_method: "tuple" });
  });

  it("coverage lists the unassigned campaign with its reason", async () => {
    const cov = await asApp((tx) => matchCoverage(tx, ws, { limit: 100, campaignKey: "campaign" }));
    expect(cov.open.find((o) => o.campaign === "c-lost")).toMatchObject({ status: "unmatched", reason: "name_mismatch", amount: "4.00", label: "Winter promo" });
    expect(cov.open.some((o) => o.campaign === "c-odd")).toBe(false);
    expect(cov.open.find((o) => o.reason === "unknown_budget_ref")).toMatchObject({ status: "unmatched", campaign: null });
  });

  it("deleting the convention re-matches the same facts back to their plain tuple", async () => {
    await asOwner((tx) => tx.$executeRawUnsafe(`UPDATE naming_convention SET deleted_at = now() WHERE id = $1::uuid`, conventionId));
    await asApp((tx) => matchFacts(tx, ws, { predicate: live("campaign") }));
    expect(await state(named)).toEqual({ envelope_id: env["br"], match_method: "tuple", match_status: null });
    expect(await state(odd)).toEqual({ envelope_id: env["br"], match_method: "tuple", match_status: null });
    expect(await state(lost)).toEqual({ envelope_id: null, match_method: null, match_status: null });
    expect(await state(aliased)).toEqual({ envelope_id: null, match_method: null, match_status: null });
  });

  it("with several conventions the first (oldest) that fits a name decides", async () => {
    const a = await convention([{ dimension: "country", aliases: {} }, { dimension: "platform", aliases: {} }], "-");
    const b = await convention(TOKENS);
    const dashed = await fact({ campaign: await campaign("c-dash", "MX-google") }, "2.00");
    await asApp((tx) => matchFacts(tx, ws, { predicate: live("campaign") }));
    expect(await state(dashed)).toMatchObject({ envelope_id: env["mx"], match_method: "naming" });
    expect(await state(named)).toMatchObject({ envelope_id: env["brMetaPros"], match_method: "naming" });
    await asOwner((tx) => tx.$executeRawUnsafe(`UPDATE naming_convention SET deleted_at = now() WHERE id = ANY($1::uuid[])`, [a, b]));
  });

  it("RLS: another workspace sees none of this workspace's conventions and cannot write one here", async () => {
    const seen = await asApp((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM naming_convention WHERE workspace_id = $1::uuid`, ws), otherWs);
    expect(Number(seen[0]?.n)).toBe(0);
    const own = await asApp((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM naming_convention`));
    expect(Number(own[0]?.n)).toBeGreaterThan(0);
    await expect(asApp((tx) => tx.$executeRawUnsafe(`INSERT INTO naming_convention (id, workspace_id, delimiter, tokens, created_by) VALUES ($1::uuid, $2::uuid, '_', '[{"dimension":"country"}]'::jsonb, $3::uuid)`, randomUUID(), ws, userId), otherWs)).rejects.toThrow();
  });
});
