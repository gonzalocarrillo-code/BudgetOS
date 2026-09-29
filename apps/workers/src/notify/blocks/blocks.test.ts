import { describe, expect, it } from "vitest";
import { alertMessage } from "./alert.js";
import { approvalMessage, approvalReminder } from "./approval.js";
import { money } from "./common.js";
import { mentionMessage, renderBody } from "./mention.js";

/** T-021 done-when: Slack message snapshot tests (alert, approval, mention). No Slack call. */

const base = { baseUrl: "https://budget-os.example", workspaceId: "01927a00-0000-7000-8000-00000000a0a0" };
const user = "01927a00-0000-7000-8000-0000000000b1";
const group = "01927a00-0000-7000-8000-0000000000c1";

describe("alert blocks", () => {
  it("critical alert", () => {
    expect(
      alertMessage({
        ...base,
        alertId: "01927a00-0000-7000-8000-0000000000d1",
        envelopeId: "01927a00-0000-7000-8000-0000000000e1",
        ruleName: "CPA far over target",
        severity: "critical",
        metric: "kpi_vs_target_pct",
        metricValue: "1.3812",
        comparator: "gt",
        threshold: "1.25",
        envelopePath: "LATAM › Brazil › Meta › Conversion",
        budget: "1250000.00",
        actual: "812345.5",
        currency: "USD",
        ownerName: "Ana <Lima> & Co",
        reopened: false,
        evaluatedFor: "2026-08-15",
      }),
    ).toMatchSnapshot();
  });

  it("reopened warning without owner", () => {
    expect(
      alertMessage({
        ...base,
        alertId: "01927a00-0000-7000-8000-0000000000d2",
        envelopeId: "01927a00-0000-7000-8000-0000000000e2",
        ruleName: "Over-pace",
        severity: "warning",
        metric: "pace_index",
        metricValue: "1.1402",
        comparator: "gt",
        threshold: "1.10",
        envelopePath: "EMEA › Germany",
        budget: null,
        actual: "0",
        currency: "EUR",
        ownerName: null,
        reopened: true,
        evaluatedFor: "2026-08-15",
      }),
    ).toMatchSnapshot();
  });
});

describe("approval blocks", () => {
  const request = {
    ...base,
    requestId: "01927a00-0000-7000-8000-0000000000f1",
    subject: "BR Meta Conversion",
    summary: "BR Meta Conversion: 100000.00 → 115000.00 (reporting, 15.0%). Rationale: Black Friday",
    requesterName: "Planner Pat",
    deciderName: null,
    before: "100000.00",
    after: "115000.00",
    currency: "USD",
    stepRole: "BUDGET_OWNER",
    policyName: "Standard",
    dueAt: "2026-09-26T10:00:00.000Z",
    comment: null,
  };
  it("requested", () => expect(approvalMessage({ ...request, kind: "requested" })).toMatchSnapshot());
  it("changes requested, with the approver's comment", () =>
    expect(approvalMessage({ ...request, kind: "changes_requested", deciderName: "Owner Olga", comment: "Split this by retailer\nbefore Q4" })).toMatchSnapshot());
  it("approved bulk change (no amounts)", () =>
    expect(approvalMessage({ ...request, kind: "approved", subject: "Bulk change (24 rows)", before: null, after: null, deciderName: "Finance Fay" })).toMatchSnapshot());
  it("a request waiting on a step: its path, dates, reason, change, step and #id, with Approve / Request changes / Reject (S-005)", () => {
    const m = approvalMessage({ ...request, kind: "requested", actions: true, path: "LATAM › BR › Meta", period: { start: "2026-01-01", end: "2026-12-31" }, rationale: "Black Friday", step: { index: 0, count: 2 } });
    expect(m).toMatchSnapshot();
    const text = JSON.stringify(m.blocks);
    expect(text).toContain("*LATAM › BR › Meta*\\n“Black Friday”");
    expect(text).toContain("USD 100,000.00 → USD 115,000.00 (+15.0%)");
    expect(text).toContain("Budget owner (step 1 of 2), due 2026-09-26");
    expect(text).toContain("1 Jan – 31 Dec 2026");
    expect(text).toContain("Request #000000f1");
    expect(text.match(/"action_id":"[a-z_.]+"/g)).toEqual(['"action_id":"approval.approve"', '"action_id":"approval.changes"', '"action_id":"approval.reject"', '"action_id":"open_approval"']);
  });
  it("dates across two years, and a fall", () => {
    const m = approvalMessage({ ...request, kind: "requested", before: "200.00", after: "150.00", period: { start: "2026-10-01", end: "2027-03-31" } });
    expect(JSON.stringify(m.blocks)).toContain("1 Oct 2026 – 31 Mar 2027");
    expect(JSON.stringify(m.blocks)).toContain("(−25.0%)");
  });
  it("a reminder leads with who sent it (S-004)", () => {
    const m = approvalReminder(approvalMessage({ ...request, kind: "requested", actions: true }), "Planner <Pat>");
    expect(m.text).toBe("⏰ Reminder: 📝 Approval requested: BR Meta Conversion");
    expect(m.blocks[0]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "⏰ Planner &lt;Pat&gt; sent a reminder: this request is waiting on you." }] });
    expect(m.blocks.slice(1)).toEqual(approvalMessage({ ...request, kind: "requested", actions: true }).blocks);
  });
});

describe("mention blocks", () => {
  it("renders mentions and references by name", () => {
    expect(renderBody(`@[user:${user}] and @[group:${group}], see #[envelope:${user}]`, { [user]: "Ana", [group]: "LATAM team" })).toBe("@Ana and @LATAM team, see #envelope");
  });
  it("mention DM", () => {
    expect(
      mentionMessage({
        ...base,
        commentId: "01927a00-0000-7000-8000-0000000000a9",
        authorName: "Planner Pat",
        anchorLabel: "LATAM › Brazil › Meta",
        threadTitle: "Pacing check",
        bodyMd: `@[user:${user}] is this pacing as planned?\nLaunch moved to *March*.`,
        names: { [user]: "Owner Olga" },
      }),
    ).toMatchSnapshot();
  });
  it("long bodies are cut", () => {
    const m = mentionMessage({ ...base, commentId: user, authorName: "A", anchorLabel: "x", threadTitle: null, bodyMd: "y".repeat(800), names: {} });
    expect(JSON.stringify(m)).toContain("…");
    expect(JSON.stringify(m)).not.toContain("y".repeat(501));
  });
});

it("formats money from decimal strings", () => {
  expect(money("1250000.00", "USD")).toBe("USD 1,250,000.00");
  expect(money("-12.5", "EUR")).toBe("−EUR 12.50");
  expect(money(null, "USD")).toBe("—");
});
