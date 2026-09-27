# ADR-035: Home, guided tours and workspace templates

## Status

Accepted.

## Context

T-040 (spec §27, plan §11.7) adds:

- `GET /me/home`;
- driver.js tours per role, with completion tracking;
- workspace templates with demo data and a purge;
- the `budget/no-bare-disabled` eslint rule.

The done-when:

- A new workspace from the template is usable in under 60 s.
- Each role's tour runs end to end in Playwright.
- The eslint rule fails a bare `disabled`.

The spec leaves open:

- where Home lives (the Overview is `/`);
- how a tour moves between pages;
- who edits tours;
- how "demo=true on every row" is done;
- which permission guards the org-level routes.

## Decision

**Home** is `/w/:ws/home`, first in the navigation. The Overview stays at `/w/:ws`.

`GET /me/home` returns, in this order:

1. **waitingOnMe:**
   - approvals the caller can decide now (the inbox's `assignee=me`);
   - comments mentioning them in open threads (a resolved thread waits on no one);
   - open alerts assigned to them;
   - the count of unmatched spend rows.
2. **scopes:** the top-level budgets the caller owns or whose scope their roles can read, at most 8, owned ones first. Each carries the planner's totals over that budget's live leaves this fiscal year, including `spentPct`: the screen shows % spent, as the product owner asked.
3. **recents:** the latest entities they acted on, from the audit log.
4. **pinnedViews:** their saved views and the workspace's shared ones.

Each block links to its screen with the filter preset.

**Tours.**

- **Tables:** `tour` (`workspace_id` NULL = the built-in default of a role) and `tour_completion`.
- **Steps:** `{ path?, element: '[data-tour="…"]', title, description }`. `path` (under `/w/:ws`) is an addition to the spec, so a tour can move between pages. The runner (`lib/tours.ts`, driver.js 1.8.0, MIT) navigates to the page and waits for the element.
- **Defaults:** there is one per role (planner, approver, finance, data_admin), in `seed/defaults.tours.ts`. They are written on first use by an org admin (templates page, golden seed) and every step's target has a `data-tour` attribute.
- **`GET /tours`:** returns the tours the caller's roles call for that are not completed at their version. Planner and budget owner get the planner tour; approver and budget owner the approver tour; finance the finance tour; data admin the data_admin tour.
- **Where tours start:** the shell starts the first pending one once per session, and Help lists them all (`all=true`; org admins see every role's).
- **Completion:** reaching Done posts `POST /tours/:id/complete`.
- **Editing:** org admins edit the text in Admin › Tours. Editing a default creates the workspace's own copy. Each save is a new version, so everyone in the role sees it again.

**Workspace templates.**

- The table is `workspace_template`; `org_id` NULL means built in.
- The built-in `default_agency` template is written from `seed/defaults.*.ts` (registry, the Default and "Market first" hierarchies, policies, rules, a shared "This year by market" view, the tours) whenever an org admin lists templates. It therefore always matches the code's defaults.
- `POST /workspaces` (org admins) writes, in one transaction: the workspace, its hierarchy templates, policies and rules (through the same helpers as their commands, each with its own audit and outbox row), the view and the tours, plus one `workspace.created` audit and outbox row. Org-wide dimensions the org lacks are then added through the registry commands; this is a no-op for an existing org.
- **Demo data:** `withDemoData` runs a small generator in its own transaction, rather than the full golden seed, which takes about 60 s. It creates three markets under their regions, two platforms each, approved budgets phased by month, a CPA target per market, and spend and conversions to date. It then emits `facts.loaded` so rollups, pacing and search pick it up.
- The `demo` boolean column is set on every table the generator writes (envelope, envelope_version, target, target_version, spend_fact, kpi_fact).
- **Purge:** `POST /workspaces/:ws/demo-data/purge` (`user.manage`) deletes those rows, and what hangs off demo envelopes (alerts, rule state, search documents), in one transaction. Audit rows are kept.
- **Timing:** creating a workspace with demo data took about 0.5 s in the API test and about 4 s in the browser.

**Permissions.** A new route permission, `org.admin`, is enforced by the interceptor for org-level administration: `GET /workspace-templates`, `POST /workspaces` and `PATCH /tours/:id`. The permission matrix allows it for ORG_ADMIN only.

**`budget/no-bare-disabled`** is a local eslint rule (`eslint-rules/no-bare-disabled.mjs`) applied to `.tsx` and `.jsx`.

- A JSX `disabled` needs a `reason`. A native element may state it in `title`, its tooltip.
- `disabled={false}` passes.
- It found four native controls; they already had titles, and now pass.
- The `Button` implementation sets `disabled` from its reason-carrying props under a justified disable comment.

## Consequences

- The local stack's already-seeded workspace gets the default tours once an org admin opens Admin › Workspace templates.
- The e2e seed marks every persona's tours completed, so the other specs are not interrupted. The tours spec launches each tour from Help.
- A dedicated demo-data flag on more tables (threads, approvals) is needed if the generator grows to write them.
