import { renderTemplate, type NamingChip, type NamingTemplateT } from "@budget/domain";
import type { Tx } from "./sql.js";

/**
 * Spec §24.2: `envelope.display_name` and `envelope.match_key` from the workspace's active naming
 * templates, in one batched UPDATE … FROM per chunk. Called on naming.changed / registry.changed
 * (rollup worker) and on envelope create / move for that envelope. No active template of a kind
 * clears that column (the grid falls back to the envelope's name).
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** `FY2026 Q4` for a start date, given the month the fiscal year starts (1 = January). */
export function fiscalLabel(start: string, fiscalStartMonth: number): string {
  const [y, m] = start.split("-").map(Number) as [number, number];
  const offset = (m - fiscalStartMonth + 12) % 12;
  const fy = fiscalStartMonth === 1 ? y : m >= fiscalStartMonth ? y + 1 : y;
  return `FY${fy} Q${Math.floor(offset / 3) + 1}`;
}

export async function activeNamingTemplates(tx: Tx, workspaceId: string): Promise<Partial<Record<"display" | "match_key", NamingTemplateT>>> {
  const rows = await tx.namingTemplate.findMany({ where: { workspaceId, isActive: true } });
  return Object.fromEntries(
    rows.map((r) => [r.kind, { kind: r.kind as "display", chips: r.chips as NamingChip[], casing: r.casing as "original", whitespace: r.whitespace as "keep", stripAccents: r.stripAccents } satisfies NamingTemplateT]),
  );
}

/** Code → label for every dimension value the envelopes use, keyed by dimension key. */
export async function dimensionLabels(tx: Tx, orgId: string, workspaceId: string): Promise<Map<string, Map<string, string>>> {
  const dims = await tx.dimension.findMany({ where: { orgId, OR: [{ workspaceId: null }, { workspaceId }] }, select: { id: true, key: true } });
  const values = await tx.dimensionValue.findMany({ where: { dimensionId: { in: dims.map((d) => d.id) } }, select: { dimensionId: true, code: true, label: true } });
  const keyOf = new Map(dims.map((d) => [d.id, d.key]));
  const out = new Map<string, Map<string, string>>();
  for (const v of values) {
    const key = keyOf.get(v.dimensionId);
    if (!key) continue;
    if (!out.has(key)) out.set(key, new Map());
    out.get(key)?.set(v.code, v.label);
  }
  return out;
}

export async function recomputeNames(tx: Tx, workspaceId: string, envelopeIds: string[] | null = null): Promise<number> {
  const templates = await activeNamingTemplates(tx, workspaceId);
  // Given envelopes (create / move) and no template: nothing to render — switching a template off
  // already cleared every name, workspace-wide.
  if (envelopeIds !== null && !templates.display && !templates.match_key) return 0;
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { orgId: true, fiscalYearStartMonth: true } });
  const labels = templates.display || templates.match_key ? await dimensionLabels(tx, ws.orgId, workspaceId) : new Map<string, Map<string, string>>();
  let updated = 0;
  let cursor: string | undefined;
  for (;;) {
    const envs = await tx.envelope.findMany({
      where: { workspaceId, ...(envelopeIds ? { id: { in: envelopeIds } } : {}), ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, dimensionValues: true, startDate: true, endDate: true },
      orderBy: { id: "asc" },
      take: 5000,
    });
    if (envs.length === 0) break;
    const render = (t: NamingTemplateT | undefined, e: (typeof envs)[number]) => {
      if (!t) return null;
      const dv = e.dimensionValues as Record<string, string>;
      const dims = Object.fromEntries(Object.entries(dv).map(([k, code]) => [k, { code, label: labels.get(k)?.get(code) ?? code }]));
      const start = iso(e.startDate);
      const out = renderTemplate(t, { dims, period: { start, end: iso(e.endDate), fiscalLabel: fiscalLabel(start, ws.fiscalYearStartMonth) } });
      return out === "" ? null : out;
    };
    updated += await tx.$executeRaw`
      UPDATE envelope e SET display_name = t.d, match_key = t.k
      FROM unnest(${envs.map((e) => e.id)}::uuid[], ${envs.map((e) => render(templates.display, e))}::text[], ${envs.map((e) => render(templates.match_key, e))}::text[]) AS t(id, d, k)
      WHERE e.id = t.id AND (e.display_name IS DISTINCT FROM t.d OR e.match_key IS DISTINCT FROM t.k)`;
    cursor = envs[envs.length - 1]?.id;
    if (envelopeIds || envs.length < 5000) break;
  }
  return updated;
}
