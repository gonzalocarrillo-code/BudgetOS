import { describe, expect, it } from "vitest";
import { budgetCard, whichBudget, type BudgetCardInput } from "./budget.js";

/** S-009: a budget's card and the "which one?" choice. */
const card: BudgetCardInput = {
  baseUrl: "https://budgetos.example",
  workspaceId: "01927a00-0000-7000-8000-00000000a0a0",
  envelopeId: "01927a00-0000-7000-8000-0000000000b1",
  name: "BR Meta",
  path: "LATAM › BR › BR Meta",
  status: "PENDING",
  ended: false,
  period: { start: "2026-01-01", end: "2026-12-31" },
  reportingCurrency: "USD",
  ownerName: "Owner Olga",
  numbers: { budget: "200000.00", actual: "94000.00", projected: "210000.00", spentPct: "0.47", paceIndex: "1.12" },
  own: { amount: "1000000.00", currency: "BRL" },
  openRequest: { id: "01927a00-0000-7000-8000-0000000000f1", summary: "BR Meta: 1000000.00 → 1150000.00" },
  draft: null,
  alerts: [{ severity: "critical", ruleName: "Over-pace", status: "OPEN" }],
  children: 3,
};

describe("a budget's card", () => {
  it("shows where it sits, its numbers over its dates, what waits on it, and a link", () => {
    const m = budgetCard(card);
    const text = JSON.stringify(m.blocks);
    expect(text).toContain("*LATAM › BR › BR Meta*\\nWaiting for approval · 1 Jan – 31 Dec 2026 · owner Owner Olga");
    expect(text).toContain("*Budget*\\nUSD 200,000 (BRL 1,000,000)");
    expect(text).toContain("*Spent*\\nUSD 94,000 · 47%");
    expect(text).toContain("*Pace*\\n1.12");
    expect(text).toContain("`/budget show #000000f1`");
    expect(text).toContain(":rotating_light: Over-pace (open)");
    expect(text).toContain("3 budgets under it · Numbers over its dates, in USD");
    expect(text).not.toContain("budget.request"); // S-011 adds the button for people who may send a change
    expect(m.text).toBe("BR Meta: USD 200,000 budget, 47% spent");
  });

  it("offers one button per budget when several match", () => {
    const m = whichBudget({ workspaceId: card.workspaceId, q: "meta", hits: [{ id: card.envelopeId, title: "BR Meta", path: "LATAM › BR" }, { id: "01927a00-0000-7000-8000-0000000000b2", title: "MX Meta", path: null }] });
    expect(m.text).toBe("Which “meta”?");
    expect((JSON.stringify(m.blocks).match(/"action_id":"budget.show"/g) ?? []).length).toBe(2);
  });
});
