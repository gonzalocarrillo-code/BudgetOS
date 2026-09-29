# ADR-063: Home is each person's desk

## Status

Accepted. Extends ADR-035 (Home, tours and templates); follows `docs/HOME_OVERVIEW_PLAN.md` §3.1 and decisions G1, G4 and G5.

## Context

Home showed every role the same page. Alerts appeared only when assigned to the caller, and none of the golden's were. Approvals appeared only when a policy routed a step to them, and mentions were rare. So six personas got the same eight unmatched spend rows and the same two budget strips. Meanwhile the four summary tiles repeated the Overview's.

## Decision

**What waits on a person** (`GET /me/home`, `waitingOnMe`):

- Approvals they can decide now, as before. Each now carries a readable card: the budget's name (or a bulk change's rationale), how many budgets it changes, and the approved total before and after with the change in percent. These are computed on the server.
- **Unsent drafts:** the open draft of a live budget, written by them and still in DRAFT.
- **Alerts on budgets that are theirs,** grouped per top-level budget with the count per rule. An alert is theirs when:
  - it is assigned to them;
  - it is on a budget they own, or on one under a budget they own;
  - or it falls inside a Budget owner role's scope. A workspace-wide Budget owner owns every budget.

  Other roles (planners, approvers, finance, viewers, admins) are not made responsible for pacing alerts by their role alone; they see them on the Overview.
- **Unmatched spend and failed source runs** only for people who can fix them (`source.manage`, decision G5).
- **Quarters to close,** for people who close them (`closure.close`): quarters ending in the next 14 days or ended in the last 30, not closed, with how many budgets in them are in draft or waiting. The workspace's own quarter rows win over calendar quarters.
- Mentions in open threads, as before.

**Also on Home:** their open requests with the role each waits on (`sent`); per top-level budget, what remains, whether they own it, its open alerts and budgets waiting; recents with the audit action and where the thing sits; and the pulse. The pulse is the Overview headline's numbers (budget, % spent, pace, open alerts, the workspace's approval queue) in one line, replacing the four tiles (decision G1).

**Deciding:** Home's Decide opens the request in a side sheet (decision G4). The sheet uses the same parts and the same command as the request page. A decision refreshes Home, the inbox and the Overview.

**Alerts page:** `GET /alerts?under=` lists a budget's whole subtree. The page takes `rule` and `under` in its URL, so each group links to its alerts.

## Consequences

- An approver with nothing assigned sees "Nothing is waiting on you", which is true, instead of the workspace's data chores.
- A budget owner's desk can be long in a busy workspace; groups are capped at six top-level budgets, and the whole list at ten items.
- Setting budget owners (`envelope.owner_id`) has no UI yet; once it does, owners get the alerts on their budgets without a Budget owner role.
