export interface SpendFactRow {
  id: string;
  workspace_id: string;
  envelope_id: string | null;
  dimension_values: Record<string, string>;
  period_date: string;
  currency: string;
  amount: string;
  amount_reporting: string;
  fx_rate_id: string | null;
  source_system: "snowflake" | "sheets" | "bigquery" | "csv";
  source_run_id: string;
  source_row_hash: string;
  loaded_at: string;
}

export interface KpiFactRow extends Omit<SpendFactRow, "currency" | "amount" | "amount_reporting" | "fx_rate_id"> {
  metric: string;
  value: string;
  attribution_model: string | null;
}

export interface AuditEventInput {
  workspaceId: string | null;
  actorId: string | null;
  actorType: "user" | "system" | "mcp";
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  requestId?: string;
}

export interface OutboxInput {
  workspaceId: string | null;
  topic: string;
  payload: unknown;
}
