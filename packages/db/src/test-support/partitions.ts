import type { PrismaClient } from "@prisma/client";

const PARENTS = ["spend_fact", "kpi_fact", "projection_fact", "audit_event"] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * W3-10: drops the four month partitions of each `YYYYMM` a test created, without ever deadlocking
 * the suites running alongside. Dropping a fact partition locks its parent and `workspace` (where
 * its FK triggers live) ACCESS EXCLUSIVE; each DROP runs in its own transaction with a lock_timeout
 * well under deadlock_timeout (1 s), so it gives up — and retries — before any other session's
 * deadlock check could pick that session as the victim. A partition that stays busy is left in
 * place: it is empty, and the next fresh database starts without it. Owner client only.
 */
export async function dropFactPartitionsForTests(owner: PrismaClient, months: string[]): Promise<void> {
  for (const month of months) {
    if (!/^\d{6}$/.test(month)) throw new Error(`month must be YYYYMM, got ${month}`);
    for (const parent of PARENTS) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await owner.$transaction([owner.$executeRawUnsafe(`SET LOCAL lock_timeout = '200ms'`), owner.$executeRawUnsafe(`DROP TABLE IF EXISTS ${parent}_${month}`)]);
          break;
        } catch (error) {
          const code = (error as { meta?: { code?: unknown } }).meta?.code;
          if (code !== "55P03") throw error;
          await sleep(50 + Math.floor(Math.random() * 200));
        }
      }
    }
  }
}
