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
