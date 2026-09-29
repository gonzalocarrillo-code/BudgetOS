import { describe, expect, it } from "vitest";
import { summaryMessage, type SummaryInput } from "./summary.js";

/** S-008: the /budget summary, from the fields of GET /me/home it shows. */
const base: SummaryInput = {
  baseUrl: "https://budgetos.example",
  workspaceId: "01927a00-0000-7000-8000-00000000a0a0",
  personName: "Planner <Pat>",
  footer: "",
  workspaceName: "Golden",
  currency: "USD",
  period: { start: "2026-01-01", end: "2026-12-31", elapsed: "0.7485" },
  totals: { budget: "12345678.49", actual: "8000000.50", spentPct: "0.6480", openAlerts: 193 },
  waiting: { approvals: 2, alerts: 1, mentions: 0 },
  budgets: [{ label: "LATAM", envelopeId: "01927a00-0000-7000-8000-0000000000b1", budget: "4000000.00", spentPct: "0.4700", paceIndex: "0.8812" }],
};

describe("the /budget summary", () => {
  it("reads the year so far, what waits on the person and their budgets", () => {
    const m = summaryMessage(base);
    const text = JSON.stringify(m.blocks);
    expect(text).toContain("*Golden* · Planner &lt;Pat&gt;");
    expect(text).toContain("This fiscal year, 1 Jan – 31 Dec 2026: 75% of it gone");
    expect(text).toContain("USD 12,345,678");
    expect(text).toContain("USD 8,000,001 (65%)");
    expect(text).toContain("*Waiting on you:* 2 approvals · 1 alert");
    expect(text).toContain("`/budget approvals` to decide them here");
    expect(text).toContain("|LATAM> USD 4,000,000 · spent 47% · pace 0.88");
    expect(m.text).toBe("Golden: USD 12,345,678 budget, 65% spent");
  });

  it("says when nothing waits, and when there is nothing to show", () => {
    const empty = summaryMessage({ ...base, totals: null, waiting: { approvals: 0, alerts: 0, mentions: 0 }, budgets: [] });
    expect(JSON.stringify(empty.blocks)).toContain("Nothing is waiting on you.");
    expect(JSON.stringify(empty.blocks)).toContain("Nothing to show yet: no budgets you can read in this workspace.");
    const overNothing = summaryMessage({ ...base, totals: { budget: null, actual: null, spentPct: null, openAlerts: 3 }, budgets: [] });
    expect(JSON.stringify(overNothing.blocks)).toContain("Nothing to show yet");
    expect(JSON.stringify(overNothing.blocks)).not.toContain("*Budget*");
  });
});
