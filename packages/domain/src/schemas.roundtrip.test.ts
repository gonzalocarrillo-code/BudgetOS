import { expect, it } from "vitest";
import { z } from "zod";
import { DomainError, httpStatus, type ErrorCode } from "./errors.js";
import { can } from "./permissions.js";
import * as domain from "./index.js";

const workspaceId = "01927a00-0000-7000-8000-0000000000a1";

const samples: Record<string, readonly unknown[]> = {
  Comparator: ["eq", "descends_from", "within"],
  MeasureKey: ["budget", "pace_index"],
  AttrKey: ["status", "start_date", "name"],
  FieldRef: [
    { kind: "dimension", key: "country" },
    { kind: "measure", key: "actual" },
    { kind: "target", metric: "cpa", field: "vs_target_pct" },
    { kind: "attr", key: "owner_id" },
  ],
  RelativeDate: [
    { unit: "day", amount: -30 },
    { unit: "quarter", amount: 1, anchor: "period_end" },
  ],
  Predicate: [
    { field: { kind: "dimension", key: "country" }, op: "eq", value: "BR" },
    {
      field: { kind: "attr", key: "start_date" },
      op: "within",
      value: { unit: "day", amount: -30, anchor: "today" },
    },
  ],
  FilterGroup: [
    {
      logic: "and",
      children: [
        { field: { kind: "dimension", key: "country" }, op: "eq", value: "BR" },
        {
          logic: "or",
          not: true,
          children: [{ field: { kind: "measure", key: "pace_index" }, op: "gt", value: 1 }],
        },
      ],
    },
  ],
  PeriodSpec: [
    { kind: "fiscal", key: "2026-Q4" },
    { kind: "range", start: "2026-01-01", end: "2026-03-31" },
    { kind: "relative", preset: "current_quarter" },
  ],
  Grain: ["total", "month"],
  QueryRequest: [
    { workspaceId, period: { kind: "relative", preset: "current_quarter" } },
    {
      workspaceId,
      filter: { logic: "and", children: [] },
      groupBy: ["country"],
      measures: ["budget", "actual"],
      targets: ["cpa"],
      period: { kind: "range", start: "2026-01-01", end: "2026-12-31" },
      grain: "month",
      asOf: "2026-09-23T15:00:00.000Z",
      templateId: "01927a00-0000-7000-8000-0000000000b2",
      sort: [{ key: "budget", dir: "desc" }],
      limit: 50,
    },
  ],
  QueryRow: [
    {
      key: "row-1",
      envelopeId: workspaceId,
      path: ["LATAM", "Brazil"],
      dimensions: { country: "BR" },
      measures: { budget: "10.00", actual: null },
      status: "APPROVED",
    },
  ],
  QueryResponse: [
    {
      rows: [
        {
          key: "row-1",
          envelopeId: null,
          path: ["LATAM"],
          dimensions: { country: "BR" },
          measures: { budget: "10.00" },
          status: "APPROVED",
        },
      ],
      nextCursor: null,
      totals: { budget: "10.00" },
      dataAsOf: "2026-09-23T15:00:00.000Z",
      dataVersion: 3,
      elapsedMs: 12,
    },
  ],
  PolicyConditions: [
    {},
    {
      entityType: "envelope_version",
      amountAbs: { gte: 1000 },
      deltaPct: { lt: 0.15 },
      isOverAllocation: false,
      level: { gte: 1, lte: 4 },
      dimension: { region: ["LATAM"], platform: ["meta"] },
      daysRemaining: { lt: 14 },
      metricKey: ["cpa"],
      any: [{ entityType: "bulk_change", deltaAbs: { gte: 500 } }],
    },
  ],
  ChainStep: [
    { role: "APPROVER" },
    {
      role: "FINANCE",
      groupId: "01927a00-0000-7000-8000-0000000000c1",
      minApprovals: 2,
      timeoutHours: 24,
      escalateTo: "WORKSPACE_ADMIN",
    },
  ],
  DimensionDataType: ["ENUM", "DATE_BUCKET"],
  CreateDimensionInput: [
    {
      key: "country",
      label: "Country",
      dataType: "ENUM",
      icon: "lucide:flag",
      workspaceId: null,
    },
    {
      key: "retailer",
      label: "Retailer",
      description: "Stores",
      dataType: "TEXT",
      icon: "lucide:store",
      color: "#112233",
      allowedParents: ["country"],
      isRequiredForLeaf: true,
      sortOrder: 3,
      workspaceId,
    },
  ],
  UpdateDimensionInput: [{ label: "Retailers" }, { isActive: false, color: null }],
  RoleEnum: ["VIEWER", "WORKSPACE_ADMIN", "ORG_ADMIN"],
  ScopeFilter: [
    {},
    {
      logic: "and",
      children: [
        { field: { kind: "dimension", key: "region" }, op: "descends_from", value: "latam" },
        { logic: "or", not: true, children: [{ field: { kind: "dimension", key: "platform" }, op: "in", value: ["meta", "google"] }] },
      ],
    },
  ],
  AssignRoleInput: [
    { principalType: "user", principalId: workspaceId, role: "PLANNER" },
    {
      principalType: "group",
      principalId: workspaceId,
      role: "BUDGET_OWNER",
      scope: { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "br" }] },
    },
  ],
  GroupsSyncInput: [{ groups: [{ googleGroup: "latam-media-leads@example.com", name: "LATAM media leads", members: ["a@example.com"] }] }],
  MoneyString: ["1200.50", "-3", "0.10"],
  PhasingEntry: [{ month: "2026-10-01", amount: "400.00" }],
  CreateEnvelopeInput: [
    { name: "BR Meta Q4", dimensionValues: { country: "BR", platform: "meta" }, startDate: "2026-10-01", endDate: "2026-12-31", currency: "BRL" },
    {
      name: "BR Meta Q4",
      parentId: workspaceId,
      dimensionValues: { country: "BR" },
      startDate: "2026-10-01",
      endDate: "2026-12-31",
      currency: "USD",
      amount: "1200.00",
      phasing: [{ month: "2026-10-01", amount: "1200.00" }],
    },
  ],
  CreateDraftVersionInput: [
    { amount: "1500.00", basedOnVersionId: null },
    { amount: "900", basedOnVersionId: workspaceId, rationale: "cut", phasing: [{ month: "2026-11-01", amount: "900" }], attachments: [{ gcsUri: "gs://b/o", name: "o.pdf", sha256: "ab" }] },
  ],
  UpdatePhasingInput: [{ phasing: [{ month: "2026-10-01", amount: "10" }], basedOnVersionId: workspaceId }],
  RestoreVersionInput: [{ basedOnVersionId: null }, { basedOnVersionId: workspaceId, rationale: "back to v1" }],
  UpdateEnvelopeInput: [{ rowVersion: 1, name: "Renamed" }, { rowVersion: 3, ownerId: null, startDate: "2026-10-01" }],
  SubmitVersionInput: [{ versionId: workspaceId }],
  DecideInput: [{ decision: "approve" }, { decision: "reject", comment: "too high", channel: "slack" }],
  ExternalEvidenceInput: [{ gcsUri: "gs://evidence/po.pdf", sha256: "a".repeat(64), approverName: "Client CFO", approvedOn: "2026-10-02" }],
  WithdrawInput: [{}, { comment: "wrong month" }],
  CreatePolicyInput: [
    { name: "Standard", priority: 30, conditions: { amountAbs: { lt: 250000 } }, chain: [{ role: "BUDGET_OWNER" }, { role: "APPROVER", timeoutHours: 72, escalateTo: "FINANCE" }] },
    { name: "Auto", priority: 1, conditions: { deltaPct: { lt: 0.02 } }, chain: [], allowExternalEvidence: true },
  ],
  UpdatePolicyInput: [{ version: 1, priority: 5 }, { version: 2, isActive: false, chain: [{ role: "FINANCE", minApprovals: 2 }] }],
  BulkOperation: [
    { op: "set", amount: "100.00" },
    { op: "add", amount: "-50" },
    { op: "pct", pct: 15 },
    { op: "redistribute", parentId: workspaceId, method: "by_weights", weights: { [workspaceId]: 2 }, total: "1000" },
    { op: "copy_previous_period" },
    { op: "scale_to_total", total: "5000.00" },
    { op: "paste", rows: [{ envelopeId: workspaceId, amount: "12.34" }] },
  ],
  BulkRequest: [
    { workspaceId, selection: { envelopeIds: [workspaceId] }, operation: { op: "pct", pct: -5 }, rationale: "Q4 cut" },
    { workspaceId, selection: { filter: { logic: "and", children: [] } }, operation: { op: "set", amount: "1" }, rationale: "reset" },
  ],
  BulkPreview: [
    {
      previewId: workspaceId,
      rows: [{ envelopeId: workspaceId, path: ["LATAM", "BR"], before: "100.00", after: "115.00", delta: "15.00" }],
      totalsBefore: "100.00",
      totalsAfter: "115.00",
      capViolations: [],
      policyPreview: { name: "Standard", chain: ["BUDGET_OWNER", "APPROVER"] },
      expiresAt: "2026-10-01T00:30:00.000Z",
    },
  ],
  CsvExportInput: [{ selection: { envelopeIds: [workspaceId] } }, { selection: { filter: { logic: "and", children: [] } } }],
  CsvImportInput: [{ csv: "envelope_id,amount\n", rationale: "edited in Sheets" }],
  CsvImportReport: [{ rowsRead: 2, errors: [{ line: 3, message: "bad amount" }], preview: null }],
  MoveEnvelopeInput: [{ parentId: null, rowVersion: 1 }, { parentId: workspaceId, rowVersion: 4, rationale: "re-org" }],
  SplitEnvelopeInput: [
    { basedOnVersionId: workspaceId, rationale: "by retailer", parts: [{ name: "A", amount: "1.00" }, { name: "B", amount: "2.00", dimensionValues: { retailer: "walmart" } }] },
  ],
  AnchorType: ["envelope", "cell"],
  CommentInput: [{ bodyMd: "Looks high @[user:01927a00-0000-7000-8000-0000000000a1]", attachments: [] }, { bodyMd: "x", parentCommentId: workspaceId, attachments: [{ gcsUri: "gs://b/a.pdf", name: "a.pdf", sha256: "a".repeat(64) }] }],
  CreateThreadInput: [
    { anchorType: "envelope", anchorId: workspaceId, anchorMeta: {}, isBlocking: true, firstComment: { bodyMd: "Hold until Q4 plan", attachments: [] } },
    { anchorType: "cell", anchorId: workspaceId, anchorMeta: { month: "2026-10-01" }, title: "October", isBlocking: false, firstComment: { bodyMd: "x", attachments: [] } },
  ],
  UpdateCommentInput: [{ bodyMd: "edited" }],
  ListThreadsQuery: [{ anchorType: "target", anchorId: workspaceId }],
  SubscriptionInput: [{ entityType: "envelope", entityId: workspaceId, subscribed: true }, { entityType: "thread", entityId: workspaceId, subscribed: false }],
  CreateTagInput: [{ name: "q4-push", kind: "label" }, { name: "Team LATAM", color: "#12AB34", kind: "team" }],
  UpdateTagInput: [{ name: "q4" }, { mergeIntoId: workspaceId }, { color: null }],
  TaggableType: ["envelope", "thread"],
  ReactionInput: [{ emoji: "👍" }, { emoji: "❓" }],
  PeopleQuery: [{ q: "bud", limit: 10 }, { q: "", limit: 50 }],
  ApplyTagInput: [{ tagId: workspaceId, entities: [{ type: "envelope", id: workspaceId }] }],
  RuleMetric: ["pace_index", "kpi_vs_target_pct"],
  RuleComparator: ["gt", "lte"],
  RuleSeverity: ["warning", "data"],
  RuleMetricArgs: [{}, { metricKey: "cpa", period: { kind: "relative", preset: "current_year" }, daysRemainingLt: 30 }],
  RuleDelivery: [{ inApp: true }, { inApp: false, slackChannel: "#budget-alerts", emails: ["a@b.co"] }],
  CreateRuleInput: [
    { name: "Over-pace", metric: "pace_index", metricArgs: {}, comparator: "gt", threshold: "1.10", consecutiveDays: 3, severity: "warning", delivery: { inApp: true } },
    { name: "CPA", scope: { logic: "and", children: [{ field: { kind: "dimension", key: "country" }, op: "eq", value: "BR" }] }, metric: "kpi_vs_target_pct", metricArgs: { metricKey: "cpa" }, comparator: "gt", threshold: "1.25", consecutiveDays: 1, severity: "critical", delivery: { inApp: true, slackChannel: "#br" } },
  ],
  UpdateRuleInput: [{ threshold: "1.2" }, { metric: "kpi_vs_target_pct", metricArgs: { metricKey: "cpl" }, isActive: false }],
  UpdateAlertInput: [{ status: "ACKNOWLEDGED" }, { status: "SNOOZED", snoozedUntil: "2026-10-01T00:00:00.000Z", ownerId: null }],
  ListAlertsQuery: [{ limit: 100 }, { status: "OPEN,ACKNOWLEDGED", severity: "critical", ruleId: workspaceId, envelopeId: workspaceId, filter: "{}", limit: 20 }],
  DimensionColumn: [{ dimension: "country" }, { dimension: "objective", transform: "lower", valueMap: { brand: "brand", "non-brand": "non_brand" } }],
  RoleColumn: [{ role: "period_date", format: "yyyy-MM-dd" }, { role: "amount", currency: "EUR" }, { role: "kpi", metric: "conversions", attributionModel: "7d_click" }, { role: "projection", metric: "spend" }, { role: "ignore" }],
  ColumnMapping: [{ dimension: "platform", transform: "lower" }, { role: "currency" }],
  SourceKind: ["spend+kpi", "projection"],
  SourceMapping: [
    {
      kind: "spend+kpi",
      columns: {
        COUNTRY_CODE: { dimension: "country" },
        PLATFORM: { dimension: "platform", transform: "lower" },
        DATE: { role: "period_date", format: "yyyy-MM-dd" },
        SPEND_EUR: { role: "amount", currency: "EUR" },
        CONVERSIONS: { role: "kpi", metric: "conversions", attributionModel: "7d_click" },
      },
    },
  ],
  SourceConfig: [
    { kind: "csv", uri: "gs://budget-os-uploads/uploads/01927a00-0000-7000-8000-0000000000a1/spend.csv" },
    { kind: "snowflake", account: "acme-eu", username: "BUDGET_OS", warehouse: "WH", database: "MKT", schema: "PUBLIC", view: "SPEND_DAILY", secretRef: "projects/p/secrets/snowflake-key" },
    { kind: "sheets", spreadsheetId: "1AbCdEfGhIjKlMnOp", range: "Spend!A1:H" },
    { kind: "bigquery", projectId: "acme-data", dataset: "marketing", table: "spend_daily", updatedAtColumn: "updated_at" },
  ],
  CreateSourceInput: [
    {
      name: "Golden CSV",
      config: { kind: "csv", uri: "gs://b/uploads/x/golden.csv" },
      mapping: { kind: "spend", columns: { COUNTRY: { dimension: "country" }, DATE: { role: "period_date", format: "yyyy-MM" }, SPEND: { role: "amount", currency: "USD" } } },
      schedule: "0 6 * * *",
    },
  ],
  UpdateSourceInput: [{ name: "Renamed" }, { isActive: false, schedule: null }],
  MapUnmatchedInput: [{ dimensionValues: { country: "BR", platform: "meta" }, envelopeId: workspaceId }],
  CreateUploadInput: [{ filename: "spend 2026-Q1.csv" }],
  SavedViewScreen: ["explorer"],
  SavedViewVisibility: ["private", "workspace"],
  CreateSavedViewInput: [{ name: "LATAM by country", definition: { view: "pivot", groupBy: ["country"] } }, { name: "Everyone", screen: "explorer", definition: {}, visibility: "workspace" }],
  UpdateSavedViewInput: [{ name: "Renamed" }, { visibility: "private" }],
  ListSavedViewsQuery: [{}, { screen: "explorer" }],
  FiscalPeriodKey: ["FY2026", "2026-Q1", "2026-03"],
  CloseInput: [{ periodKey: "2026-Q1" }, { periodId: "01927a00-0000-7000-8000-0000000000c1" }],
  RestateInput: [{ reason: "Late invoices" }],
  ClosureStatus: ["closed", "restated"],
  ClosureView: [
    {
      id: "01927a00-0000-7000-8000-0000000000c2",
      workspaceId,
      period: { id: "01927a00-0000-7000-8000-0000000000c1", key: "2026-Q1", kind: "quarter", start: "2026-01-01", end: "2026-03-31" },
      status: "closed",
      closedBy: "01927a00-0000-7000-8000-0000000000c3",
      closedAt: "2026-04-02T09:00:00.000Z",
      table: "closures.budget_vs_actual_x_2026_q1",
      lockedEnvelopes: 12,
    },
  ],
  RunSourceInput: [{}, { restatementOf: "01927a00-0000-7000-8000-0000000000c2" }],
  ExportKind: ["csv", "xlsx", "sheets"],
  ExportStatus: ["queued", "done"],
  CreateExportInput: [
    { kind: "csv", query: { workspaceId, period: { kind: "relative", preset: "current_year" } } },
    { kind: "xlsx", filename: "Q3 LATAM", query: { workspaceId, groupBy: ["country"], measures: ["budget"], period: { kind: "range", start: "2026-01-01", end: "2026-12-31" } } },
  ],
  ExportRequested: [{ jobId: "01927a00-0000-7000-8000-0000000000e1" }],
  ExportJobView: [
    { id: "01927a00-0000-7000-8000-0000000000e1", workspaceId, kind: "csv", status: "queued", filename: "budget-os-export-2026-09-25", rowCount: null, error: null, createdAt: "2026-09-25T10:00:00.000Z", completedAt: null, downloadUrl: null, expiresInSeconds: null },
    { id: "01927a00-0000-7000-8000-0000000000e2", workspaceId, kind: "xlsx", status: "done", filename: "Q3", rowCount: 97, error: null, createdAt: "2026-09-25T10:00:00.000Z", completedAt: "2026-09-25T10:00:02.000Z", downloadUrl: "https://storage.example/x", expiresInSeconds: 900 },
  ],
  IngestRequested: [{ runId: workspaceId, sourceId: workspaceId }],
  OutboxId: ["1", "9223372036854775807"],
  OutboxEventAttributes: [{ outboxId: "42", workspaceId, orgId: workspaceId, topic: "budget.changed" }],
  PubSubPush: [
    { message: { data: "eyJhIjoxfQ==", attributes: { outboxId: "42", workspaceId, orgId: workspaceId, topic: "budget.changed" }, messageId: "m-1" }, subscription: "projects/p/subscriptions/rollup-worker" },
    { message: { data: "e30=", attributes: { outboxId: "7", workspaceId, orgId: workspaceId, topic: "alert.triggered" }, messageId: "m-2", publishTime: "2026-09-24T10:00:00.000Z" }, subscription: "s", deliveryAttempt: 2 },
  ],
  TargetValue: ["18.25", "0.0125"],
  TargetComparator: ["lte", "between"],
  TargetScope: [
    { type: "envelope", envelopeId: workspaceId },
    { type: "filter", filter: { logic: "and", children: [{ field: { kind: "dimension", key: "country" }, op: "eq", value: "BR" }] } },
  ],
  CreateMetricInput: [
    { key: "cpa", label: "CPA", numerator: "spend", denominator: "kpi:conversions", multiplier: "1", direction: "lower_is_better", format: "currency" },
    { key: "cpm", label: "CPM", numerator: "spend", denominator: "kpi:impressions", multiplier: "1000", direction: "lower_is_better", format: "currency", unit: "USD" },
  ],
  CreateTargetInput: [
    { scope: { type: "envelope", envelopeId: workspaceId }, metricKey: "cpa", value: "18.00", comparator: "lte" },
    { scope: { type: "filter", filter: {} }, metricKey: "roas", startDate: "2026-01-01", endDate: "2026-12-31", value: "3", comparator: "between", valueUpper: "5", rationale: "FY" },
  ],
  CreateTargetDraftInput: [{ basedOnVersionId: workspaceId, value: "17.5", comparator: "lte" }, { basedOnVersionId: null, value: "1", comparator: "gte", rationale: "x" }],
  ListTargetsQuery: [{}, { metric: "cpa", envelopeId: workspaceId, scopeType: "envelope" }],
  MergeEnvelopesInput: [{ sourceIds: [workspaceId, workspaceId], name: "Merged", dimensionValues: { country: "BR" }, rationale: "consolidate" }],
  AddValuesInput: [
    {
      values: [
        { code: "grocery", label: "Grocery" },
        { code: "carrefour", label: "Carrefour", parentCode: "grocery" },
      ],
    },
  ],
  UpdateValueInput: [{ label: "Carrefour" }, { isActive: false, aliases: ["old_code"] }],
  MergeValuesInput: [{ fromCode: "old_code", intoCode: "new_code" }],
  SaveHierarchyTemplateInput: [
    { name: "Geo", path: ["region", "country"] },
    { name: "Default", path: ["client", "region", "country", "platform", "objective"], isDefault: true },
  ],
  UploadAssetInput: [{ contentType: "image/svg+xml", svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" }],
};

function isZodType(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

it("round-trips every zod schema", () => {
  const exported = Object.entries(domain)
    .filter((entry): entry is [string, z.ZodType] => isZodType(entry[1]))
    .map(([name]) => name)
    .sort();
  expect(exported).toEqual(Object.keys(samples).sort());
  for (const name of exported) {
    const schema = domain[name as keyof typeof domain];
    if (!isZodType(schema)) {
      throw new Error(`${name} is not a zod schema`);
    }
    const rows = samples[name];
    if (rows === undefined) {
      throw new Error(`${name} has no round-trip sample`);
    }
    for (const sample of rows) {
      const once: unknown = schema.parse(sample);
      expect(schema.parse(once), name).toEqual(once);
    }
  }
});

it("maps domain errors to HTTP status", () => {
  const codes = Object.keys(httpStatus) as ErrorCode[];
  expect(codes).toEqual([
    "UNAUTHENTICATED",
    "NOT_FOUND",
    "FORBIDDEN",
    "CONFLICT",
    "VALIDATION",
    "CAP_EXCEEDED",
    "LOCKED",
    "POLICY_NOT_FOUND",
    "RATE_LIMITED",
    "UNAVAILABLE",
  ]);
  const error = new DomainError("LOCKED", "period is closed", { periodId: workspaceId });
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("LOCKED");
  expect(error.message).toBe("period is closed");
  expect(error.details).toEqual({ periodId: workspaceId });
  expect(httpStatus[error.code]).toBe(423);
});

it("checks the permission matrix", () => {
  expect(can(["VIEWER"], "approval.decide")).toBe(false);
  expect(can(["BUDGET_OWNER"], "approval.decide")).toBe(true);
  expect(can(["WORKSPACE_ADMIN"], "approval.force")).toBe(false);
  expect(can(["ORG_ADMIN"], "approval.force")).toBe(true);
  expect(can(["DATA_ADMIN"], "source.manage")).toBe(true);
  expect(can(["FINANCE"], "closure.close")).toBe(true);
});
