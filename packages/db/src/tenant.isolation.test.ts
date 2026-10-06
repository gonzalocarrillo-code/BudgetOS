import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, expect, it } from "vitest";
import { audit, outbox, readDataVersion, type Tx } from "./sql.js";
import { asOrgAdmin, withTenant, type TenantContext } from "./tenant.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const contents = readFileSync(path, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv(join(packageRoot, ".env"));

const ownerUrl = process.env["DATABASE_URL"] ?? "postgresql://budget:budget@localhost:5432/budget";
const prisma = new PrismaClient({ datasources: { db: { url: ownerUrl } } });

const workspaceA = "01927a00-0000-7000-8000-0000000000a1";
const workspaceB = "01927a00-0000-7000-8000-0000000000b2";
const orgA = "01927a00-0000-7000-8000-0000000000d1";
const orgB = "01927a00-0000-7000-8000-0000000000d2";
const userA = "01927a00-0000-7000-8000-0000000000c1";
const userB = "01927a00-0000-7000-8000-0000000000c2";

const ctxA: TenantContext = {
  workspaceId: workspaceA,
  orgId: orgA,
  userId: userA,
  isOrgAdmin: false,
  actorType: "user",
  requestId: "t004-a",
};
const ctxB: TenantContext = {
  workspaceId: workspaceB,
  orgId: orgB,
  userId: userB,
  isOrgAdmin: true,
  actorType: "mcp",
  requestId: "t004-b",
};

interface SessionSettings {
  workspace_id: string | null;
  org_id: string | null;
  user_id: string | null;
  is_org_admin: string | null;
}

async function readSettings(tx: Tx): Promise<SessionSettings | undefined> {
  const rows = await tx.$queryRaw<SessionSettings[]>`
    SELECT current_setting('app.workspace_id', true) AS workspace_id,
           current_setting('app.org_id', true) AS org_id,
           current_setting('app.user_id', true) AS user_id,
           current_setting('app.is_org_admin', true) AS is_org_admin`;
  return rows[0];
}

afterAll(async () => {
  await prisma.$disconnect();
});

it("does not share SET LOCAL tenant settings across concurrent transactions", async () => {
  let markAReady: () => void = () => {};
  let markBReady: () => void = () => {};
  const aReady = new Promise<void>((resolve) => {
    markAReady = resolve;
  });
  const bReady = new Promise<void>((resolve) => {
    markBReady = resolve;
  });

  const seenA = withTenant(prisma, ctxA, async (tx) => {
    markAReady();
    await bReady;
    return readSettings(tx);
  });
  const seenB = withTenant(prisma, ctxB, async (tx) => {
    markBReady();
    await aReady;
    return readSettings(tx);
  });

  const [a, b] = await Promise.all([seenA, seenB]);
  expect(a?.workspace_id).toBe(workspaceA);
  expect(a?.org_id).toBe(orgA);
  expect(a?.user_id).toBe(userA);
  expect(a?.is_org_admin).toBe("false");
  expect(b?.workspace_id).toBe(workspaceB);
  expect(b?.org_id).toBe(orgB);
  expect(b?.user_id).toBe(userB);
  expect(b?.is_org_admin).toBe("true");
});

it("drops SET LOCAL settings when the transaction commits", async () => {
  const limited = new PrismaClient({
    datasources: { db: { url: `${ownerUrl}?connection_limit=1` } },
  });
  try {
    await withTenant(limited, ctxA, async (tx) => {
      const seen = await readSettings(tx);
      expect(seen?.workspace_id).toBe(workspaceA);
    });
    const leaked = await limited.$transaction(async (tx) => readSettings(tx));
    expect(leaked?.workspace_id ?? "").toBe("");
  } finally {
    await limited.$disconnect();
  }
});

it("writes audit and outbox in one tenant transaction; the outbox row moves the data version at commit (ADR-0084)", async () => {
  const orgId = randomUUID();
  const workspaceId = randomUUID();
  const entityId = randomUUID();
  // W0-6: the owner has no BYPASSRLS; workspace (unlike organization) has no owner_bootstrap
  // policy, so setup and the final assertions/cleanup below need the org-admin tenant context
  // real writes get from withTenant.
  await asOrgAdmin(
    prisma,
    async (tx) => {
      await tx.$executeRaw`DELETE FROM outbox WHERE payload->>'entityId' = ${entityId}`;
      await tx.$executeRaw`DELETE FROM workspace WHERE id = ${workspaceId}::uuid`;
      await tx.$executeRaw`DELETE FROM organization WHERE id = ${orgId}::uuid`;
      await tx.$executeRaw`INSERT INTO organization (id, name) VALUES (${orgId}::uuid, 't004')`;
      await tx.$executeRaw`
        INSERT INTO workspace (id, org_id, slug, name, reporting_currency)
        VALUES (${workspaceId}::uuid, ${orgId}::uuid, 't004', 'T004', 'USD')`;
    },
    orgId,
  );

  try {
    const ctx: TenantContext = {
      workspaceId,
      orgId,
      userId: userA,
      isOrgAdmin: false,
      actorType: "user",
      requestId: "t004-write",
    };
    const versions = await withTenant(prisma, ctx, async (tx) => {
      await audit(tx, {
        workspaceId,
        actorId: userA,
        actorType: "user",
        action: "envelope.version.created",
        entityType: "envelope",
        entityId,
        after: { amount: "10.00" },
        requestId: ctx.requestId,
      });
      await outbox(tx, {
        workspaceId,
        topic: "budget.changed",
        payload: { entityId, kind: "created" },
      });
      // Deferred to COMMIT: the transaction holds no data-version lock while it runs.
      return [await readDataVersion(tx, workspaceId)];
    });
    versions.push(await readDataVersion(prisma, workspaceId));
    expect(versions).toEqual([0, 1]);

    const [auditRows, outboxRows] = await asOrgAdmin(
      prisma,
      async (tx) => [
        await tx.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM audit_event WHERE entity_type = 'envelope' AND entity_id = ${entityId}::uuid AND action = 'envelope.version.created'`,
        await tx.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM outbox WHERE topic = 'budget.changed' AND payload->>'entityId' = ${entityId}`,
      ],
      orgId,
    );
    expect(Number(auditRows[0]?.n)).toBe(1);
    expect(Number(outboxRows[0]?.n)).toBe(1);
  } finally {
    // W3-11 (audit I-32): outbox.workspace_id and audit_event.workspace_id are FKs to
    // workspace(id) now (@budget/workers's deleteWorkspaceForTests, used by apps/api and
    // apps/workers test fixtures, mirrors this same order; @budget/db cannot import
    // @budget/workers — that would be circular — so it stays inline here). audit_event is
    // append-only (audit_event_immutable trigger); the trigger is disabled for this test cleanup
    // only, the same way migration 20261010030000's one-time backfill does.
    // W0-6: the owner has no BYPASSRLS, so every statement below needs the org-admin tenant
    // context real writes get from withTenant.
    await asOrgAdmin(
      prisma,
      async (tx) => {
        await tx.$executeRaw`DELETE FROM outbox WHERE payload->>'entityId' = ${entityId}`;
        await tx.$executeRaw`ALTER TABLE audit_event DISABLE TRIGGER audit_event_immutable`;
        await tx.$executeRaw`DELETE FROM audit_event WHERE workspace_id = ${workspaceId}::uuid`;
        await tx.$executeRaw`ALTER TABLE audit_event ENABLE TRIGGER audit_event_immutable`;
        await tx.$executeRaw`DELETE FROM workspace WHERE id = ${workspaceId}::uuid`;
        await tx.$executeRaw`DELETE FROM organization WHERE id = ${orgId}::uuid`;
      },
      orgId,
    );
  }
});

it("W3-8 (ADR-0084): an outbox row written by a SECURITY DEFINER function, called as budget_app, moves the data version", async () => {
  // No migration's RPC writes outbox today; this stands in for one. Locally the owner is a
  // superuser, so the second assertion proves the trigger path through a definer function and the
  // first that production's non-BYPASSRLS owner has the policy it needs under FORCE RLS.
  const owner = await prisma.$queryRaw<Array<{ owner: string }>>`SELECT tableowner::text AS owner FROM pg_tables WHERE tablename = 'workspace_data_version'`;
  const policy = await prisma.$queryRaw<Array<{ roles: string[] }>>`
    SELECT array(SELECT rolname::text FROM pg_roles WHERE oid = ANY(polroles)) AS roles FROM pg_policy
    WHERE polrelid = 'workspace_data_version'::regclass AND polname = 'owner_rpc' AND polcmd = '*'`;
  expect(policy[0]?.roles).toEqual([owner[0]?.owner]);

  const app = new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });
  const orgId = randomUUID();
  const workspaceId = randomUUID();
  const fn = `w38_rpc_${workspaceId.replace(/-/g, "")}`;
  await prisma.$executeRaw`INSERT INTO organization (id, name) VALUES (${orgId}::uuid, 'w38-rpc')`;
  await prisma.$executeRaw`INSERT INTO workspace (id, org_id, slug, name, reporting_currency) VALUES (${workspaceId}::uuid, ${orgId}::uuid, ${`w38-${workspaceId}`}, 'W38', 'USD')`;
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${fn}(p_ws uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ INSERT INTO outbox (workspace_id, topic, payload) VALUES (p_ws, 'w38.rpc', '{}'::jsonb) $$`,
  );
  await prisma.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION ${fn}(uuid) TO budget_app`);
  try {
    const ctx: TenantContext = { workspaceId, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: "w38-rpc" };
    const before = await readDataVersion(prisma, workspaceId);
    await withTenant(app, ctx, (tx) => tx.$executeRawUnsafe(`SELECT ${fn}($1::uuid)`, workspaceId));
    expect(await readDataVersion(prisma, workspaceId)).toBe(before + 1);
  } finally {
    await app.$disconnect();
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}(uuid)`);
    await prisma.$executeRaw`DELETE FROM outbox WHERE workspace_id = ${workspaceId}::uuid`;
    await prisma.$executeRaw`DELETE FROM workspace WHERE id = ${workspaceId}::uuid`;
    await prisma.$executeRaw`DELETE FROM organization WHERE id = ${orgId}::uuid`;
  }
});
