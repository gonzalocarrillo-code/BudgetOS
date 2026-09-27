import { DEFAULT_HIERARCHY, DEFAULT_DIMENSIONS } from "../seed/defaults.registry.js";
import { DEFAULT_POLICIES } from "../seed/defaults.policies.js";
import { DEFAULT_RULES } from "../seed/defaults.rules.js";
import { DEFAULT_TOURS } from "../seed/defaults.tours.js";
import type { Prisma } from "@prisma/client";
import type { Tx } from "./sql.js";

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

/**
 * Workspace templates (spec §27). The built-in `default_agency` template is the seed defaults
 * (registry, hierarchy template, policies, pacing rules, a sample view, tours) as one row; it is
 * written on first use so it always matches seed/defaults.*.ts at that version.
 */

export const DEFAULT_TEMPLATE_KEY = "default_agency";

export function defaultAgencyTemplate() {
  return {
    key: DEFAULT_TEMPLATE_KEY,
    name: "Agency (default)",
    description: "The default registry (market, platform, objective, audience…), a Default hierarchy, the standard approval policies and pacing rules, a sample view and a tour per role.",
    registry: DEFAULT_DIMENSIONS.map((d) => ({ key: d.key, label: d.label, dataType: d.dataType, icon: d.icon, allowedParents: [...d.allowedParents], isRequiredForLeaf: d.isRequiredForLeaf, sortOrder: d.sortOrder, values: d.values.map((v) => ({ ...v })) })),
    hierarchyTemplates: [{ name: DEFAULT_HIERARCHY.name, path: [...DEFAULT_HIERARCHY.path], isDefault: true }, { name: "Market first", path: ["country", "platform", "objective"], isDefault: false }],
    policies: DEFAULT_POLICIES.map((p) => ({ ...p })),
    rules: DEFAULT_RULES.map((r) => ({ ...r })),
    savedViews: [{ name: "This year by market", screen: "budgets", definition: { view: "pivot", groupBy: ["country"], period: { kind: "relative", preset: "current_year" } } }],
    tours: DEFAULT_TOURS.map((t) => ({ ...t, steps: t.steps.map((s) => ({ ...s })) })),
  };
}

/** The built-in template's row, (re)written from the defaults. Needs the org-admin bypass (RLS). */
export async function ensureDefaultTemplate(tx: Tx, newId: () => string): Promise<string> {
  const t = defaultAgencyTemplate();
  const existing = await tx.workspaceTemplate.findFirst({ where: { orgId: null, key: t.key }, select: { id: true } });
  const data = { name: t.name, description: t.description, registry: json(t.registry), hierarchyTemplates: json(t.hierarchyTemplates), policies: json(t.policies), rules: json(t.rules), savedViews: json(t.savedViews), tours: json(t.tours) };
  if (existing) {
    await tx.workspaceTemplate.update({ where: { id: existing.id }, data });
    return existing.id;
  }
  const id = newId();
  await tx.workspaceTemplate.create({ data: { id, orgId: null, key: t.key, ...data } });
  return id;
}

/** Steps in a fixed key order: jsonb reorders object keys, so a plain JSON.stringify would always differ. */
const canonical = (steps: unknown) =>
  JSON.stringify((Array.isArray(steps) ? steps : []).map((s: Record<string, unknown>) => [s["path"] ?? null, s["element"], s["title"], s["description"]]));

/** The built-in tours (workspace_id NULL), one per role; a new version when the defaults changed. */
export async function ensureDefaultTours(tx: Tx, newId: () => string): Promise<number> {
  let changed = 0;
  for (const t of DEFAULT_TOURS) {
    const row = await tx.tour.findFirst({ where: { workspaceId: null, role: t.role } });
    if (row === null) {
      await tx.tour.create({ data: { id: newId(), workspaceId: null, role: t.role, name: t.name, steps: json(t.steps) } });
      changed += 1;
    } else if (canonical(row.steps) !== canonical(t.steps) || row.name !== t.name) {
      await tx.tour.update({ where: { id: row.id }, data: { name: t.name, steps: json(t.steps), version: { increment: 1 }, updatedAt: new Date() } });
      changed += 1;
    }
  }
  return changed;
}
