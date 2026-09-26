import { newId, type Role } from "@budget/domain";
import type { TenantContext } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { InMemoryAssetStore } from "../modules/registry/assets/asset-store.js";
import { addValues } from "../modules/registry/commands/add-values.js";
import { createDimension } from "../modules/registry/commands/create-dimension.js";
import { saveHierarchyTemplate } from "../modules/registry/commands/save-hierarchy-template.js";
import type { GoldenResult } from "../seed/golden.js";

/**
 * The CI load job's dataset (spec §21, T-034): the golden workspace, then its live envelope tree
 * copied `shards` times (a `load_shard` granularity tells the copies apart), so 192 golden leaves
 * × 521 shards ≈ 100k leaves. Registry and templates go through the real commands (20 dimensions,
 * 5 templates); the copies, their approved versions and phasing, the facts (daily spend Jan–Aug,
 * weekly KPIs), 1M comments and the tags are bulk SQL — the commands' per-row audit would take
 * hours at this size, and the job measures reads and the write paths it drives itself.
 */

export interface ScaleOptions {
  shards: number;
  commentsPerLeaf: number;
  log: (line: string) => void;
}

export interface ScaleResult {
  leaves: number;
  envelopes: number;
  spendFacts: number;
  kpiFacts: number;
  comments: number;
  dimensions: number;
  templates: number;
}

const count = async (db: PrismaClient, sql: string, ...args: unknown[]) => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(sql, ...args))[0]?.n ?? 0);

export async function scaleGolden(owner: PrismaClient, app: PrismaClient, golden: GoldenResult, opts: ScaleOptions): Promise<ScaleResult> {
  const { workspaceId: ws, orgId } = golden;
  const admin = golden.users.orgAdmin;
  const ctx: TenantContext = { workspaceId: ws, orgId, userId: admin, isOrgAdmin: true, actorType: "user", requestId: `load-registry-${ws}` };
  const roles: Role[] = ["ORG_ADMIN"];
  const store = new InMemoryAssetStore();
  const pad = (n: number) => String(n).padStart(4, "0");

  // ---- Registry: two more granularities (20 in all) and two more templates (5 in all). ----
  const shard = await createDimension(app, ctx, roles, { key: "load_shard", label: "Load shard", dataType: "ENUM", icon: "lucide:layers", allowedParents: [], isRequiredForLeaf: false, sortOrder: 200, workspaceId: ws }, store);
  for (let i = 0; i < opts.shards; i += 1000) {
    const values = Array.from({ length: Math.min(1000, opts.shards - i) }, (_, k) => ({ code: `s${pad(i + k + 1)}`, label: `Shard ${i + k + 1}` }));
    await addValues(app, ctx, roles, shard.id, { values });
  }
  const team = await createDimension(app, ctx, roles, { key: "agency_team", label: "Agency team", dataType: "ENUM", icon: "lucide:users", allowedParents: [], isRequiredForLeaf: false, sortOrder: 201, workspaceId: ws }, store);
  await addValues(app, ctx, roles, team.id, { values: Array.from({ length: 8 }, (_, k) => ({ code: `team_${k + 1}`, label: `Team ${k + 1}` })) });
  await saveHierarchyTemplate(app, ctx, roles, { name: "Shard first", path: ["load_shard", "channel", "platform", "objective", "audience"], isDefault: false });
  await saveHierarchyTemplate(app, ctx, roles, { name: "Team first", path: ["agency_team", "channel", "platform"], isDefault: false });
  opts.log(`load: registry +2 dimensions (${opts.shards} shard values), +2 templates`);

  // ---- The copies: every live envelope with an approved version, once per shard. ----
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS load_map`);
  await owner.$executeRawUnsafe(
    `CREATE UNLOGGED TABLE load_map AS
       SELECT e.id AS old_id, s AS shard, gen_random_uuid() AS new_id, gen_random_uuid() AS version_id,
              0.8 + ((abs(hashtext(s::text)) % 400) / 1000.0) AS factor,
              NOT EXISTS (SELECT 1 FROM envelope c WHERE c.parent_id = e.id AND c.status <> 'ARCHIVED') AS is_leaf
         FROM envelope e CROSS JOIN generate_series(1, $2::int) s
        WHERE e.workspace_id = $1::uuid AND e.status <> 'ARCHIVED' AND e.current_version_id IS NOT NULL`,
    ws,
    opts.shards,
  );
  await owner.$executeRawUnsafe(`CREATE INDEX ON load_map (old_id, shard)`);
  await owner.$executeRawUnsafe(`ANALYZE load_map`);
  const shardValue = new Map((await owner.dimensionValue.findMany({ where: { dimensionId: shard.id }, select: { code: true, id: true } })).map((v) => [v.code, v.id]));
  const teamValues = (await owner.dimensionValue.findMany({ where: { dimensionId: team.id }, select: { code: true, id: true }, orderBy: { code: "asc" } })).map((v) => v.id);

  const batch = Math.max(1, Math.floor(20_000 / Math.max(1, await count(owner, `SELECT count(*) AS n FROM load_map WHERE shard = 1`))));
  for (let from = 1; from <= opts.shards; from += batch) {
    const to = Math.min(opts.shards, from + batch - 1);
    await owner.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO envelope (id, workspace_id, parent_id, name, dimension_values, period_id, start_date, end_date, currency, status, owner_id, created_by, updated_at)
           SELECT m.new_id, e.workspace_id, pm.new_id, e.name || ' #' || m.shard,
                  e.dimension_values || jsonb_build_object('load_shard', 's' || lpad(m.shard::text, 4, '0'), 'agency_team', 'team_' || (1 + m.shard % 8)),
                  e.period_id, e.start_date, e.end_date, e.currency, 'APPROVED', e.owner_id, e.created_by, now()
             FROM load_map m JOIN envelope e ON e.id = m.old_id
             LEFT JOIN load_map pm ON pm.old_id = e.parent_id AND pm.shard = m.shard
            WHERE m.shard BETWEEN $1 AND $2`,
          from,
          to,
        );
        // Monthly phasing scaled by the shard's factor; the version amount is its exact sum.
        await tx.$executeRawUnsafe(
          `INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, fx_rate_id, status, rationale, created_by, approved_at)
           SELECT m.version_id, m.new_id, 1, s.total, round(s.total * (v.amount_reporting / nullif(v.amount, 0)), 2), v.fx_rate_id, 'APPROVED', 'load test copy', v.created_by, v.approved_at
             FROM load_map m JOIN envelope e ON e.id = m.old_id JOIN envelope_version v ON v.id = e.current_version_id
             CROSS JOIN LATERAL (SELECT coalesce(sum(round(p.amount * m.factor, 2)), round(v.amount * m.factor, 2)) AS total FROM envelope_phasing p WHERE p.version_id = v.id) s
            WHERE m.shard BETWEEN $1 AND $2`,
          from,
          to,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO envelope_phasing (version_id, month, amount)
           SELECT m.version_id, p.month, round(p.amount * m.factor, 2)
             FROM load_map m JOIN envelope e ON e.id = m.old_id JOIN envelope_phasing p ON p.version_id = e.current_version_id
            WHERE m.shard BETWEEN $1 AND $2`,
          from,
          to,
        );
        await tx.$executeRawUnsafe(`UPDATE envelope e SET current_version_id = m.version_id FROM load_map m WHERE e.id = m.new_id AND m.shard BETWEEN $1 AND $2`, from, to);
        await tx.$executeRawUnsafe(
          `INSERT INTO envelope_dimension (envelope_id, dimension_id, value_id)
           SELECT m.new_id, d.dimension_id, d.value_id FROM load_map m JOIN envelope_dimension d ON d.envelope_id = m.old_id WHERE m.shard BETWEEN $1 AND $2`,
          from,
          to,
        );
        const shardRows = Array.from({ length: to - from + 1 }, (_, k) => from + k);
        await tx.$executeRawUnsafe(
          `INSERT INTO envelope_dimension (envelope_id, dimension_id, value_id)
           SELECT m.new_id, $3::uuid, x.value_id FROM load_map m JOIN unnest($4::int[], $5::uuid[]) AS x(shard, value_id) ON x.shard = m.shard WHERE m.shard BETWEEN $1 AND $2
           UNION ALL
           SELECT m.new_id, $6::uuid, ($7::uuid[])[1 + m.shard % 8] FROM load_map m WHERE m.shard BETWEEN $1 AND $2`,
          from,
          to,
          shard.id,
          shardRows,
          shardRows.map((n) => shardValue.get(`s${pad(n)}`) as string),
          team.id,
          teamValues,
        );
      },
      { timeout: 600_000 },
    );
    opts.log(`load: envelopes shards ${from}–${to} of ${opts.shards}`);
  }

  // ---- Facts: daily spend Jan–Aug (243 days) and weekly conversions + revenue for every copied leaf. ----
  const runId = newId();
  const factBatch = Math.max(1, Math.floor(batch / 2));
  for (let from = 1; from <= opts.shards; from += factBatch) {
    const to = Math.min(opts.shards, from + factBatch - 1);
    await owner.$executeRawUnsafe(
      `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, fx_rate_id, source_system, source_run_id, source_row_hash)
       SELECT e.workspace_id, e.id, e.dimension_values, d::date, e.currency, a.amount, a.amount, NULL, 'load', $3::uuid, md5(e.id::text || d::text)
         FROM load_map m JOIN envelope e ON e.id = m.new_id JOIN envelope_version v ON v.id = e.current_version_id
         CROSS JOIN generate_series('2026-01-01'::date, '2026-08-31'::date, '1 day') d
         CROSS JOIN LATERAL (SELECT round(v.amount / 365 * (0.6 + (abs(hashtext(e.id::text || d::text)) % 700) / 1000.0), 2) AS amount) a
        WHERE m.is_leaf AND m.shard BETWEEN $1 AND $2`,
      from,
      to,
      runId,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO kpi_fact (workspace_id, envelope_id, dimension_values, period_date, metric, value, source_system, source_run_id, source_row_hash)
       SELECT e.workspace_id, e.id, e.dimension_values, d::date, k.metric, k.value, 'load', $3::uuid, md5(e.id::text || d::text || k.metric)
         FROM load_map m JOIN envelope e ON e.id = m.new_id JOIN envelope_version v ON v.id = e.current_version_id
         CROSS JOIN generate_series('2026-01-05'::date, '2026-08-31'::date, '7 days') d
         CROSS JOIN LATERAL (VALUES
           ('conversions', round(v.amount / 52 / (15 + (abs(hashtext(e.id::text || d::text)) % 20)), 4)),
           ('revenue', round(v.amount / 52 * (2 + (abs(hashtext(d::text || e.id::text)) % 300) / 100.0), 4))) AS k(metric, value)
        WHERE m.is_leaf AND m.shard BETWEEN $1 AND $2`,
      from,
      to,
      runId,
    );
    opts.log(`load: facts shards ${from}–${to} of ${opts.shards}`);
  }

  // ---- Conversations: one thread per copied leaf with `commentsPerLeaf` comments; 10% of leaves tagged. ----
  const authors = Object.values(golden.users);
  const words = ["pacing", "retail", "promo", "invoice", "creative", "flight", "launch", "Q4", "Black Friday", "CPA", "reforecast", "brand", "search", "video", "audience", "lookalike"];
  for (let from = 1; from <= opts.shards; from += batch) {
    const to = Math.min(opts.shards, from + batch - 1);
    await owner.$executeRawUnsafe(
      `WITH t AS (
         INSERT INTO thread (id, workspace_id, anchor_type, anchor_id, title, status, created_by, created_at)
         SELECT gen_random_uuid(), $3::uuid, 'envelope', m.new_id, 'Plan check · ' || m.shard, CASE WHEN m.shard % 3 = 0 THEN 'resolved' ELSE 'open' END, ($4::uuid[])[1 + m.shard % array_length($4::uuid[], 1)], now() - interval '30 days'
           FROM load_map m WHERE m.is_leaf AND m.shard BETWEEN $1 AND $2
         RETURNING id, created_by
       )
       INSERT INTO comment (id, thread_id, author_id, body_md, created_at)
       SELECT gen_random_uuid(), t.id, ($4::uuid[])[1 + (abs(hashtext(t.id::text || c::text)) % array_length($4::uuid[], 1))],
              'Comment ' || c || ' on ' || ($5::text[])[1 + (abs(hashtext(t.id::text || c::text)) % array_length($5::text[], 1))] || ' and ' || ($5::text[])[1 + (abs(hashtext(c::text || t.id::text)) % array_length($5::text[], 1))],
              now() - (interval '1 hour' * c)
         FROM t CROSS JOIN generate_series(1, $6::int) c`,
      from,
      to,
      ws,
      authors,
      words,
      opts.commentsPerLeaf,
    );
  }
  const tagIds = (await owner.tag.findMany({ where: { workspaceId: ws }, select: { id: true } })).map((t) => t.id);
  if (tagIds.length) {
    await owner.$executeRawUnsafe(
      `INSERT INTO taggable (workspace_id, tag_id, entity_type, entity_id, tagged_by)
       SELECT $1::uuid, ($2::uuid[])[1 + m.shard % array_length($2::uuid[], 1)], 'envelope', m.new_id, $3::uuid FROM load_map m WHERE m.is_leaf AND m.shard % 10 = 0
       ON CONFLICT DO NOTHING`,
      ws,
      tagIds,
      admin,
    );
  }
  opts.log("load: threads, comments and tags written");
  for (const t of ["envelope", "envelope_version", "envelope_phasing", "envelope_dimension", "spend_fact", "kpi_fact", "thread", "comment", "taggable"]) await owner.$executeRawUnsafe(`ANALYZE ${t}`);
  await owner.$executeRawUnsafe(`DROP TABLE load_map`);

  const leaves = await count(owner, `SELECT count(*) AS n FROM envelope e WHERE e.workspace_id = $1::uuid AND e.status <> 'ARCHIVED' AND NOT EXISTS (SELECT 1 FROM envelope c WHERE c.parent_id = e.id AND c.status <> 'ARCHIVED')`, ws);
  return {
    leaves,
    envelopes: await count(owner, `SELECT count(*) AS n FROM envelope WHERE workspace_id = $1::uuid`, ws),
    spendFacts: await count(owner, `SELECT count(*) AS n FROM spend_fact WHERE workspace_id = $1::uuid`, ws),
    kpiFacts: await count(owner, `SELECT count(*) AS n FROM kpi_fact WHERE workspace_id = $1::uuid`, ws),
    comments: await count(owner, `SELECT count(*) AS n FROM comment c JOIN thread t ON t.id = c.thread_id WHERE t.workspace_id = $1::uuid`, ws),
    dimensions: await count(owner, `SELECT count(*) AS n FROM dimension WHERE org_id = $1::uuid AND is_active AND (workspace_id IS NULL OR workspace_id = $2::uuid)`, orgId, ws),
    templates: await count(owner, `SELECT count(*) AS n FROM hierarchy_template WHERE workspace_id = $1::uuid`, ws),
  };
}
