# Budget OS — UX/UI audit and the superadmin / workspace plan

Date: 2026-09-28. Audited build: `origin/main` at `dcb5b87` (PR #82), the local stack on http://localhost:5173.
Author: UX/UI review requested by the product owner ("act like a UX/UI specialist"). Status: built on 2026-09-28 in four stacked PRs (Phase A #83, Phase C #84, Phase B #85, Phase D #86); the decisions in Part 5 stay open and the builds follow their proposals.

This document has three parts:

1. **The audit** — what a new user meets today, screen by screen, with severity and evidence.
2. **The design direction** — brand (the BudgetOS logo), the app shell, the component library and the rules that make the product read as finished software.
3. **Superadmins and independent workspaces** — the access model, the org console, workspace lifecycle, the isolation gaps to close, and the tests that prove the boundary.

Part 4 turns all of it into ordered, one-PR tasks with "done when" checks, following `AGENTS.md`. Part 5 lists the decisions only the product owner can take.

---

## 0. Summary

**The system is functionally rich and technically sound, but it does not yet read as a product.** Every screen is a title plus white cards; there is no logo, no favicon, no page titles; the controls are hand-rolled one page at a time; there is no feedback system; the shell does not stay put when a page scrolls and does not adapt below 1024 px; and a new user with a planner role cannot leave the Budgets page until they finish a six-step tour. None of these are deep problems. They are the layer a real product has and a build-the-features project skips, and they can be added without touching the data model or the planner.

**Roles and isolation are mostly right underneath and mostly wrong on the surface.** Row-level security already keeps every workspace's data apart, and an org-wide admin role exists that is a superadmin in everything but name. What is missing: the name and a home for it (an org console), workspace archive and delete, and four places where a workspace admin can see or touch things outside their workspace (the people directory, Google group sync, org-wide registry rows, the metric library). The navigation also shows every role every admin page and lets each page refuse them.

**Plan in one line:** two weeks of blockers and identity (logo, shell, tour, nav gating, contrast, feedback), three weeks of a real component library and shell v2 migrated page by page, three weeks for superadmins, the org console, workspace lifecycle and the isolation fixes, then a polish and accessibility pass. Roughly 45 engineer-days; the streams can overlap after week 2.

---

## 1. The audit

### 1.1 Method

- Build: `origin/main` at `dcb5b87`, running as `pnpm dev:local` (worktree `BudgetOS-real`, web :5173, API :3000, Postgres 5434).
- Personas: the org-wide admin (`orgAdmin`, sees every workspace), a workspace admin (`admin`) and a planner (`planner`), all from `apps/web/e2e/.auth-local/tokens.json`.
- Workspaces: **Golden** (the seeded dataset, 332 budgets) and **OpenAI** (the blank workspace created from the Agency template, 5 budgets, no spend).
- Viewports: 1440×900 and 375×812.
- Screens: Home, Overview, Budgets (tree + drawer), Approvals (inbox + request), Targets, Experiments, Alerts, Closures, Sources, Manual result entry, Search results, the ⌘K palette, Help and Profile menus, Sign-in, the access-denied page, and every admin page: Registry, Pacing rules, Roles, Tags, Settings hub, Workspace, Approval policies, Slack, Data sources, Naming templates, Fiscal calendar, Workspace templates, Tours.
- References: plan §11 (behavioural principles, screens, admin IA, home and onboarding, accessibility), spec §18 and §27, ADR-020/021 (shell and tokens), ADR-036 (settings), ADR-045 (overview), ADR-048/049/050.

Severity: **P0** blocks real use or contradicts the plan's must-haves · **P1** makes the product feel unfinished or slows every session · **P2** polish.

### 1.2 What is already good

Say this first, because the plan builds on it:

- The information architecture of the main nav is right: Home → Overview → Budgets → Approvals → Targets → Experiments → Alerts → Closures → Sources matches the plan's screen inventory (plan §11.4).
- Filters, grouping and views live in the URL; saved views work; ⌘K search with qualifiers and grouped results is genuinely better than the reference product (plan §11.3).
- The Budgets drawer (Details / History / Comments, family card, structure actions) follows "inline first, drawer second, modal never" (plan §11.1 item 3).
- Disabled controls carry a reason (tooltip), enforced by lint. The empty Overview explains what to do ("No budget has both a Country and a Platform yet…"). Home for a blank workspace has a getting-started list.
- The design tokens (ADR-021) are a coherent, calm base: cool grey page, white cards, one blue. The problem is not the palette; it is that nothing else is systematised on top of it.

### 1.3 Findings — P0

| # | Finding | Evidence | Recommendation |
|---|---|---|---|
| P0-1 | **The first-run tour hijacks navigation.** `TourLauncher` starts the first uncompleted tour on every full page load and the tour navigates to its first step (`/budgets`). Closing the tour on step 1 does not record completion, so it restarts on the next load. A planner who types `/admin/roles` or `/admin/settings` is bounced back to Budgets with "Your workspace · 1 of 6", every time, until they click through all six steps. (The "Version 34 · built-in" label on the local stack comes from several worktrees syncing different default tours into one shared database, not from admin saves.) | Planner persona: three navigations to admin pages all landed on `/budgets` with the tour open. `apps/web/src/features/home/tour-launcher.tsx:33-36`, `apps/web/src/lib/tours.ts:9-12`. | Auto-start at most once per user per tour version, only on Home, only when nothing else is open; record a dismissal on close (`tour_completion` with `dismissed_at`, or `POST /tours/:id/complete { dismissed: true }`); never navigate away from a page the user asked for — offer "Take the 2-minute tour" as a dismissible banner or toast instead. |
| P0-2 | **No product identity.** No logo or wordmark anywhere; no favicon (`apps/web/public` does not exist; the console shows 404s on load); the browser tab reads "Budget OS" on every page; the sign-in screen is a card with a token textarea; the top-left slot is the workspace pill, so the workspace name is the only brand the user sees. | Every screenshot; `apps/web/index.html`; `apps/web/src/components/sign-in.tsx`. | Part 2.1: the BudgetOS logo, favicon set, page titles ("Budgets · Golden · BudgetOS"), a branded sign-in and loading screen. |
| P0-3 | **The header and sidebar scroll away.** The shell is `min-h-screen` with `overflow-y-auto` on `<main>`, so the document itself scrolls on any page taller than the viewport (Alerts, an approval with 24 rows, Search results, Tours). Search, the workspace switcher and the nav disappear; on the approval page the Approve / Reject bar sits below the diff, off screen. | Approval detail scrolled: no header, decide bar at the bottom. `apps/web/src/components/shell.tsx:125` (`min-h-screen`). | `h-dvh` on the shell, scrolling only inside `<main>`; sticky page header with the title and primary actions; sticky decide bar on approvals. |
| P0-4 | **Every role sees every admin page.** The sidebar's Admin section (Registry, Pacing rules, Roles, Tags, Settings) and the whole Settings hub — including Workspace templates and Tours, which only the org admin can use — render for a planner, and each page then refuses ("Only workspace admins see and change roles"). Users learn what they cannot do by clicking. | Planner persona on `/admin/roles` and `/admin/settings`. `shell.tsx:51-83` has no permission gating. | Gate nav items and settings cards by the workspace's `permissions` from `/me` (and superadmin for org pages). Where a role has read-only use of a page (Registry for planners, Policies for approvers), show it read-only with a one-line note; hide the rest. |
| P0-5 | **The access-denied page is a dead end.** A user who opens a workspace URL they cannot access sees "Something went wrong — You do not have access to this workspace." with no shell, no link to their own workspaces and no sign-out. The title is wrong (it is not an error, it is a boundary) and it is the same page a superadmin gets for an archived or deleted workspace. | Planner at the OpenAI workspace URL. `apps/web/src/routes/w.$ws.tsx:41-49`. | A `403` page inside a minimal branded shell: "You don't have access to this workspace" + "Your workspaces" list + "Ask an admin" (who: the workspace's admins' names for members of the org) + Sign out. A separate 404 for "This workspace no longer exists". |
| P0-6 | **The same number differs between screens.** In the OpenAI workspace, Home says "Budget this fiscal year USD 30,000,000" and "FY2026 Media · 0 of 30,000,000", while Budgets shows FY2026 Media at USD 150,000,000 with a 150M total. Home and Overview sum *leaf* budgets; since ADR-050 the Budgets tree sums *top-level* budgets. The Home strip is labelled with a budget's name but filters by dimension values, so a top-level budget with no dimensions "contains" every leaf in the workspace. Approval state and proration play no part. | `apps/api/src/modules/home/home.ts:44-58, 88-93`; `apps/web/src/features/explorer/row-source.ts:82-87`; `packages/query-planner/src/compile-query.ts:154-182`; verified in Postgres: 150M parent, 100M + 50M children, 10M + 20M leaves. | One definition, one planner query, used by Home, Overview and the Budgets totals row: the approved amounts of the highest budgets the caller can read (top-level, or the readable roots of their scope), prorated to the fiscal year by days; spend follows parent links. Show the leaf view as a second line ("assigned to leaves 30M · not assigned 120M"). The Home strips must find children by parent link, not by dimension match. ADR. |

### 1.4 Findings — P1

| # | Finding | Evidence | Recommendation |
|---|---|---|---|
| P1-1 | **There is no component library, only a Button.** `@budget/ui` exports `Button`, `cn` and `t`. Every input, select, textarea, popover, menu, tab bar, chip, table and drawer is written by hand in the route or feature file with its own Tailwind string. Consequences visible on screen: three different input heights and radii; the workspace switcher and period pickers are native `<select>`s (no search, no icons, no keyboard type-ahead worth the name); the Help and Profile menus are absolutely-positioned divs that do not close on Escape or on an outside click and can be open at the same time. | Help + Profile open together on Home; `packages/ui/src/index.ts`; `apps/web/src/components/shell.tsx:132-146, 195-241`; `features/home/tour-launcher.tsx:45-52`. | Part 2.3: build the missing primitives on Radix (already a dependency for Tooltip and Slot; MIT) as shadcn-style components in `@budget/ui`, then migrate page by page. |
| P1-2 | **Colour contrast fails WCAG AA** (plan §11.8 targets AA). Measured on the tokens: muted text `#6b7a90` on white 4.36:1 (needs 4.5), subtle numbers `#9facc0` 2.30:1, white on primary `#1877f2` 4.23:1 (every primary button), success `#12a37a` 3.21:1, warning `#e8a317` 2.17:1, destructive `#e5484d` 3.91:1 as text, input border `#dfe4eb` 1.28:1 (component boundaries need 3:1). | `packages/ui/src/tokens.css`; ratios computed with the WCAG 2.x formula. | Part 2.2: `--muted-foreground #5b6b80` (5.4:1), `--subtle-foreground #66748a` (4.7:1), buttons and links on `#1868d8` (5.2:1, already the `secondary-foreground` token) keeping `#1877f2` for fills without text, darker status text tokens with tinted backgrounds for chips, `--input #c9d2de` for field borders. Validate with the design team; keep the look, fix the ratios. |
| P1-3 | **No feedback system.** Mutations succeed silently or show an inline green line; errors are inline red text under the form; there is no toast, no undo, no optimistic state on edits outside the grid. The `role="status"` live region in the shell exists but nothing writes to it. | Settings › Workspace ("Saved" inline), Roles, Tags, Rules. `shell.tsx:189`. | A toast queue (Radix Toast) with success / error / undo, used by every mutation; inline errors stay for field validation only. Loading skeletons for lists and tiles. |
| P1-4 | **Status vocabulary is inconsistent.** The grid shows "Approved" (a word, per feedback round 4); search results, the ⌘K palette and the approvals inbox show lowercase `approved`, `active`, `pending` chips; alerts show "Warning" / "Critical" in coloured chips; closures show "Restated" with an icon. Same concept, four renderings. | Search results, palette, Approvals inbox, Alerts, Closures screenshots. | One `StatusChip` in `@budget/ui` with a fixed vocabulary (Draft, Waiting for approval, Approved, Locked, Archived, Active, Paused, Critical, Warning, Info, Restated…), colour + icon + label, never colour alone. Used everywhere, including the palette. |
| P1-5 | **Not usable below ~1100 px.** At 375 px the sidebar keeps its 240 px, the header overflows (search collapses to an icon, the user name is cut), tiles truncate ("USD 1,107,799…."). Approvers and budget owners will open Slack links on phones (the plan's inbox principle, §11.1 item 6). | 375×812 screenshots of Budgets and Overview. | Shell v2 (Part 2.4): icon rail ≤ 1280 px, off-canvas nav ≤ 768 px, header that wraps, list screens (Approvals, Alerts, Home) as card lists on phones; the grid stays desktop-first with a clear message. |
| P1-6 | **Numbers get cut off.** The grid totals row shows "USD 150,000,00…" in the OpenAI workspace; Overview tiles truncate at narrow widths. | Budgets (OpenAI), Overview at 375 px. | Tabular figures everywhere (`font-variant-numeric: tabular-nums`), compact notation with the exact value in a tooltip when a cell is narrower than its number, minimum column widths for money. |
| P1-7 | **The Budgets toolbar has twelve controls in one row:** Tree / Pivot / Timeline, New budget, Add child, Move under…, Split, Merge, Hierarchy, Period, Saved views, Save view, Add filter, Select. The structure actions are also in the drawer, where they belong. | Budgets screenshot. | Keep view switch, period, filter bar, saved views and New budget in the toolbar; move Add child / Move / Split / Merge to the drawer and a row context menu; Select becomes a checkbox column that appears on hover. |
| P1-8 | **Alerts is a wall of buttons.** Three actions plus "Add tag" on every row (ten rows = forty buttons); no bulk selection, no grouping, no sort; the same rule name repeats down the column. | Alerts screenshot. | Row actions on hover and in a kebab; checkbox bulk bar (acknowledge / snooze / resolve / tag N alerts); group by rule or budget; sort by value vs threshold; severity as a chip filter (already there). |
| P1-9 | **Targets is a bare list.** No create or import action, no filter, no empty state, a "Draft —" column that is empty on every row, scope shown as codes ("LATAM MX"). | Targets screenshot. | Filter bar shared with Budgets, "New target" and "Import" actions, labels with a code tooltip, the Draft column only when a draft exists, an empty state that links to the metric library. |
| P1-10 | **Approvals: the inbox lacks the context the plan promises** (diff, conversation, pacing in one place) and the request page's decide bar is off screen below the diff; "Reject" is disabled with the reason only on hover. | Approvals inbox and request screenshots. | Inbox rows with amount delta, requester avatar, due date, step chip and a "3 comments" indicator; a sticky decide bar on the request page with the comment field beside the buttons; the reason for a disabled Reject shown as helper text, not only a tooltip. |
| P1-11 | **Settings information architecture is doubled.** The sidebar has an Admin section (Registry, Pacing rules, Roles, Tags) and a Settings hub with a second nav strip for eight more pages; the plan (§11.6) groups settings by owner and scope. Terminology drifts: "Sources" (nav) vs "Data sources" (settings) vs "Set up sources" (link); "Registry" vs "Granularities" vs "dimensions". | Settings hub, strip, sidebar. | One Settings area with a grouped left nav (Workspace · Taxonomy · Governance · Pacing & alerts · Data · Integrations · Views & defaults · People), the four day-to-day pages kept in the main sidebar as shortcuts, and the org-level pages moved to the org console (Part 3). One name per concept. |
| P1-12 | **The workspace switcher is a native select** with a letter avatar; no search, no "manage workspaces", no hint of your role, and for a superadmin it is the only way to see other workspaces. | Header. | A proper menu (Radix DropdownMenu / cmdk): search, workspace list with role, "Manage workspaces" for superadmins, keyboard navigation. |
| P1-13 | **Registry is dense and its two scopes are unexplained.** "This workspace" vs "Org-wide defaults" appear as two sidebar groups; org-wide rows cannot be edited by a workspace admin and the page does not say why; the icon library grid dominates the form. | Registry screenshot. | Label org-wide rows "Shared · managed by superadmins", show a read-only state with a link to the org console, collapse the icon grid behind a picker, and add a short "what is a granularity" intro. Part 3.4 changes what is org-wide by default. |
| P1-14 | **Empty and loading states are uneven.** Home and Overview have good empty states; Targets, Closures (right card without periods), Sources runs, Search with no hits and several admin lists show a thin line or nothing; there are no skeletons while data loads (tiles pop in). | Screenshots; OpenAI workspace. | An `EmptyState` component (icon, one sentence, one action) and `Skeleton` rows/tiles, applied per screen. |

### 1.5 Findings — P2

| # | Finding | Recommendation |
|---|---|---|
| P2-1 | Help menu lists tours only. | Add keyboard shortcuts, "What's new", a link to the runbooks, the build version. |
| P2-2 | Profile popover edits only the name; sign-out is a separate top-bar button. | One user menu: name and email, role in this workspace, "Edit name", theme (later), sign out. |
| P2-3 | Browser tab title never changes. | `document.title` per route: "Approvals · Golden · BudgetOS". |
| P2-4 | Closures: "Close a period" is disabled with the reason only on hover; the period input expects a magic string ("2026-Q3"). | Period picker (the same one as the Explorer) and helper text. |
| P2-5 | Overview legend and cell hints are tiny (11 px). | 12 px minimum; legend as chips. |
| P2-6 | Home "Recent" repeats items (LATAM twice in the OpenAI workspace). | De-duplicate by entity id; show type icons. |
| P2-7 | Sign-out and Help sit at equal weight in the header. | Sign-out into the user menu; Help as an icon button. |
| P2-8 | No dark mode (ADR-021 leaves it undefined). | Tokens are ready for it; ship after the component migration. |
| P2-9 | The Budgets grid text renders through a canvas (Glide) in the system UI face, which looks slightly different from the DOM text around it. | Match the grid's font stack and size to the tokens; consider bundling a brand face (Decision D5). |
| P2-10 | Two 404s on every load (no favicon, no manifest). | Part 2.1. |

### 1.6 Design-system debt in numbers

Counted over `apps/web/src` (non-test `.tsx`), 2026-09-28:

| What | Count | Detail |
|---|---|---|
| Native `<select>` | 42 in 20 files | workspace switcher, period pickers, rows × columns, rule editor, mapping wizard |
| Native `<input>` / `<textarea>` | 95 / 9 | 65 text, 17 checkbox, 6 date; 18 files define their own `const field = "…"` class string, with 11 different values |
| Distinct input styles | 13 | after removing layout classes: `h-9` 59 vs `h-8` 54 vs `h-7` 2; `rounded-md` 73 vs `rounded-lg` 43; 60 have a focus style, 56 do not |
| Hand-rolled tables | 19 in 14 files | no shared header, sorting, selection or hover-action pattern |
| Modals / drawers / menus | 6 / 3 / 4 | two z-index layers (`z-30`, `z-40`), drawers 28 rem or 30 rem; none traps focus, returns focus or closes on an outside click; Escape works in 2 of 13 (only while focus is inside); the Help menu has `role="menu"` but no arrow keys; only the ⌘K palette (cmdk on Radix Dialog) behaves |
| Status chips | 12 (6 components, 6 inline) | 4 duplicated colour maps; lowercase raw values in 4 places, i18n words in 6; "Pending" is "Waiting for approval" in the drawer and "pending" in the inbox |
| Tab patterns | 4 | segmented pill `role="tablist"` (5 pages), underline (3, one with arrow keys), router `activeProps` (shell), `aria-pressed` chips (3) |
| Mutations | 59 | errors: 73 inline `role="alert"` messages in 39 files; success: 15 inline `role="status"` lines (some banners, some bare text); 2 mutations show nothing; no toast anywhere; the shell's live region is never written |
| Empty states | 13 of 21 list screens | missing on Budgets (blank grid, "0 rows"), Policies, Rules, Fiscal calendar, Tours, Templates, Roles, Registry |

This is the concrete case for Part 2.3: one library, one migration, one lint rule.

---

## 2. Design direction: from "built" to "product"

The goal the owner stated: the stack is great, the software does not yet feel real. In practice that gap is six things: identity, a shell that behaves, one component vocabulary, feedback, responsiveness, and consistent typography and numbers. None of them changes what the screens do.

### 2.1 The BudgetOS logo and identity

**Name.** The code and strings say "Budget OS"; the owner writes "budgetos". Recommendation: the product is **BudgetOS** (one word, capital B and OS) everywhere users see it — wordmark, page titles, sign-in, Slack app, emails — and `app.name` in i18n changes accordingly (Decision D1).

**Mark.** A rounded square (radius 25% of its size) in `--primary`, carrying three white horizontal bars of decreasing width, top-aligned: the allocation / pacing motif that the product's own pace bars already use. At 16 px it still reads; at 24 px in the header it sits next to the wordmark. A second mark option: a bold "B" whose two bowls are the bars. The design team picks; both are drawable as a single SVG path.

**Wordmark.** "Budget" in regular weight, "OS" in semibold, both in a geometric grotesque (Inter Tight or Manrope, both OFL-1.1). Because font files are outside the licence allowlist (AGENTS §4), the wordmark is shipped as **outlined SVG paths**, not as text set in a webfont, so no font is bundled. Decision D5 asks whether to allow OFL fonts for the UI itself.

**Deliverables (a package, not a picture):**

- `packages/ui/src/brand/logo.tsx`: `<Logo variant="full" | "mark" | "wordmark" size={24} tone="color" | "mono" | "inverse" />`, SVG inline, `role="img"` with `aria-label="BudgetOS"`.
- `apps/web/public/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` (180), `icon-512.png`, `manifest.webmanifest`; `<link>`s in `index.html`.
- Header: mark + wordmark at the far left (32 px tall block), a hairline divider, then the workspace switcher. The mark alone below 768 px.
- Sign-in: mark + wordmark, one sentence, the Google button (Identity Platform, GCP phase) or the token field in dev, the version in the footer.
- Loading and error pages, the 403 / 404 pages, the Slack app icon and `openapi.json` title use the same asset.
- `document.title` per route: "{Page} · {Workspace} · BudgetOS".

### 2.2 Tokens: keep the look, fix the ratios

Change values, not names (ADR-021 rule), so nothing else moves:

| Token | Today | Proposed | Why |
|---|---|---|---|
| `--muted-foreground` | `#6b7a90` (4.36:1) | `#5b6b80` (5.4:1) | helper text at 12–14 px |
| `--subtle-foreground` | `#9facc0` (2.30:1) | `#66748a` (4.7:1) | secondary numbers |
| `--primary` for text and button fills with text | `#1877f2` (4.23:1) | `#1868d8` (5.2:1) | buttons, links; keep `#1877f2` for bars, focus ring, active nav (white 15 px medium text on the active nav item is the one place to check with the design team) |
| `--input` | `#dfe4eb` (1.28:1) | `#c9d2de` (≈1.9:1 on white; fields also get a 1 px inset shadow) or a 2 px border on focus | WCAG 1.4.11 asks 3:1 for the boundary of a control; reach it with border + inner shadow, or accept the industry-standard lighter border and a strong focus ring (Decision D6) |
| status text | `#12a37a`, `#e8a317`, `#e5484d` | text tokens `#0e7c5c`, `#9a6200`, `#c8383d` on tinted chips `#e7f7f1`, `#fff4dc`, `#fdecec` | chips readable, fills unchanged |

Add tokens the components will need: `--radius-sm/md/lg` are there; add `--shadow-sm/md/lg`, `--z-*` layers, `--font-numeric` (tabular), spacing scale in Tailwind config, and the four status pairs above.

### 2.3 The component library (`@budget/ui`)

Build these once, on Radix primitives, in shadcn style (MIT, no new licence risk), each with a story-like `*.test.tsx` and keyboard behaviour:

| Component | Replaces today | Radix primitive |
|---|---|---|
| `Input`, `Textarea`, `NumberInput` (money, tabular, accepts 1.2M) | ~30 hand-styled inputs | — |
| `Select`, `Combobox` (searchable, async values) | native `<select>` in switcher, period, rows/columns pickers, rule editor | Select / cmdk |
| `Popover`, `DropdownMenu`, `Menubar` | Help menu, Profile menu, row actions | Popover, DropdownMenu |
| `Dialog` (confirm only), `Sheet` (right drawer) | the explorer drawer, cell editor, bulk preview | Dialog |
| `Tabs`, `SegmentedControl` | Tree/Pivot/Timeline, Details/History/Comments, inbox tabs, status filters | Tabs, ToggleGroup |
| `StatusChip`, `Badge`, `Tag` | every chip | — |
| `Toast` + `useToast()` | nothing | Toast |
| `Table` (TanStack Table, sticky header, row hover actions, selection column) | Approvals, Alerts, Targets, Rules, Sources, Roles, Tags, Search | — |
| `EmptyState`, `Skeleton`, `PageHeader` (title, description, actions, breadcrumb), `Card` (moved from web) | ad hoc | — |
| `FormField` (label, help, error, `react-hook-form` + zod) | ad hoc | — |
| `Avatar` (initials, colour from id), `Kbd`, `Tooltip` (exists) | letter avatar in the switcher | Avatar |
| `Logo` (2.1) | — | — |

Migration order: shell (switcher, menus, toasts) → forms in Settings (highest density of inputs) → list screens onto `Table` → Budgets toolbar and drawer onto `Sheet`/`Tabs` → the remaining chips. Every migrated page removes its local Tailwind strings; an eslint rule (`budget/no-raw-form-controls`: no native `<select>`, no `<input className=…>` outside `@budget/ui`) keeps it that way.

### 2.4 Shell v2

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [■ BudgetOS] │ Golden ▾   │  🔍 Search budgets, targets… ⌘K   │ ? │ 🔔 │ (GC) ▾ │  sticky, 56 px
├──────────────┼───────────────────────────────────────────────────────────────┤
│ Home         │ Budgets                              [This fiscal year ▾] [+ New]│  sticky page header
│ Overview     │ ─────────────────────────────────────────────────────────────── │
│ Budgets      │ (only <main> scrolls)                                          │
│ …            │                                                                 │
│ ──────────   │                                                                 │
│ Settings     │                                                                 │
│ ──────────   │                                                                 │
│ ⓘ Superadmin │  ← only for superadmins: "Org console"                           │
└──────────────┴─────────────────────────────────────────────────────────────────┘
```

- Header: logo, workspace switcher (menu with search and roles; "Manage workspaces" for superadmins), search, Help, notifications (in-app notifications exist in the schema; a bell with the unread count), user menu.
- Sidebar: main nav; a single "Settings" entry; the day-to-day admin shortcuts (Registry, Pacing rules, Roles, Tags) only for roles that can use them; collapses to an icon rail at ≤ 1280 px and to an off-canvas drawer at ≤ 768 px; remembers the collapsed state per person (a `localStorage` convenience, not data).
- Page header component: title, one-line description (the current intro paragraphs move here), primary action on the right, optional tabs beneath; sticky.
- Keyboard: `⌘K` search (exists), `?` opens shortcuts, `g b` / `g a` go-to shortcuts, Escape closes any layer, focus trapped in dialogs and sheets.
- Notifications: a bell that lists the in-app notifications the notify worker already writes, deep-linked.

### 2.5 Typography, numbers, density

- Scale: 22/28 page titles, 16/24 card titles, 14/20 body, 12/16 meta — the current sizes, applied consistently through `PageHeader` and `Card` instead of per page; no 11 px text.
- Numbers: tabular figures; currency code before the amount (kept); thousands separators per locale; compact ("1.2M") only where the cell cannot fit, with the exact value in a tooltip; negatives with a real minus; percentages with one decimal.
- Density: a compact / comfortable toggle on the grid and tables (spec §18.2 has it for the grid), default comfortable.
- Colour means status; icons carry it for colour-blind users; every chart has a legend (plan §11.1 item 8).

### 2.6 Feedback and motion

- Toast on every mutation: what happened, an undo where the command supports it (withdraw, unarchive, revoke), a link to the entity.
- Optimistic updates on name edits, tags, acknowledge / snooze / resolve; the grid already handles conflicts.
- 150 ms ease-out transitions on layers and hover; no animation on data.
- Skeletons on first load; a thin progress bar on route transitions.

---

## 3. Superadmins and independent workspaces

### 3.1 What exists today (facts from the code)

- **Organization → Workspace → rows.** Every tenant table carries `workspace_id` with RLS; every request runs inside `withTenant()`; the workspace comes from `:ws` or `X-Workspace-Id` and a mismatch is rejected; a workspace of another org returns the same 403 as a missing one (`apps/api/src/common/tenant.interceptor.ts:61-70`, `authenticate.ts:20-27`).
- **Roles** (`packages/domain/src/permissions.ts`): VIEWER, PLANNER, BUDGET_OWNER, APPROVER, FINANCE, DATA_ADMIN, WORKSPACE_ADMIN, ORG_ADMIN. A `role_assignment` is (workspace, principal, role, scope). **ORG_ADMIN is org-wide** (`workspace_id IS NULL`) and cannot be assigned per workspace (`access.ts:5-8`). It is already a superadmin: every action in every workspace, workspace creation, org-wide registry and metrics, templates, tours, break-glass approval.
- **The RLS bypass for org admins is deliberately narrow:** `ctx.isOrgAdmin` is true only for org-level calls with no workspace, so an org admin inside a workspace is isolated to it by RLS like everyone else (ADR-005 addendum). Good; keep it.
- **Workspace creation** is `POST /workspaces` (org admin), from a template, with optional demo data; it lives in the UI at Settings › Workspace templates *inside a workspace*. There is **no archive and no delete**; `workspace` has no status column.
- **A workspace admin's reach ends at the workspace** for data, because roles are resolved per workspace. The four exceptions are in 3.4.
- `/me` lists only the workspaces where the caller holds a role, so the switcher is already correct for non-admins.
- The role cache is 60 s per API instance (ADR-005): a revoked admin can keep access for up to a minute on other instances. Acceptable; documented in the runbook.

### 3.2 The target model

Two tiers, with a hard boundary between them:

| | **Superadmin** | **Workspace admin** |
|---|---|---|
| Storage | the existing org-wide `ORG_ADMIN` assignment (`workspace_id IS NULL`) | `WORKSPACE_ADMIN` in one workspace (scope `{}`) |
| Who | the platform team (DEPT) — a handful of people | the client's or team's owner of one workspace |
| Create / archive / restore / delete workspaces | yes (delete needs archive first + typed confirmation) | never |
| See the list of all workspaces, their status and admins | yes (org console) | no — only workspaces where they hold a role |
| Org directory: add people to the org, deactivate, see who has access where | yes | no — sees only the people with a role in their workspace; can add a person *to their workspace* by email (creates the org user if unknown) |
| Assign / revoke any role in any workspace, including workspace admins | yes | yes, inside their workspace; cannot remove the last workspace admin |
| Google Groups sync | yes (org console) | no (was: allowed with ADR-005's guard) |
| Registry: shared org-wide dimensions and values | yes | read-only on shared rows; full control of the workspace's own rows |
| Metric library | shared defaults | workspace metrics (new: `metric_definition.workspace_id`) |
| Workspace templates | create and edit | pick one when a superadmin creates their workspace; not visible otherwise |
| Tours | org defaults | their workspace's tours (was: org admin only) |
| Everything else (policies, rules, tags, naming, calendar, closures, sources, Slack, exports, saved views) | yes | yes, in their workspace |
| Break-glass force approval | yes, with reason | no |
| Enter any workspace | yes, with a visible "Superadmin" badge and audit note | — |

**Naming.** Keep the enum value `ORG_ADMIN` in the database and code (renaming touches SQL functions, migrations, the permission matrix, e2e personas and Slack, for no functional gain); present it as **Superadmin** in every string (`role.org_admin = "Superadmin"`), in the docs and in this plan. If the owner prefers the code to match (Decision D2), an `ALTER TYPE "Role" RENAME VALUE` migration plus a mechanical rename can follow as its own PR.

**Why not three tiers?** The owner's requirement is "superadmins create and delete workspaces; workspace admins cannot touch other instances". Two tiers satisfy it. A client-level admin over several workspaces (a client org inside the agency org) would be a third tier; the model allows it later by giving `ORG_ADMIN` a scope or by nesting organizations, and nothing in this plan blocks that.

### 3.3 The org console (`/org`)

Superadmin-only routes, outside any workspace, with the same shell (logo, user menu) and their own left nav:

| Route | Contents |
|---|---|
| `/org` → `/org/workspaces` | Table: name, slug, currency, fiscal-year start, status (Active / Archived), members, budgets, last activity, admins (avatars). Actions per row: Open, Archive / Restore, Delete (archived only). "New workspace" opens a wizard: name, slug (auto), currency, fiscal year start, template, demo data, first workspace admin (email). Ends on the new workspace's Home with a toast. |
| `/org/workspaces/:id` | Detail: settings summary, admins, members, data sources, Slack link, storage counts, audit tail; the archive / delete controls with their consequences spelled out. |
| `/org/people` | Org directory: every person and group, active / inactive, "signed in", the workspaces where they hold roles (chips), deactivate / reactivate, add by email, Google Groups sync. |
| `/org/templates` | Workspace templates (moved from Settings). |
| `/org/tours` | Org-default tours (moved). Workspace tours stay in each workspace's Settings. |
| `/org/registry` | Shared dimensions, values and metrics (org-wide rows), with the list of workspaces using each. |
| `/org/audit` (later) | Org-level audit search and export. |

Entry points: "Manage workspaces" in the workspace switcher; a "Superadmin" item at the bottom of the sidebar; `/` for a superadmin with no workspace goes to `/org`. Inside a workspace a superadmin sees a small "Superadmin" chip beside the workspace name; their actions carry `actorContext: "superadmin"` in `audit_event.details`.

### 3.4 Isolation gaps to close

| # | Gap | Where | Change |
|---|---|---|---|
| I-1 | The Roles page lists **every person and group in the org** to a workspace admin, with names and emails of people who only work in other workspaces. | `GET /workspaces/:ws/members` → `admin/queries/people.ts` ("the org's people and groups") | Return only principals with a role in `:ws` (plus groups that grant a role there). Adding a person: `POST /workspaces/:ws/members` becomes `user.manage` and takes email + name + role; it creates the org user if unknown and assigns the role in this workspace only. Looking up an existing person is by exact email, never by browsing. |
| I-2 | **Google Groups sync from a workspace** rewrites org-level group membership (ADR-005 guards escalation but not visibility or side effects). | `POST /workspaces/:ws/groups/sync` (`user.manage`) | Permission `org.admin`; the route moves to `POST /org/groups/sync`; the workspace Roles page shows groups read-only. |
| I-3 | **Templates seed org-wide dimensions**, so new workspaces share registry rows they cannot edit ("Only an org admin can change an org-wide dimension"); a workspace admin cannot add a country value in their own workspace. | `workspaces.ts:82-92`; `registry/commands/create-dimension.ts:30-31`; `dimensions.ts:23-25` | Templates create **workspace-scoped** dimensions and values by default (`workspace_id = ws`). Org-wide rows remain as an optional "shared" layer managed in `/org/registry`, labelled in every workspace as "Shared · managed by superadmins". Existing workspaces keep working; a one-off command copies shared rows into a workspace on request (Decision D4). |
| I-4 | **The metric library is org-level and superadmin-only** (`metric_definition(org_id, key)`), so a workspace cannot define its own KPI. | `registry/commands/metrics.ts:49-55` | Add nullable `metric_definition.workspace_id` (unique on `(org_id, coalesce(workspace_id), key)`), RLS like `dimension`; workspace admins manage their rows; org rows stay shared defaults. |
| I-5 | **Tours are editable only by org admins**, even a workspace's own. | `tours.ts`, `PATCH /tours/:id` (`org.admin`) | Workspace tours (`workspace_id = ws`) editable with `user.manage`; org tours in the console. |
| I-6 | **Workspace creation lives inside a workspace's Settings** and is visible to everyone as a disabled form. | `w.$ws.admin.templates.tsx` | Move to the org console; the in-workspace page keeps only "Demo data". |
| I-7 | **No archive / delete.** | `workspace` model | 3.5. |
| I-8 | **Nothing marks superadmin actions inside a workspace.** | `audit()` calls | `details.actorContext = "superadmin"` when `auth.isOrgAdmin`; the History tab and Slack messages show "as superadmin". |
| I-9 | The Slack link is per workspace (good), but `Admin › Slack` shows the bot token *names* to any `user.manage`; fine. Secrets never reach the browser (verified: only Secret Manager names). | — | No change; keep the test. |

### 3.5 Workspace lifecycle

**Schema** (Prisma-owned, one migration, reversible):

```prisma
model Workspace {
  …
  status     WorkspaceStatus @default(ACTIVE)   // ACTIVE | ARCHIVED
  archivedAt DateTime?  @map("archived_at") @db.Timestamptz
  archivedBy String?    @map("archived_by") @db.Uuid
  deletedAt  DateTime?  @map("deleted_at") @db.Timestamptz   // tombstone; rows purged by the worker
}
```

**Archive (reversible, immediate):** `PATCH /workspaces/:ws { status: "ARCHIVED" }` (superadmin). Effects: hidden from `/me` for everyone except superadmins (who see it under "Archived"); every write route returns `423 LOCKED` ("This workspace is archived"); reads still work; the notify, pacing and ingest workers skip it; Slack posts stop; a banner in the shell says who archived it and when, with "Restore" for superadmins. One `audit_event` (`workspace.archived`) and one outbox row (`workspace.changed`).

**Delete (irreversible, two steps):** `DELETE /workspaces/:ws` requires `status = ARCHIVED`, the superadmin typing the workspace name, and a reason. It sets `deleted_at` (tombstone), removes the workspace from every list, and enqueues `workspace.delete` on the outbox. The **purge worker** exports the workspace's audit trail to the closure sink / GCS, then deletes tenant rows in dependency order in batches (facts, search documents, rollup cache, comments, versions, envelopes, registry rows, role assignments…), and finally the `workspace` row. `audit_event` rows are kept (they belong to the org's record and `AGENTS.md` says audit is never hard-deleted): the workspace id stays valid as a reference in the org audit. A retention window before the purge runs (Decision D3, proposed 30 days, during which "Restore" undoes the delete) makes the "irreversible" step forgiving.

**Rule alignment.** AGENTS §4 says versions, approvals, decisions, comments, facts and audit rows are never hard-deleted. Deleting a workspace is the one legitimate exception for everything except audit, so it needs an ADR (ADR-052) that states it, the retention window, and that only the purge worker, never a request handler, deletes.

### 3.6 API and domain changes

| Change | Permission | Notes |
|---|---|---|
| `GET /workspaces` | `org.admin` | list with status, counts, admins |
| `POST /workspaces` | `org.admin` | exists; add `firstAdminEmail` |
| `PATCH /workspaces/:ws` `{ status, name?, slug? }` | `org.admin` | archive / restore |
| `DELETE /workspaces/:ws` `{ confirmName, reason }` | `org.admin` | 202 + job id; archived only |
| `GET /workspaces/:ws` (detail for the console) | `org.admin` | |
| `GET /org/people`, `POST /org/people`, `PATCH /org/people/:id { isActive }` | `org.admin` | directory |
| `POST /org/groups/sync` | `org.admin` | moved from the workspace route |
| `GET /workspaces/:ws/members` | `user.manage` | scoped to the workspace (I-1) |
| `POST /workspaces/:ws/members` `{ email, name, role, scope }` | `user.manage` | creates the user if unknown, assigns in this workspace |
| `DELETE /roles/:id` | `user.manage` | refuse removing the last WORKSPACE_ADMIN of a workspace (409) |
| `PATCH /tours/:id` | `user.manage` for workspace tours, `org.admin` for org tours | I-5 |
| `POST /workspaces/:ws/metrics` | `registry.manage` | workspace metrics (I-4) |
| `GET /me` | — | adds `isSuperadmin` (alias of `isOrgAdmin`), `workspaces[].status`, `archivedWorkspaces[]` for superadmins |

Domain: `WorkspaceStatus`, `UpdateWorkspaceInput` (extended), `DeleteWorkspaceInput`, `OrgPersonResponse`, `AddMemberInput`; i18n `role.org_admin = "Superadmin"`. Errors: `LOCKED` reused for archived workspaces. OpenAPI regenerated; the web client regenerated.

### 3.7 Web changes

- New route tree `org.tsx`, `org.index.tsx`, `org.workspaces.$id.tsx`, `org.people.tsx`, `org.templates.tsx`, `org.tours.tsx`, `org.registry.tsx`, gated in `beforeLoad` by `me.isOrgAdmin` (403 page otherwise).
- Switcher: "Manage workspaces" for superadmins; archived section; the role chip.
- Nav gating by permission (P0-4); the "Superadmin" badge inside a workspace.
- Roles page: workspace-scoped list; add-by-email with a role; "last admin" rule explained.
- Registry: "Shared" labels and read-only state; workspace metrics tab.
- Settings › Workspace: archive state banner; no lifecycle controls (they live in the console).

### 3.8 Tests that prove the boundary

- **Permission matrix** (`apps/api/src/common/permission-matrix.test.ts`): rows for every new route × every role; a `WORKSPACE_ADMIN` of workspace A gets 403 on every `/workspaces/wsB/*` route (the harness already has `wsB`); an archived workspace returns 423 on every write route and 200 on reads.
- **Members scope test:** a workspace admin of A never receives a user who has roles only in B.
- **RLS tests** (`packages/db/src/rls.*.test.ts`): `metric_definition` with `workspace_id`; the purge worker cannot delete outside the tombstoned workspace; `workspace.status` does not change visibility rules.
- **Domain:** `permissions.matrix.test.ts` unchanged except the Superadmin label; `eligibleApprover` unchanged.
- **Workers:** purge order and idempotency; skip-when-archived for pacing, notify, ingest.
- **e2e (Playwright):** superadmin creates a workspace from the console, archives it (writes 423 in the UI, banner), restores it, deletes it (typed name); a workspace admin sees no org console, no "Manage workspaces", no other workspaces, no other workspaces' people; a planner sees no Admin section beyond Registry read-only.
- **Golden seed:** an `ARCHIVED` workspace and a second workspace admin, with totals assertions.

---

## 4. Delivery plan

One task per PR, branch and commit conventions from `AGENTS.md`; each row is tracked in `docs/TASKS_STATUS.md` under "Product feedback, round 6". Estimates are engineer-days for one engineer who knows the repo. ADR numbers continue from ADR-051.

### Phase A — blockers and identity (≈ 9 days, week 1–2)

| ID | Task | Files (main) | Done when | Days |
|---|---|---|---|---|
| UX-001 | Tour auto-start: once per version, Home only, dismissal recorded, never navigates away from the requested page; tour version bumps only when steps change | `features/home/tour-launcher.tsx`, `lib/tours.ts`, `modules/tours`, migration `tour_completion.dismissed_at` | Playwright: a planner opens `/admin/roles` directly and stays there; closing a tour on step 1 does not bring it back after reload | 1.5 |
| UX-002 | Shell scroll: `h-dvh` shell, only `<main>` scrolls, sticky page header, sticky decide bar on approvals | `components/shell.tsx`, `components/page.tsx`, `routes/w.$ws.approvals.$id.tsx` | Playwright: header visible after scrolling the Alerts list and an approval to the bottom | 1 |
| UX-003 | Nav and settings gated by permissions; read-only Registry and Policies for non-admins | `shell.tsx`, `admin.settings.tsx`, the admin routes | Playwright per persona: planner sees no Roles / Tags / Settings pages it cannot use; viewer sees Registry read-only | 1.5 |
| UX-004 | 403 and 404 pages in a minimal branded shell with "Your workspaces" and sign-out | `routes/w.$ws.tsx`, new `components/denied.tsx` | Playwright: planner at a foreign workspace URL can reach their own workspace in one click | 1 |
| UX-005 | **BudgetOS logo, favicon set, page titles, branded sign-in** (2.1); `app.name` per Decision D1 | `packages/ui/src/brand/`, `apps/web/public/`, `index.html`, `sign-in.tsx`, a `useDocumentTitle` per route | Visual snapshot of header and sign-in; no 404s on load; tab title changes per route | 2 |
| UX-006 | Tokens with AA contrast (2.2) and the status chip pairs; `StatusChip` component and one vocabulary used everywhere (P1-4) | `packages/ui/src/tokens.css`, `status-chip.tsx`, search / palette / approvals / alerts / closures chips | A contrast test over the token pairs (vitest); Playwright text assertions use the words | 1.5 |
| UX-007 | Toast system and skeletons; every mutation reports; `EmptyState` component on the six empty screens (P1-3, P1-14) | `packages/ui/src/toast.tsx`, `skeleton.tsx`, `empty-state.tsx`; call sites | Playwright: saving the workspace name shows a toast; an empty Targets page shows the empty state | 1.5 |
| UX-008 | One "budget this fiscal year" definition (P0-6), ADR-051 | `modules/home/home.ts`, `modules/overview/overview.ts`, planner query, `explorer/row-source.ts` | `home.test.ts` / `overview.test.ts`: Home tile = Budgets total on the OpenAI-shaped fixture; the strip finds children by parent link | 1 |

### Phase B — component library and shell v2 (≈ 13 days, week 3–5)

| ID | Task | Done when | Days |
|---|---|---|---|
| DS-001 | `Input`, `Textarea`, `NumberInput`, `FormField`, `Select`, `Combobox` in `@budget/ui`; lint rule `budget/no-raw-form-controls` (warning first) | Components tested; Settings › Workspace, Roles and Tags migrated | 3 |
| DS-002 | `Popover`, `DropdownMenu`, `Dialog`, `Sheet`, `Tabs`, `SegmentedControl`, `Avatar`, `Kbd` | Help and user menus, the explorer drawer and the inbox tabs migrated; Escape and outside click close every layer; focus trapped | 3 |
| DS-003 | Shell v2 (2.4): logo + workspace menu + notifications bell + user menu; icon rail ≤ 1280 px; off-canvas ≤ 768 px; `PageHeader` | Playwright at 1440, 1024, 375: nav usable, no horizontal scroll; switcher searchable | 3 |
| DS-004 | `Table` on TanStack Table with sticky header, hover actions, selection; Approvals inbox, Alerts (bulk bar, group by rule), Targets (filters, actions), Rules, Sources, Search results migrated (P1-8, P1-9, P1-10) | Playwright: bulk-acknowledge three alerts; inbox row shows delta and comments count | 3 |
| DS-005 | Budgets toolbar slimmed; structure actions in the drawer and row menu; tabular numbers and no-truncation rules (P1-6, P1-7) | Playwright: totals never end in "…" at 1280 px; Add child reachable from the drawer and the row menu | 1 |

### Phase C — superadmins, org console, workspace lifecycle, isolation (≈ 17 days, week 4–7, can start in parallel with Phase B after DS-001)

| ID | Task | Done when | Days |
|---|---|---|---|
| ORG-001 | ADR-052 (superadmin naming, lifecycle, delete exception, retention); `role.org_admin` → "Superadmin"; `isSuperadmin` on `/me`; "Superadmin" badge; audit `actorContext` (I-8) | ADR merged; badge visible; audit row carries the context | 1 |
| ORG-002 | Workspace `status` / `archivedAt` / `deletedAt` migration; `PATCH /workspaces/:ws` archive / restore; 423 on writes; workers skip archived; banner in the shell | Permission-matrix rows; e2e archive → write refused → restore | 3 |
| ORG-003 | `DELETE /workspaces/:ws` (typed name, archived only) + purge worker with audit export and retention; `GET /workspaces` | Worker test: purge order, idempotency, audit kept; e2e delete flow | 3 |
| ORG-004 | Org console routes: workspaces list + new-workspace wizard (with first admin) + detail; "Manage workspaces" in the switcher; `/` → `/org` for a workspace-less superadmin | e2e: superadmin creates a workspace end to end in < 60 s and lands on Home | 3 |
| ORG-005 | Members scoped to the workspace; add-by-email with a role; last-admin rule; org directory page; groups sync moved to `/org` (I-1, I-2) | Test: a workspace admin of A never receives B-only people; sync 403 from a workspace | 2.5 |
| ORG-006 | Templates create workspace-scoped registry rows; "Shared" labels and read-only state; `/org/registry`; migration copy command (I-3) | Registry test: a new workspace's dimensions have `workspace_id = ws`; a workspace admin adds a value without 403 | 2 |
| ORG-007 | Workspace metrics (`metric_definition.workspace_id`, RLS, UI tab) and workspace tours editable by workspace admins (I-4, I-5) | RLS test; e2e: workspace admin adds a metric and edits a tour | 1.5 |
| ORG-008 | Permission-matrix and e2e boundary suite (3.8); golden seed additions | All rows green; `pnpm test:acceptance` green | 1 |

### Phase D — polish and accessibility (≈ 6 days, week 7–8)

| ID | Task | Done when | Days |
|---|---|---|---|
| UX-009 | Settings IA regrouped by owner (P1-11); terminology pass (one name per concept); i18n keys cleaned | Settings nav shows the seven groups; no "Sources / Data sources" split | 2 |
| UX-010 | Keyboard and focus audit: shortcuts panel (`?`), go-to keys, focus order, visible focus rings, `aria-*` on custom controls; axe run in Playwright with zero serious violations on the 18 screens | axe report in CI; shortcuts documented in Help | 2 |
| UX-011 | Home and Overview: recents de-duplicated, legend as chips, 12 px minimum, user menu with sign-out, Help menu contents (P2-1…P2-7) | Playwright snapshots | 1 |
| UX-012 | Dark mode tokens and toggle (P2-8) — optional, after the migration | Both themes pass the contrast test | 1 |

Ordering: A1–A8 in the table order (UX-001, UX-002, UX-003 unblock every persona; UX-005 and UX-006 are the visible change the owner asked for). Phase B and Phase C can run in parallel after DS-001. Phase D last.

### What stays out of scope

- Identity Platform sign-in in the browser, IAP, Secret Manager: the GCP phase (T-008, plan §16).
- Any commercial UI kit, grid or Gantt (AGENTS §4). Everything here is Radix, shadcn patterns, TanStack Table, cmdk, driver.js — all MIT.
- Client-side sorting, grouping or totals (server does it); `localStorage` for data (only the collapsed-sidebar convenience).
- A third admin tier (client-level admin); see 3.2.

---

## 5. Decisions for the product owner

| # | Decision | Proposal |
|---|---|---|
| D1 | Product name as users see it: "BudgetOS" or "Budget OS". | **BudgetOS** everywhere; keep "Budget OS" only in the master plan and spec headings. |
| D2 | Rename the role in code (`ORG_ADMIN` → `SUPER_ADMIN`) or only in the UI. | **UI only now**; a mechanical rename later if it keeps causing confusion. |
| D3 | Delete semantics: retention window before purge; what stays. | **Archive first; delete after archive with a typed name; 30-day retention with Restore; audit rows kept**; purge only by the worker. |
| D4 | Registry default for new workspaces: shared org-wide rows (today) or workspace-owned rows (independent). | **Workspace-owned by default**; superadmins may still publish shared rows from the org console. |
| D5 | Allow OFL-1.1 font files (Inter / Inter Tight) for the UI, as an exception to the code-licence allowlist. | **Yes for font files only**, by ADR: OFL is a font licence, not a code licence, and it changes nothing about redistribution of the app. Until then the wordmark ships as SVG paths. |
| D6 | Input borders: reach 3:1 (heavier fields) or keep light borders with a strong focus ring. | **Heavier border + inner shadow on fields** (the look stays calm; it is what most finance software does). |
| D7 | Mobile scope: read-and-approve on phones (Home, Approvals, Alerts, notifications) with the grid desktop-only, or full parity. | **Read-and-approve on phones**; the grid says so. |
| D8 | Who may appoint workspace admins inside a workspace. | **Workspace admins and superadmins**, never removing the last admin. |
| D9 | The first workspace admin of a new workspace. | **Named in the creation wizard** (email); the superadmin stays a superadmin, not a member. |

---

## Appendix A — screen-by-screen notes

Short notes per screen, in the order a user meets them. Items already in 1.3–1.5 are referenced, not repeated.

- **Sign-in:** bare card; needs the logo, one sentence, the Google button, the version; keep the token field behind a "developer" disclosure in dev builds only.
- **Home:** the greeting and tiles read well; the "Your budgets" strip is the P0-6 bug; "Recent" repeats items; "Saved views" shows a lone "Dmoe" view. Add data freshness ("numbers as of") which Overview already has.
- **Overview:** the strongest screen. Legend text is too small; the heatmap header row could carry platform icons from the registry; "Customise" is good. Tiles truncate below 1280 px.
- **Budgets:** the grid is fast and the drawer is right. Toolbar overload (P1-7); "Pace" column shows a bar and "0.64" — the number needs a tooltip with the formula (plan §11.1 item 8); status chips are canvas-drawn in a lighter style than DOM chips; the "(none)" fix from feedback round 1 holds.
- **Approvals:** inbox tabs fine; rows lack the delta / comments / due emphasis; the request page is a clean diff but the decision controls are off screen (P0-3, P1-10).
- **Targets:** P1-9.
- **Experiments:** fine for its size; the status chip should be the shared component.
- **Alerts:** P1-8; also the header "Value vs threshold" mixes a percentage with a ratio in the same column style.
- **Closures:** clear; the disabled reason must be visible; use the period picker.
- **Sources:** good structure (source list, runs, unmatched); "Set up sources" duplicates Settings › Data sources — one entry point.
- **Manual result entry:** good; the channel tabs with coloured dots and the "Rows to fix" panel are the right pattern to reuse elsewhere.
- **Search:** results page needs type tabs and less repetition of the path; the palette needs the shared status chip.
- **Registry:** P1-13.
- **Pacing rules:** fine; add the rule's scope and last-fired columns.
- **Roles:** the people list is the isolation gap I-1; the "Add a person" form should sit in a Sheet, not above the list; show avatars and the "Org admin" chip as "Superadmin".
- **Tags:** fine; colour swatches need labels for colour-blind users (tooltip with the colour name).
- **Settings hub and strip:** P1-11.
- **Workspace:** the read-only details (currency, slug, id) are good; add archive state and the workspace's admins.
- **Approval policies:** clear cards; the "Admins apply directly" note should be a labelled built-in policy card at the top, not a paragraph.
- **Slack:** good; the setup steps belong in a collapsible "Set up" panel once linked.
- **Data sources / Naming / Fiscal calendar / Tours:** functional; they inherit the form components in Phase B. Tours: republishing on every save is P0-1's root cause.

## Appendix B — evidence index

Screenshots taken on 2026-09-28 in the built-in browser (not stored in the repo): Home, Overview, Budgets, Budgets drawer, Approvals inbox, Approval request (top and scrolled), Targets, Experiments, Alerts, Closures, Sources, Manual entry, Search, ⌘K palette, Help menu, Profile menu, Sign-in, Access denied, Registry, Pacing rules, Roles (superadmin, workspace admin, planner), Tags, Settings hub, Workspace, Policies, Slack, Data sources, Naming, Fiscal calendar, Workspace templates (superadmin and workspace admin), Tours, OpenAI workspace Home / Budgets / Overview, Budgets and Overview at 375 px. Re-take them with `pnpm dev:local` and the persona tokens in `apps/web/e2e/.auth-local/tokens.json`.
