import { pathToFileURL } from "node:url";
import { newId } from "@budget/domain";
import { withTenant } from "@budget/db";
import { PrismaClient } from "@prisma/client";
import { ensureDefaultMetrics } from "../modules/registry/commands/metrics.js";

/**
 * S-9 (docs/STACK_AUDIT_2026-10-04.md): the three login roles the migrations create carry the
 * literal placeholder password until this file rotates it. Bootstrap must know all four deploy
 * secrets exist BEFORE anything else runs — in particular before `prisma migrate deploy`, which
 * is why `--check-secrets` (see the CLI dispatch below) validates this on its own, as an earlier
 * step in the `budgetos-migrate` job than `bootstrap()` itself.
 */
export function assertDeploySecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of ["APP_DB_PASSWORD", "PUBLISHER_DB_PASSWORD", "MCP_DB_PASSWORD", "SUPERADMIN_EMAIL"] as const) {
    if (!env[key]) throw new Error(`${key} is required`);
  }
}

/** `assertDeploySecrets` as a result instead of a throw, so the CLI exit code is unit-testable. */
export function checkSecretsStatus(env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; message: string } {
  try {
    assertDeploySecrets(env);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The deployment's one-time setup (ADR-065), run by the `budgetos-migrate` Cloud Run job after
 * `prisma migrate deploy`, as the owner role. Idempotent: every run leaves the same state.
 *
 * - The owner role never holds BYPASSRLS (W2-3, audit S-2, S-3, S-21; ADR-005 addendum). It is a
 *   DDL owner: migrations create every table, and `ensure_fact_partitions` is SECURITY DEFINER so
 *   `budget_app` can create a fact partition without CREATE on the schema. For the three identity
 *   tables this function writes before any org admin exists to authorize it under their ordinary
 *   policies (`organization`, `app_user`, `role_assignment`), migration
 *   `20261010050000_owner_bootstrap_policies` grants the owner role itself — by name, not by
 *   attribute — an explicit, permanent, table-scoped policy. Nothing here, or anywhere else the
 *   owner connects, bypasses RLS on any other table.
 * - The login roles the migrations create get their passwords from Secret Manager (the migrations
 *   carry a placeholder). S-9: before rotating, lock any role still on that placeholder
 *   (`app_lock_placeholder_logins()`, from migration 20261010020000_role_placeholder_lock) so a
 *   database where migrations ran but bootstrap never did cannot be reached with the public
 *   password. Rotating a role re-enables LOGIN and records it in `app_role_state`.
 * - The organization and its superadmin exist: SUPERADMIN_EMAIL holds ORG_ADMIN org-wide, so they
 *   can create workspaces and add people in the org console. Everyone else is added there.
 */
export async function bootstrap(owner: PrismaClient, env: NodeJS.ProcessEnv = process.env): Promise<{ orgId: string; userId: string }> {
  assertDeploySecrets(env);
  // app_lock_placeholder_logins() is SECURITY DEFINER (owned by `budget`, EXECUTE revoked from
  // PUBLIC): altering a role's LOGIN attribute needs CREATEROLE, not RLS bypass, so this runs
  // fine under W2-3's no-BYPASSRLS owner.
  await owner.$executeRawUnsafe("SELECT app_lock_placeholder_logins()");
  for (const [role, key] of [["budget_app", "APP_DB_PASSWORD"], ["budget_publisher", "PUBLISHER_DB_PASSWORD"], ["budget_mcp", "MCP_DB_PASSWORD"]] as const) {
    const password = env[key];
    if (!password) throw new Error(`${key} is required`);
    // Role names are constants; the password is a quoted literal (no placeholders in ALTER ROLE).
    await owner.$executeRawUnsafe(`ALTER ROLE ${role} LOGIN PASSWORD '${password.replace(/'/g, "''")}'`);
    await owner.$executeRawUnsafe(`UPDATE app_role_state SET placeholder = false, rotated_at = now() WHERE role_name = '${role}'`);
  }
  const email = (env["SUPERADMIN_EMAIL"] ?? "").trim().toLowerCase();
  if (!email) throw new Error("SUPERADMIN_EMAIL is required");
  const orgName = env["ORG_NAME"] ?? "DEPT";

  // One transaction: the owner_bootstrap policies (organization, app_user, role_assignment) make
  // these reads and writes visible to the owner with no tenant context at all, which is exactly
  // the point — there is no org yet to scope them to.
  const { orgId, userId } = await owner.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email } });
    const orgId =
      existing?.orgId ??
      (await tx.organization.findFirst({ where: { name: orgName }, select: { id: true } }))?.id ??
      (await tx.organization.create({ data: { id: newId(), name: orgName } })).id;
    const name = env["SUPERADMIN_NAME"] ?? email.split("@")[0]!.split(".").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
    const user = existing ?? (await tx.user.create({ data: { id: newId(), orgId, email, name } }));
    if (!user.isActive) await tx.user.update({ where: { id: user.id }, data: { isActive: true } });
    const admin = await tx.roleAssignment.findFirst({ where: { workspaceId: null, principalType: "user", principalId: user.id, role: "ORG_ADMIN" } });
    if (!admin) await tx.roleAssignment.create({ data: { id: newId(), workspaceId: null, principalType: "user", principalId: user.id, role: "ORG_ADMIN", createdBy: user.id } });
    return { orgId, userId: user.id };
  });

  // R11-001: an org whose workspaces were created before workspace creation seeded the metric
  // library gets it now (its CPA and ROAS rules could not run without it). Unlike the identity
  // writes above, `workspace` and `metric_definition` read fine under the ordinary org-admin
  // tenant context (workspace's org_read policy only needs org_id = app_org_id()) — no owner
  // policy needed here.
  const listCtx = { workspaceId: null, orgId, userId, isOrgAdmin: true, actorType: "system" as const, requestId: "bootstrap-metrics" };
  const first = await withTenant(owner, listCtx, (tx) => tx.workspace.findFirst({ where: { orgId, deletedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true } }));
  if (first) {
    const ctx = { ...listCtx, workspaceId: first.id };
    const seeded = await withTenant(owner, ctx, (tx) => tx.metricDefinition.count({ where: { orgId } }));
    if (seeded === 0) await withTenant(owner, ctx, (tx) => ensureDefaultMetrics(tx, ctx, { id: first.id, orgId }));
  }
  return { orgId, userId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check-secrets")) {
    // Validates env only; makes no connection. Run before `prisma migrate deploy` (deploy.yml) so
    // a missing secret fails the deploy before anything touches the database.
    const status = checkSecretsStatus();
    if (status.ok) {
      process.stdout.write("check-secrets: ok\n");
    } else {
      process.stderr.write(`${status.message}\n`);
      process.exitCode = 1;
    }
  } else {
    const owner = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
    bootstrap(owner)
      .then((r) => process.stdout.write(`${JSON.stringify({ bootstrap: "ok", ...r })}\n`))
      .catch((err: unknown) => {
        process.stderr.write(`${String(err)}\n`);
        process.exitCode = 1;
      })
      .finally(() => void owner.$disconnect());
  }
}
