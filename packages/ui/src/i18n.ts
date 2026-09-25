/**
 * User-facing strings (AGENTS §4): every string in the UI is a key here. English only in Phase 1;
 * Spanish and Portuguese come with the Phase 2 i18n ADR. `{name}` placeholders are replaced from `vars`.
 */
const en = {
  "app.name": "Budget OS",
  "shell.workspace": "Workspace",
  "shell.search.placeholder": "Search budgets, targets, alerts… (e.g. country:BR status:pending)",
  "shell.search.submit": "Search",
  "shell.signOut": "Sign out",
  "shell.loading": "Loading…",
  "shell.navigation": "Main navigation",
  "shell.admin": "Admin",
  "auth.title": "Sign in to Budget OS",
  "auth.body": "Budget OS signs you in with your Google Workspace account through Identity Platform. Until single sign-on is connected in this environment, paste an Identity Platform ID token.",
  "auth.token": "ID token",
  "auth.submit": "Continue",
  "auth.expired": "Your session is not valid any more. Sign in again.",
  "error.title": "Something went wrong",
  "error.forbidden": "You do not have access to this workspace.",
  "error.noWorkspace": "You have no role in any workspace yet. Ask a workspace admin to add you.",
  "page.pending": "This screen arrives with {task}.",
  "nav.overview": "Overview",
  "nav.budgets": "Budgets",
  "nav.approvals": "Approvals",
  "nav.targets": "Targets",
  "nav.experiments": "Experiments",
  "nav.alerts": "Alerts",
  "nav.closures": "Closures",
  "nav.sources": "Sources",
  "nav.search": "Search",
  "page.approval": "Approval request",
  "page.experiment": "Experiment",
  "page.manualEntry": "Manual result entry",
  "admin.registry": "Registry",
  "admin.policies": "Approval policies",
  "admin.rules": "Pacing rules",
  "admin.roles": "Roles",
  "admin.tags": "Tags",
  "admin.sources": "Data sources",
  "admin.naming": "Naming templates",
  "admin.templates": "Workspace templates",
  "admin.tours": "Tours",
  "search.results": "{count} results for “{q}”",
  "search.empty": "Type a query to search this workspace.",
} as const;

export type MessageKey = keyof typeof en;

export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  return en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
