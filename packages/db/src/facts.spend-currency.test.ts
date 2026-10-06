import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, expect, it } from "vitest";
import { ensurePartitions, spendThroughInCurrency } from "./facts.js";
import { withTenant, type TenantContext } from "./tenant.js";

/**
 * T-6: "spend through" in the budget's own currency must sum facts already in that currency
 * exactly, and convert only the remainder (facts in another currency) at *each fact's own date's*
 * FX rate — never today's — so the End dialog's proposed amount does not drift as new rates load
 * (get-envelope.ts's getEnvelopeSpend calls spendThroughInCurrency for exactly this reason).
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  const contents = readFileSync(path, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv(join(packageRoot, ".env"));

const ownerUrl = process.env["DATABASE_URL"] ?? "postgresql://budget:budget@localhost:5432/budget";
const prisma = new PrismaClient({ datasources: { db: { url: ownerUrl } } });

afterAll(() => prisma.$disconnect());

it("sums BRL facts natively and converts the USD fact at its own date's rate, unchanged by a later rate", async () => {
  const orgId = randomUUID();
  const workspaceId = randomUUID();
  const envelopeId = randomUUID();
  const runId = randomUUID();
  const rateEarly = randomUUID();
  const rateLate = randomUUID();

  // Matched by `source` (stable across runs), not by the random ids below: a prior run that threw
  // before reaching its own cleanup must not leave a stale rate for this run to pick up.
  const cleanup = async () => {
    await prisma.$executeRaw`DELETE FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid`;
    await prisma.$executeRaw`DELETE FROM fx_rate WHERE source = 't006'`;
    await prisma.$executeRaw`DELETE FROM workspace WHERE id = ${workspaceId}::uuid`;
    await prisma.$executeRaw`DELETE FROM organization WHERE id = ${orgId}::uuid`;
  };
  await cleanup();
  await prisma.$executeRaw`INSERT INTO organization (id, name) VALUES (${orgId}::uuid, 't006')`;
  await prisma.$executeRaw`INSERT INTO workspace (id, org_id, slug, name, reporting_currency) VALUES (${workspaceId}::uuid, ${orgId}::uuid, ${`t006-${workspaceId}`}, 'T006', 'USD')`;
  // The rate as of the USD fact's own date (2026-01-20): the latest BRL->USD rate on or before it.
  await prisma.$executeRaw`INSERT INTO fx_rate (id, base, quote, rate, as_of_date, source) VALUES (${rateEarly}::uuid, 'BRL', 'USD', 0.2000, '2026-01-01', 't006')`;
  // A later, different rate (what "today's" rate would be): must NOT affect the result.
  await prisma.$executeRaw`INSERT INTO fx_rate (id, base, quote, rate, as_of_date, source) VALUES (${rateLate}::uuid, 'BRL', 'USD', 0.3000, '2026-06-01', 't006')`;
  await ensurePartitions(prisma, "2026-01-01", "2026-12-31");
  await prisma.$executeRaw`
    INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash)
    VALUES
      (${workspaceId}::uuid, ${envelopeId}::uuid, '{}'::jsonb, '2026-01-10', 'BRL', 100.00, 20.00, 'test', ${runId}::uuid, 't006-1'),
      (${workspaceId}::uuid, ${envelopeId}::uuid, '{}'::jsonb, '2026-02-10', 'BRL', 200.00, 40.00, 'test', ${runId}::uuid, 't006-2'),
      (${workspaceId}::uuid, ${envelopeId}::uuid, '{}'::jsonb, '2026-01-20', 'USD', 50.00, 50.00, 'test', ${runId}::uuid, 't006-3')`;

  try {
    const ctx: TenantContext = { workspaceId, orgId, userId: randomUUID(), isOrgAdmin: true, actorType: "user", requestId: "t006" };
    const result = await withTenant(prisma, ctx, (tx) => spendThroughInCurrency(tx, envelopeId, "2026-12-31", "BRL"));
    // Native: the two BRL facts, exact. Remainder: the USD fact's 50.00 at the 2026-01-01 rate
    // (0.20), i.e. 50 / 0.20 = 250.00 — not the 2026-06-01 rate of 0.30, which would give 166.67.
    expect(result.native).toBe("300.00");
    expect(result.convertedRemainder).toBe("250.00");
    expect(result.factsInOtherCurrencies).toBe(1);

    // Adding a newer rate again (simulating time passing / a fresh load) must not move the figure:
    // only each fact's own-date rate is ever used.
    const rateNewer = randomUUID();
    await prisma.$executeRaw`INSERT INTO fx_rate (id, base, quote, rate, as_of_date, source) VALUES (${rateNewer}::uuid, 'BRL', 'USD', 0.5000, '2026-09-01', 't006')`;
    try {
      const again = await withTenant(prisma, ctx, (tx) => spendThroughInCurrency(tx, envelopeId, "2026-12-31", "BRL"));
      expect(again.convertedRemainder).toBe("250.00");
    } finally {
      await prisma.$executeRaw`DELETE FROM fx_rate WHERE id = ${rateNewer}::uuid`;
    }

    // A date excluding the USD fact: no remainder at all.
    const onlyBrl = await withTenant(prisma, ctx, (tx) => spendThroughInCurrency(tx, envelopeId, "2026-01-15", "BRL"));
    expect(onlyBrl.native).toBe("100.00");
    expect(onlyBrl.convertedRemainder).toBe("0.00");
    expect(onlyBrl.factsInOtherCurrencies).toBe(0);
  } finally {
    await cleanup();
  }
});

it("throws rather than guessing when a remainder fact's date has no FX rate", async () => {
  const orgId = randomUUID();
  const workspaceId = randomUUID();
  const envelopeId = randomUUID();
  const runId = randomUUID();
  const cleanup = async () => {
    await prisma.$executeRaw`DELETE FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid`;
    await prisma.$executeRaw`DELETE FROM workspace WHERE id = ${workspaceId}::uuid`;
    await prisma.$executeRaw`DELETE FROM organization WHERE id = ${orgId}::uuid`;
  };
  await cleanup();
  await prisma.$executeRaw`INSERT INTO organization (id, name) VALUES (${orgId}::uuid, 't006b')`;
  await prisma.$executeRaw`INSERT INTO workspace (id, org_id, slug, name, reporting_currency) VALUES (${workspaceId}::uuid, ${orgId}::uuid, ${`t006b-${workspaceId}`}, 'T006b', 'USD')`;
  await ensurePartitions(prisma, "2026-01-01", "2026-12-31");
  await prisma.$executeRaw`
    INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash)
    VALUES (${workspaceId}::uuid, ${envelopeId}::uuid, '{}'::jsonb, '2026-01-20', 'USD', 50.00, 50.00, 'test', ${runId}::uuid, 't006b-1')`;
  try {
    const ctx: TenantContext = { workspaceId, orgId, userId: randomUUID(), isOrgAdmin: true, actorType: "user", requestId: "t006b" };
    await expect(withTenant(prisma, ctx, (tx) => spendThroughInCurrency(tx, envelopeId, "2026-12-31", "BRL"))).rejects.toThrow(/No FX rate/);
  } finally {
    await cleanup();
  }
});
