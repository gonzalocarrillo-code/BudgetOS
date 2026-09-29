import { DomainError } from "@budget/domain";
import type { Tx } from "@budget/db";
import { Decimal } from "decimal.js";

/**
 * FX into the workspace reporting currency. No provider is chosen yet (plan §16 question 2), so this
 * reads the latest `fx_rate` on or before today and refuses to guess when none exists.
 */
export async function resolveFx(tx: Tx, currency: string, workspaceId: string): Promise<{ id: string | null; rate: Decimal }> {
  const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { reportingCurrency: true } });
  if (ws === null) throw new DomainError("NOT_FOUND", "Workspace not found");
  if (ws.reportingCurrency === currency) return { id: null, rate: new Decimal(1) };
  const fx = await tx.fxRate.findFirst({
    where: { base: currency, quote: ws.reportingCurrency, asOfDate: { lte: new Date() } },
    orderBy: { asOfDate: "desc" },
  });
  if (fx === null) {
    throw new DomainError("VALIDATION", `No FX rate ${currency}→${ws.reportingCurrency}`, { base: currency, quote: ws.reportingCurrency });
  }
  return { id: fx.id, rate: new Decimal(fx.rate.toString()) };
}
