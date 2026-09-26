/** The CI load job's body (T-034); `scripts/load-test.ts` runs it. See that file for how to run it. */
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { bulkCommit, gridQueries, indexAll, inlineEdits, lags, rebuildRollups, searches, TARGETS } from "./measure.js";
import { scaleGolden } from "./scale.js";
import { seedGolden } from "../seed/golden.js";
import { cleanupGolden } from "../test-support/golden-cleanup.js";
import { appDb, ownerDb, startHarness } from "../test-support/harness.js";

const env = (k: string, d: string) => process.env[k] ?? d;
const shards = Number(env("LOAD_SHARDS", "521"));
const commentsPerLeaf = Number(env("LOAD_COMMENTS_PER_LEAF", "10"));
const iterations = Number(env("LOAD_ITERATIONS", "20"));
const reportPath = env("LOAD_REPORT", "load-report.json");
const started = Date.now();
const log = (line: string) => process.stdout.write(`[${((Date.now() - started) / 1000).toFixed(0).padStart(5)} s] ${line}\n`);
const phases: Record<string, number> = {};
async function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const out = await fn();
  phases[name] = Date.now() - t0;
  log(`${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return out;
}

const owner = ownerDb();
const app = appDb();
const slug = `load-${randomUUID().slice(0, 8)}`;
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), shards, commentsPerLeaf, iterations, targets: TARGETS };
let failed = false;
let golden: Awaited<ReturnType<typeof seedGolden>> | null = null;
try {
  golden = await phase("seed golden (commands)", () => seedGolden(app, owner, { slug, log: () => undefined }));
  const g = golden;
  report["scale"] = await phase("scale (bulk SQL)", () => scaleGolden(owner, app, g, { shards, commentsPerLeaf, log }));
  report["searchDocuments"] = await phase("search index (document builders)", () => indexAll(app, owner, g, log));
  // The roll-up rebuild runs on its own connections with a statement timeout: at scale one
  // template's build can outlast the job, and a stuck query would slow every later measurement.
  // A failure is recorded and the measurements still run.
  const bounded = async <T,>(seconds: number, fn: (db: PrismaClient) => Promise<T>): Promise<T> => {
    await owner.$executeRawUnsafe(`ALTER ROLE budget_app SET statement_timeout = '${seconds}s'`);
    const db = new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });
    try {
      return await fn(db);
    } finally {
      await db.$disconnect();
      await owner.$executeRawUnsafe(`ALTER ROLE budget_app RESET statement_timeout`);
    }
  };
  try {
    report["rollup"] = await phase("roll-up rebuild (5 templates)", () => bounded(900, (db) => rebuildRollups(db, g)));
  } catch (error) {
    failed = true;
    report["rollup"] = { error: error instanceof Error ? error.message.split("\n").filter(Boolean).slice(-2).join(" ") : String(error) };
    log(`FAIL roll-up rebuild: ${String((report["rollup"] as { error: string }).error)}`);
  }
  log(`scale: ${JSON.stringify(report["scale"])}, search documents ${String(report["searchDocuments"])}`);

  const h = await startHarness();
  try {
    const c = { h, g, slug, owner, app, log };
    const results: Record<string, { value: number | null; target: number; detail?: unknown; error?: string }> = {};
    report["results"] = results;
    // Each measurement on its own: one that fails is recorded as failed, the rest still run.
    const measure = async (key: keyof typeof TARGETS, name: string, fn: () => Promise<{ value: number; detail?: unknown }>) => {
      try {
        const r = await phase(name, fn);
        results[key] = { value: r.value, target: TARGETS[key], ...(r.detail === undefined ? {} : { detail: r.detail }) };
      } catch (error) {
        results[key] = { value: null, target: TARGETS[key], error: error instanceof Error ? error.message : String(error) };
      }
      const r = results[key];
      const ok = r !== undefined && r.value !== null && r.value < r.target;
      if (!ok) failed = true;
      log(`${ok ? "PASS" : "FAIL"} ${key}: ${String(r?.value)} (target < ${TARGETS[key]})${r?.error ? ` — ${r.error}` : ""}`);
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
    };
    await measure("gridQueryP95Ms", "grid queries", async () => {
      const grid = await gridQueries(c, iterations);
      return { value: grid["all"] ?? NaN, detail: grid };
    });
    await measure("searchP95Ms", "search", async () => {
      const search = await searches(c, iterations);
      return { value: search["all"] ?? NaN, detail: search };
    });
    await measure("inlineEditP95Ms", "inline edits", async () => ({ value: await inlineEdits(c, iterations) }));
    await measure("bulkCommit10kMs", "10k bulk commit", async () => {
      const bulk = await bulkCommit(c, 10_000);
      return { value: bulk.commitMs, detail: bulk };
    });
    let lag: { rollupP95Ms: number; searchP95Ms: number } | null = null;
    // The handlers get a 2-minute statement bound: a refresh that slow has long missed its 5 s target.
    const lagOnce = async () => (lag ??= await bounded(120, (db) => lags({ ...c, app: db }, Math.max(10, Math.floor(iterations / 2)))));
    await measure("rollupLagP95Ms", "roll-up lag", async () => ({ value: (await lagOnce()).rollupP95Ms }));
    await measure("searchLagP95Ms", "search lag", async () => ({ value: (await lagOnce()).searchP95Ms }));
  } finally {
    await h.close();
  }
} catch (error) {
  failed = true;
  report["error"] = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  log(`ERROR ${String(report["error"]).split("\n")[0]}`);
} finally {
  report["phasesMs"] = phases;
  report["finishedAt"] = new Date().toISOString();
  report["pass"] = !failed;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`report written to ${reportPath}: ${failed ? "FAIL" : "PASS"}`);
  if (golden?.created && process.env["LOAD_KEEP"] !== "1") {
    await owner.$executeRawUnsafe(`DELETE FROM spend_fact WHERE workspace_id = $1::uuid`, golden.workspaceId);
    await owner.$executeRawUnsafe(`DELETE FROM kpi_fact WHERE workspace_id = $1::uuid`, golden.workspaceId);
    await owner.$executeRawUnsafe(`DELETE FROM envelope_dimension WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)`, golden.workspaceId);
    await cleanupGolden(owner, golden).catch((e: unknown) => log(`cleanup: ${String(e)}`));
  }
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
  process.exit(failed ? 1 : 0);
}
