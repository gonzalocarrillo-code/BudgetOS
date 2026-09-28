/**
 * The settings catalog (T-041, spec §12 and §27; plan §11.7 "settings are searchable from the
 * global search"): every admin page and the options people look for on it, indexed into
 * search_document as `entity_type = 'setting'`, so typing a setting's name in ⌘K opens that page.
 * `path` is under /w/:ws and carries the page's search params (TanStack JSON-encodes values).
 * Ids are fixed so a re-index updates the same documents.
 */

export interface SettingEntry {
  id: string;
  title: string;
  section: string;
  path: string;
  keywords: string[];
}

const q = (params: Record<string, string>) => `?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(JSON.stringify(v))}`).join("&")}`;
const id = (n: number) => `5e771000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const SETTINGS: readonly SettingEntry[] = [
  { id: id(1), title: "Granularities", section: "Registry", path: "/admin/registry", keywords: ["dimensions", "registry", "markets", "platforms", "channels", "objectives", "audiences", "granularity"] },
  { id: id(2), title: "Dimension values", section: "Registry", path: "/admin/registry", keywords: ["values", "codes", "aliases", "merge values", "retire", "value tree"] },
  { id: id(3), title: "Hierarchy templates", section: "Registry", path: `/admin/registry${q({ tab: "hierarchies" })}`, keywords: ["hierarchy", "tree order", "default template", "levels"] },
  { id: id(4), title: "Metric library", section: "Registry", path: `/admin/registry${q({ tab: "metrics" })}`, keywords: ["metrics", "KPI", "CPA", "ROAS", "CPM", "formula"] },
  { id: id(5), title: "Icons", section: "Registry", path: "/admin/registry", keywords: ["icon library", "custom icons", "upload icon"] },
  { id: id(6), title: "Approval policies", section: "Approvals", path: "/admin/policies", keywords: ["approval chain", "approvers", "auto-approve", "thresholds", "self-approval", "manual results policy"] },
  { id: id(7), title: "Pacing rules", section: "Alerts", path: "/admin/rules", keywords: ["alerts", "over-pace", "underspend", "thresholds", "CPA over target", "notifications"] },
  { id: id(8), title: "Roles and access", section: "People", path: "/admin/roles", keywords: ["roles", "permissions", "users", "groups", "scopes", "invite", "access"] },
  { id: id(9), title: "Tags", section: "Collaboration", path: "/admin/tags", keywords: ["labels", "tag colours", "merge tags"] },
  { id: id(10), title: "Data sources", section: "Data", path: "/admin/sources", keywords: ["Snowflake", "BigQuery", "Google Sheets", "CSV", "connectors", "ingestion", "mapping wizard"] },
  { id: id(11), title: "New data source", section: "Data", path: `/admin/sources${q({ wizard: "new" })}`, keywords: ["connect", "add source", "mapping"] },
  { id: id(12), title: "Display names", section: "Naming", path: `/admin/naming${q({ kind: "display" })}`, keywords: ["naming template", "budget names", "display name"] },
  { id: id(13), title: "Match keys", section: "Naming", path: `/admin/naming${q({ kind: "match_key" })}`, keywords: ["naming template", "matching", "campaign names", "match key"] },
  { id: id(14), title: "Workspace templates", section: "Workspaces", path: "/admin/templates", keywords: ["new workspace", "create workspace", "template", "default agency"] },
  { id: id(15), title: "Demo data", section: "Workspaces", path: "/admin/templates", keywords: ["remove demo data", "purge", "sample data"] },
  { id: id(16), title: "Guided tours", section: "Onboarding", path: "/admin/tours", keywords: ["tours", "onboarding", "walkthrough", "help"] },
  { id: id(17), title: "Manual results", section: "Data", path: "/sources/manual", keywords: ["manual entry", "offline", "TV", "out of home", "print", "radio", "paste results"] },
  { id: id(18), title: "Period closures", section: "Finance", path: "/closures", keywords: ["close period", "restate", "lock budgets", "month end", "quarter end"] },
  { id: id(20), title: "Fiscal calendar", section: "Finance", path: "/admin/periods", keywords: ["quarters", "4-4-5", "fiscal year", "periods", "partitions", "reopen quarter", "close quarter"] },
  { id: id(22), title: "Workspace", section: "Settings", path: "/admin/workspace", keywords: ["workspace name", "rename workspace", "currency", "slug", "settings"] },
  { id: id(23), title: "Settings", section: "Settings", path: "/admin/settings", keywords: ["admin", "configuration", "preferences"] },
  { id: id(21), title: "Slack", section: "Notifications", path: "/admin/slack", keywords: ["Slack bot", "Slack channel", "alerts in Slack", "approve from Slack", "/budget command", "notifications", "integrations"] },
  { id: id(19), title: "Unmatched spend", section: "Data", path: "/sources", keywords: ["unmatched", "data to map", "coverage", "rejected rows"] },
];

export const settingById = (settingId: string): SettingEntry | undefined => SETTINGS.find((s) => s.id === settingId);
