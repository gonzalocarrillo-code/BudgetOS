import { pathToFileURL } from "node:url";
import { newId } from "@budget/domain";
import { PrismaClient } from "@prisma/client";

/**
 * The deployment's one-time setup (ADR-065), run by the `budgetos-migrate` Cloud Run job after
 * `prisma migrate deploy`, as the owner role. Idempotent: every run leaves the same state.
 *
 * - The login roles the migrations create get their passwords from Secret Manager (the migrations
 *   carry a placeholder).
 * - The organization and its superadmin exist: SUPERADMIN_EMAIL holds ORG_ADMIN org-wide, so they
 *   can create workspaces and add people in the org console. Everyone else is added there.
 */
export async function bootstrap(owner: PrismaClient, env: NodeJS.ProcessEnv = process.env): Promise<{ orgId: string; userId: string }> {
  for (const [role, key] of [["budget_app", "APP_DB_PASSWORD"], ["budget_publisher", "PUBLISHER_DB_PASSWORD"], ["budget_mcp", "MCP_DB_PASSWORD"]] as const) {
    const password = env[key];
    if (!password) throw new Error(`${key} is required`);
    // Role names are constants; the password is a quoted literal (no placeholders in ALTER ROLE).
    await owner.$executeRawUnsafe(`ALTER ROLE ${role} PASSWORD '${password.replace(/'/g, "''")}'`);
  }
  const email = (env["SUPERADMIN_EMAIL"] ?? "").trim().toLowerCase();
  if (!email) throw new Error("SUPERADMIN_EMAIL is required");
  const orgName = env["ORG_NAME"] ?? "DEPT";
  const existing = await owner.user.findUnique({ where: { email } });
  const orgId = existing?.orgId ?? (await owner.organization.findFirst({ where: { name: orgName }, select: { id: true } }))?.id ?? (await owner.organization.create({ data: { id: newId(), name: orgName } })).id;
  const name = env["SUPERADMIN_NAME"] ?? email.split("@")[0]!.split(".").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  const user = existing ?? (await owner.user.create({ data: { id: newId(), orgId, email, name } }));
  if (!user.isActive) await owner.user.update({ where: { id: user.id }, data: { isActive: true } });
  const admin = await owner.roleAssignment.findFirst({ where: { workspaceId: null, principalType: "user", principalId: user.id, role: "ORG_ADMIN" } });
  if (!admin) await owner.roleAssignment.create({ data: { id: newId(), workspaceId: null, principalType: "user", principalId: user.id, role: "ORG_ADMIN", createdBy: user.id } });
  return { orgId, userId: user.id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const owner = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
  bootstrap(owner)
    .then((r) => process.stdout.write(`${JSON.stringify({ bootstrap: "ok", ...r })}\n`))
    .catch((err: unknown) => {
      process.stderr.write(`${String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => void owner.$disconnect());
}
