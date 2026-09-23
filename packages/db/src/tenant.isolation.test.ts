import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, expect, it } from "vitest";
import { audit, bumpDataVersion, outbox, type Tx } from "./sql.js";
import { withTenant, type TenantContext } from "./tenant.js";

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
const userA = "01927a00-0000-7000-8000-0000000000c1";
const userB = "01927a00-0000-7000-8000-0000000000c2";

const ctxA: TenantContext = {
  workspaceId: workspaceA,
  userId: userA,
  isOrgAdmin: false,
  actorType: "user",
  requestId: "t004-a",
};
const ctxB: TenantContext = {
  workspaceId: workspaceB,
  userId: userB,
  isOrgAdmin: true,
  actorType: "mcp",
  requestId: "t004-b",
};

interface SessionSettings {
  workspace_id: string | null;
  user_id: string | null;
  is_org_admin: string | null;
}

async function readSettings(tx: Tx): Promise<SessionSettings | undefined> {
  const rows = await tx.$queryRaw<SessionSettings[]>`
    SELECT current_setting('app.workspace_id', true) AS workspace_id,
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
  expect(a?.user_id).toBe(userA);
  expect(a?.is_org_admin).toBe("false");
  expect(b?.workspace_id).toBe(workspaceB);
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

it("writes audit, outbox, and a bumped data version in one tenant transaction", async () => {
  const orgId = randomUUID();
  const workspaceId = randomUUID();
  const entityId = randomUUID();
  await prisma.$executeRaw`DELETE FROM outbox WHERE payload->>'entityId' = ${entityId}`;
  await prisma.$executeRaw`DELETE FROM workspace WHERE id = ${workspaceId}::uuid`;
  await prisma.$executeRaw`DELETE FROM organization WHERE id = ${orgId}::uuid`;
  await prisma.$executeRaw`INSERT INTO organization (id, name) VALUES (${orgId}::uuid, 't004')`;
  await prisma.$executeRaw`
    INSERT INTO workspace (id, org_id, slug, name, reporting_currency)
    VALUES (${workspaceId}::uuid, ${orgId}::uuid, 't004', 'T004', 'USD')`;

  try {
    const ctx: TenantContext = {
      workspaceId,
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
      const first = await bumpDataVersion(tx, workspaceId);
      const second = await bumpDataVersion(tx, workspaceId);
      return [first, second];
    });
    expect(versions).toEqual([1, 2]);

    const auditRows = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM audit_event WHERE entity_id = ${entityId}::uuid AND action = 'envelope.version.created'`;
    const outboxRows = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM outbox WHERE topic = 'budget.changed' AND payload->>'entityId' = ${entityId}`;
    expect(Number(auditRows[0]?.n)).toBe(1);
    expect(Number(outboxRows[0]?.n)).toBe(1);
  } finally {
    await prisma.$executeRaw`DELETE FROM outbox WHERE payload->>'entityId' = ${entityId}`;
    await prisma.$executeRaw`DELETE FROM workspace WHERE id = ${workspaceId}::uuid`;
    await prisma.$executeRaw`DELETE FROM organization WHERE id = ${orgId}::uuid`;
  }
});
