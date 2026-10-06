import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setMySlackSettings } from "./people.js";
import { asOrgAdmin, withTenant, type TenantContext } from "./tenant.js";

/**
 * S-010: app_user stays org-admin-write under RLS; a person saves their own Slack settings only
 * through app_set_my_slack_settings, which touches only their row and only `settings.slack`.
 */

const envFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    if (i > 0 && !line.trim().startsWith("#") && process.env[key] === undefined) process.env[key] = line.slice(i + 1).trim();
  }
}
const owner = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
const app = new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });
const orgId = randomUUID();
const ws = randomUUID();
const me = randomUUID();
const other = randomUUID();
const ctx = (userId: string): TenantContext => ({ workspaceId: ws, orgId, userId, isOrgAdmin: false, actorType: "user", requestId: `s010-${randomUUID()}` });
const settingsOf = async (id: string) => (await owner.user.findUniqueOrThrow({ where: { id }, select: { settings: true } })).settings;

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "s010" } });
  // W0-6: workspace has no owner_bootstrap policy (only organization/app_user/role_assignment do
  // — bootstrap.ts never writes workspace directly either); the owner needs the same org-admin
  // tenant context real workspace creation gets from withTenant.
  await asOrgAdmin(owner, (tx) => tx.workspace.create({ data: { id: ws, orgId, slug: `s010-${ws}`, name: "S-010", reportingCurrency: "USD" } }), orgId);
  await owner.user.createMany({ data: [me, other].map((id) => ({ id, orgId, email: `${id}@s010.test`, name: "Someone", googleSub: `g-${id}`, settings: { theme: "dark" } })) });
});

afterAll(async () => {
  await owner.user.deleteMany({ where: { orgId } });
  await asOrgAdmin(owner, (tx) => tx.workspace.deleteMany({ where: { orgId } }), orgId);
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("a person's own Slack settings", () => {
  it("are saved on their row only, under settings.slack, keeping the rest", async () => {
    const saved = await withTenant(app, ctx(me), (tx) => setMySlackSettings(tx, { defaultWorkspaceId: ws }));
    expect(saved).toEqual({ defaultWorkspaceId: ws });
    expect(await settingsOf(me)).toEqual({ theme: "dark", slack: { defaultWorkspaceId: ws } });
    expect(await settingsOf(other)).toEqual({ theme: "dark" });
  });

  it("cannot be written directly: app_user is org-admin-write", async () => {
    await withTenant(app, ctx(me), (tx) => tx.$executeRawUnsafe(`UPDATE app_user SET settings = '{"slack":{}}'::jsonb WHERE id = $1::uuid`, other));
    expect(await settingsOf(other)).toEqual({ theme: "dark" });
  });

  it("refuses a value that is not an object, and a transaction without a user", async () => {
    await expect(withTenant(app, ctx(me), (tx) => tx.$queryRawUnsafe(`SELECT app_set_my_slack_settings('"x"'::jsonb)`))).rejects.toThrow(/slack settings are an object/);
    await expect(withTenant(app, { ...ctx(me), userId: null }, (tx) => setMySlackSettings(tx, {}))).rejects.toThrow(/no user in this transaction/);
  });
});
