import { Prisma } from "@prisma/client";
import type { Tx } from "./sql.js";

export interface DimensionValuePathRow {
  id: string;
  dimensionId: string;
  code: string;
  label: string;
  parentValueId: string | null;
  path: string;
}

export interface UpsertDimensionValueInput {
  id: string;
  dimensionId: string;
  code: string;
  label: string;
  parentValueId: string | null;
  aliases: string[];
  externalIds: Record<string, string>;
}

export async function upsertDimensionValue(
  tx: Tx,
  row: UpsertDimensionValueInput,
): Promise<{ id: string; path: string }> {
  const aliases =
    row.aliases.length === 0
      ? Prisma.sql`ARRAY[]::text[]`
      : Prisma.sql`ARRAY[${Prisma.join(row.aliases)}]::text[]`;
  const saved = await tx.$queryRaw<Array<{ id: string; path: string }>>`
    INSERT INTO dimension_value (id, dimension_id, code, label, parent_value_id, aliases, external_ids)
    VALUES (
      ${row.id}::uuid,
      ${row.dimensionId}::uuid,
      ${row.code},
      ${row.label},
      ${row.parentValueId}::uuid,
      ${aliases},
      ${JSON.stringify(row.externalIds)}::jsonb
    )
    ON CONFLICT (dimension_id, code) DO UPDATE
      SET label = EXCLUDED.label,
          parent_value_id = EXCLUDED.parent_value_id,
          aliases = EXCLUDED.aliases,
          external_ids = EXCLUDED.external_ids
    RETURNING id::text AS id, path::text AS path`;
  const inserted = saved[0];
  if (inserted === undefined) {
    throw new Error(`dimension value ${row.code} was not saved`);
  }
  return inserted;
}

export async function dimensionValuePaths(tx: Tx, dimensionIds: string[]): Promise<DimensionValuePathRow[]> {
  if (dimensionIds.length === 0) {
    return [];
  }
  const ids = Prisma.join(dimensionIds.map((id) => Prisma.sql`${id}::uuid`));
  return tx.$queryRaw<DimensionValuePathRow[]>`
    SELECT id::text AS id,
           dimension_id::text AS "dimensionId",
           code,
           label,
           parent_value_id::text AS "parentValueId",
           path::text AS path
    FROM dimension_value
    WHERE dimension_id IN (${ids})
    ORDER BY path`;
}

/** Rewrites envelope_dimension and the jsonb mirror. Returns affected envelope ids. */
export async function rewriteMergedValue(
  tx: Tx,
  args: { dimensionKey: string; fromValueId: string; intoValueId: string; intoCode: string },
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ envelope_id: string }>>`
    WITH affected AS (
      SELECT envelope_id FROM envelope_dimension WHERE value_id = ${args.fromValueId}::uuid
    ),
    updated_json AS (
      UPDATE envelope e
      SET dimension_values = jsonb_set(
        e.dimension_values,
        ARRAY[${args.dimensionKey}]::text[],
        to_jsonb(${args.intoCode}::text),
        true
      )
      WHERE e.id IN (SELECT envelope_id FROM affected)
      RETURNING e.id
    ),
    updated_link AS (
      UPDATE envelope_dimension
      SET value_id = ${args.intoValueId}::uuid
      WHERE value_id = ${args.fromValueId}::uuid
      RETURNING envelope_id
    )
    SELECT l.envelope_id::text AS envelope_id
    FROM updated_link l
    JOIN updated_json j ON j.id = l.envelope_id`;
  return rows.map((row) => row.envelope_id);
}

export async function insertRewriteAudits(
  tx: Tx,
  args: {
    envelopeIds: string[];
    actorId: string | null;
    actorType: "user" | "system" | "mcp";
    fromValueId: string;
    intoValueId: string;
    requestId: string;
  },
): Promise<void> {
  if (args.envelopeIds.length === 0) {
    return;
  }
  const ids = Prisma.join(args.envelopeIds.map((id) => Prisma.sql`${id}::uuid`));
  await tx.$executeRaw`
    INSERT INTO audit_event (workspace_id, actor_id, actor_type, action, entity_type, entity_id, before, after, request_id)
    SELECT e.workspace_id,
           ${args.actorId}::uuid,
           ${args.actorType},
           'envelope.dimension.rewritten',
           'envelope',
           e.id,
           jsonb_build_object('valueId', ${args.fromValueId}),
           jsonb_build_object('valueId', ${args.intoValueId}),
           ${args.requestId}
    FROM envelope e
    WHERE e.id IN (${ids})`;
}
