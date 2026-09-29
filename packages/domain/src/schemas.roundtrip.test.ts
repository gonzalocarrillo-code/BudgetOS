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
    { workspaceId, period: { kind: "fiscal", key: "2026-Q4" }, measures: ["budget", "budget_baseline", "budget_change_abs", "budget_change_pct"], compareTo: { baselineId: "01927a00-0000-7000-8000-0000000000c1" } },
    { workspaceId, period: { kind: "fiscal", key: "2026-Q4" }, measures: ["budget_change_pct"], compareTo: { asOf: "2026-10-01T00:00:00.000Z" } },
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
  TreeRequest: [
    { workspaceId: "01a0e0da-e7e9-7f9a-9212-1c166382caf2", templateId: "01a0e0da-e7e9-7f9a-9212-1c166382caf3", period: { kind: "relative", preset: "current_quarter" } },
    { workspaceId: "01a0e0da-e7e9-7f9a-9212-1c166382caf2", templateId: "01a0e0da-e7e9-7f9a-9212-1c166382caf3", period: { kind: "range", start: "2026-01-01", end: "2026-12-31" }, parentPath: "LATAM/BR", measures: ["budget", "pace_index"] },
  ],
  TreeResponse: [
    {
      available: true,
      reason: null,
      rows: [{ key: "LATAM/BR", envelopeId: null, path: ["LATAM", "BR"], dimensions: { region: "LATAM", country: "BR" }, measures: { budget: "10.00", pace_index: "0.95" }, targets: {}, status: null, pendingCount: 1, openAlerts: 0, openThreads: 0 }],
      totals: { budget: "10.00", leafCount: "4" },
      dataAsOf: "2026-09-28T10:00:00.000Z",
      dataVersion: 7,
      cacheVersion: 6,
      elapsedMs: 8,
    },
    { available: false, reason: "scoped", rows: [], totals: {}, dataAsOf: "2026-09-28T10:00:00.000Z", dataVersion: 7, cacheVersion: null, elapsedMs: 2 },
  ],
  AllocationMode: ["percent", "manual"],
  PercentString: ["60", "33.333333", "100"],
  FamilyChildInput: [{ envelopeId: "01a0e0da-e7e9-7f9a-9212-1c166382caf5", mode: "percent", pct: "60" }, { envelopeId: "01a0e0da-e7e9-7f9a-9212-1c166382caf6", mode: "manual", amount: "300.00" }],
  FamilyInput: [{ parentAmount: "1100.00", children: [{ envelopeId: "01a0e0da-e7e9-7f9a-9212-1c166382caf5", mode: "percent", pct: "60" }], rationale: "Q4 top-down" }],
  FamilySum: [{ parentId: "01a0e0da-e7e9-7f9a-9212-1c166382caf4", parentAmount: "1100.00", childrenTotal: "960.00", unallocated: "140.00", status: "under" }, { parentId: "01a0e0da-e7e9-7f9a-9212-1c166382caf4", parentAmount: "100.00", childrenTotal: "120.00", unallocated: "-20.00", status: "over" }],
  FamilyMember: [{ envelopeId: "01a0e0da-e7e9-7f9a-9212-1c166382caf4", name: "EMEA DE", parentId: null, level: 0, currency: "USD", status: "APPROVED", mode: null, pct: null, before: "1000.00", after: "1100.00", changed: true, childCount: 2, sameCurrency: true }, { envelopeId: "01a0e0da-e7e9-7f9a-9212-1c166382caf5", name: "EMEA DE meta", parentId: "01a0e0da-e7e9-7f9a-9212-1c166382caf4", level: 1, currency: "USD", status: "APPROVED", mode: "percent", pct: "60", before: "600.00", after: "660.00", changed: true, childCount: 0, sameCurrency: true }],
  FamilyPlan: [{ parent: { envelopeId: "01a0e0da-e7e9-7f9a-9212-1c166382caf4", name: "EMEA DE", parentId: null, level: 0, currency: "USD", status: "APPROVED", mode: null, pct: null, before: "1000.00", after: "1100.00", changed: true, childCount: 2, sameCurrency: true }, members: [{ envelopeId: "01a0e0da-e7e9-7f9a-9212-1c166382caf5", name: "EMEA DE meta", parentId: "01a0e0da-e7e9-7f9a-9212-1c166382caf4", level: 1, currency: "USD", status: "APPROVED", mode: "percent", pct: "60", before: "600.00", after: "660.00", changed: true, childCount: 0, sameCurrency: true }], sums: [{ parentId: "01a0e0da-e7e9-7f9a-9212-1c166382caf4", parentAmount: "1100.00", childrenTotal: "960.00", unallocated: "140.00", status: "under" }] }],
  PeriodKind: ["year", "quarter", "month", "custom"],
  CreatePeriodInput: [{ key: "Black Friday 2026", kind: "custom", start: "2026-11-20", end: "2026-11-30" }, { key: "2027-Q1", kind: "quarter", start: "2027-01-01", end: "2027-03-28" }],
  UpdatePeriodInput: [{ start: "2026-11-19" }, { key: "BF 2026", start: "2026-11-20", end: "2026-12-01" }],
  GeneratePeriodsInput: [{ fiscalYear: 2027, pattern: "445" }, { fiscalYear: 2027, pattern: "calendar" }],
  PeriodRow: [{ id: "01a0e0da-e7e9-7f9a-9212-1c166382caf7", key: "2026-Q1", kind: "quarter", start: "2026-01-01", end: "2026-03-31", closure: { id: "01a0e0da-e7e9-7f9a-9212-1c166382caf8", status: "restated" } }, { id: "01a0e0da-e7e9-7f9a-9212-1c166382caf9", key: "Black Friday 2026", kind: "custom", start: "2026-11-20", end: "2026-11-30", closure: null }],
  AddPersonInput: [{ email: "ana@acme.test", name: "Ana" }],
  // Phase E (ADR-053): snapshots, the change report, end and reintroduce.
  BaselineKind: ["plan", "close", "other"],
  BaselineScope: [{}, { envelopeId: "01927a00-0000-7000-8000-0000000000a1" }, { filter: { logic: "and", children: [] } }],
  CreateBaselineInput: [{ name: "Q4 plan", kind: "plan", scope: {} }, { name: "Brazil before re-plan", kind: "other", scope: { envelopeId: "01927a00-0000-7000-8000-0000000000a1" }, note: "as agreed" }],
  UpdateBaselineInput: [{ name: "Q4 plan (final)" }, { archived: true }],
  BaselineView: [{ id: "01927a00-0000-7000-8000-0000000000a1", name: "Q4 plan", kind: "plan", scope: {}, scopeLabel: null, periodKey: "2026-Q4", asOf: "2026-10-01T00:00:00.000Z", note: null, takenBy: { id: "01927a00-0000-7000-8000-0000000000a1", name: "Ana" }, createdAt: "2026-10-01T00:00:00.000Z", archivedAt: null, rowCount: 3, total: "1000.00" }],
  BaselinesResponse: [{ baselines: [] }],
  BaselineRowsQuery: [{ limit: 5000 }],
  BaselineTreeRow: [{ envelopeId: "01927a00-0000-7000-8000-0000000000b1", parentId: null, depth: 0, name: "EMEA", isLeaf: false, amount: "682013.00", amountReporting: "682013.00", currency: "USD", versionId: null, dimensionValues: { region: "EMEA" }, startDate: "2026-01-01", endDate: "2026-12-31", now: "682013.00", change: "0.00", ended: false }],
  BaselineRowsResponse: [{ baseline: { id: "01927a00-0000-7000-8000-0000000000a1", name: "Q4 plan", kind: "plan", scope: {}, scopeLabel: null, periodKey: null, asOf: "2026-10-01T00:00:00.000Z", note: null, takenBy: null, createdAt: "2026-10-01T00:00:00.000Z", archivedAt: null, rowCount: 0, total: "0.00" }, rows: [], currency: "USD", truncated: false }],
  BaselineReportQuery: [{ limit: 20 }, { against: "01927a00-0000-7000-8000-0000000000a1", limit: 5 }],
  BaselineReport: [{ baseline: { id: "01927a00-0000-7000-8000-0000000000a1", name: "Q4 plan", asOf: "2026-10-01T00:00:00.000Z", total: "100.00" }, against: { kind: "working", id: null, name: "Now", asOf: "2026-10-02T00:00:00.000Z", total: "110.00" }, change: { abs: "10.00", pct: "0.1000" }, counts: { increased: 1, decreased: 0, new: 0, removed: 0, ended: 0, unchanged: 2 }, byDimension: {}, topMovers: [], currency: "USD" }],
  ReintroduceInput: [{ startDate: "2026-12-01", endDate: "2026-12-31", amount: "500.00", rationale: "" }],
  ChangeDatesInput: [{ startDate: "2026-10-01", endDate: "2026-11-30", basedOnVersionId: "01927a00-0000-7000-8000-0000000000a1", trimChildren: true, rationale: "Moved" }],
  DateChangeLine: [{ envelopeId: "01927a00-0000-7000-8000-0000000000b1", name: "EMEA", from: { startDate: "2026-01-01", endDate: "2026-12-31" }, to: { startDate: "2026-01-01", endDate: "2026-11-30" }, rephased: true }],
  DateChangePreview: [{ lines: [{ envelopeId: "01927a00-0000-7000-8000-0000000000b1", name: "EMEA", from: { startDate: "2026-01-01", endDate: "2026-12-31" }, to: { startDate: "2026-01-01", endDate: "2026-11-30" }, rephased: false }], childrenOutside: 0, needsApproval: true, movedShare: "0.0849" }],
  UpdateTargetDatesInput: [{ startDate: "2026-01-01", endDate: "2026-06-30" }, { startDate: "2026-01-01", endDate: "2026-06-30", rationale: "Half year" }],
  EndEnvelopeInput: [{ endDate: "2026-11-15", finalAmount: "400.00", rationale: "Paused", basedOnVersionId: "01927a00-0000-7000-8000-0000000000a1" }, { endDate: "2026-11-15", finalAmount: "400.00", rationale: "", basedOnVersionId: "01927a00-0000-7000-8000-0000000000a1", successor: { startDate: "2026-12-01", endDate: "2026-12-31", amount: "600.00" } }],
  // ADR-052 / ORG-005: workspace lifecycle and the org console.
  WorkspaceStatus: ["ACTIVE", "ARCHIVED"],
  UpdateWorkspaceStatusInput: [{ status: "ARCHIVED", reason: "Client ended" }, { status: "ACTIVE" }],
  DeleteWorkspaceInput: [{ confirmName: "Acme LATAM", reason: "Contract over" }],
  AddMemberInput: [{ email: "ana@acme.test", name: "Ana", role: "PLANNER", scope: {} }, { email: "bo@acme.test", name: "Bo", scope: {} }],
  UpdateOrgPersonInput: [{ isActive: false }],
  OrgWorkspace: [{ id: "01927a00-0000-7000-8000-0000000000a1", name: "Acme", slug: "acme", currency: "USD", fiscalYearStartMonth: 1, status: "ACTIVE", archivedAt: null, deletedAt: null, purgeAfter: null, createdAt: "2026-09-28T00:00:00.000Z", members: 3, budgets: 12, lastActivityAt: null, admins: [{ id: "01927a00-0000-7000-8000-0000000000a1", name: "Ana", email: "ana@acme.test" }] }],
  OrgWorkspacesResponse: [{ workspaces: [] }],
  OrgPerson: [{ id: "01927a00-0000-7000-8000-0000000000a1", name: "Ana", email: "ana@acme.test", isActive: true, signedIn: true, superadmin: false, workspaces: [{ workspaceId: "01927a00-0000-7000-8000-0000000000a1", name: "Acme", roles: ["PLANNER"] }] }],
  OrgPeopleResponse: [{ people: [] }],
  PeopleResponse: [{ users: [{ id: "01a0e0da-e7e9-7f9a-9212-1c166382caf1", email: "ana@acme.test", name: "Ana", isActive: true, signedIn: false, orgAdmin: false, roles: [{ id: "01a0e0da-e7e9-7f9a-9212-1c166382caf2", role: "PLANNER", scope: {} }] }], groups: [{ id: "01a0e0da-e7e9-7f9a-9212-1c166382caf3", name: "LATAM leads", googleGroup: "latam@acme.test", memberCount: 4, roles: [] }] }],
  PolicyConditions: [
    {},
    { entityType: "envelope_version", requester: { roles: ["BUDGET_OWNER"] } },
    { requester: { userIds: ["01a0e0da-e7e9-7f9a-9212-1c166382caf1"] }, amountAbs: { lt: 50000 } },
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
  UpdateEnvelopeInput: [{ rowVersion: 1, name: "Renamed" }, { rowVersion: 3, ownerId: null, startDate: "2026-10-01" }, { rowVersion: 2, dimensionValues: { fiscal_period: "fy2026" } }],
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
  ColumnSynonymTarget: [{ dimension: "country" }, { role: "amount" }, { role: "kpi", metric: "conversions" }],
  MetricSynonymTarget: [{ metric: "cpa" }],
  CreateMappingSynonymInput: [{ kind: "metric", term: "tCPA", target: { metric: "cpa" } }, { kind: "column", term: "Inversión", target: { role: "amount" } }],
  UpdateMappingSynonymInput: [{ isActive: false }],
  MappingSynonymView: [{ id: null, kind: "column", term: "spend", target: { role: "amount" }, origin: "builtin", uses: 0, isActive: true }],
  MappingSynonymsResponse: [{ columns: [{ id: null, kind: "column", term: "spend", target: { role: "amount" }, origin: "builtin", uses: 0, isActive: true }], metrics: [], ratioWords: ["cpa", "tcpa"] }],
  CreateMappingProfileInput: [{ name: "Agency export", mapping: { kind: "spend", columns: { date: { role: "period_date", format: "yyyy-MM-dd" }, country: { dimension: "country" }, spend: { role: "amount", currency: "USD" } } }, header: ["date", "country", "spend"] }],
  UpdateMappingProfileInput: [{ name: "Agency weekly" }, { archived: true }],
  MappingProfileView: [{ id: "01927a00-0000-7000-8000-0000000000d1", name: "Agency export", kind: "spend", mapping: { kind: "spend", columns: { date: { role: "period_date", format: "yyyy-MM-dd" }, country: { dimension: "country" }, spend: { role: "amount", currency: "USD" } } }, parsePattern: null, header: ["date", "country", "spend"], sources: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", archivedAt: null }],
  MappingProfilesResponse: [{ profiles: [{ id: "01927a00-0000-7000-8000-0000000000d1", name: "Agency export", kind: "spend", mapping: { kind: "spend", columns: { date: { role: "period_date", format: "yyyy-MM-dd" }, country: { dimension: "country" }, spend: { role: "amount", currency: "USD" } } }, parsePattern: null, header: ["date", "country", "spend"], sources: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", archivedAt: null }] }],
  MatchMappingProfileInput: [{ header: ["Date", "Country", "Spend"] }],
  MatchMappingProfileResponse: [{ profile: { id: "01927a00-0000-7000-8000-0000000000d1", name: "Agency export", kind: "spend", mapping: { kind: "spend", columns: { date: { role: "period_date", format: "yyyy-MM-dd" }, country: { dimension: "country" }, spend: { role: "amount", currency: "USD" } } }, parsePattern: null, header: ["date", "country", "spend"], sources: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", archivedAt: null }, fit: "exact" }, { profile: null, fit: null }],
  MappingPreviewInput: [{ mapping: { kind: "spend", columns: { date: { role: "period_date", format: "yyyy-MM-dd" }, country: { dimension: "country" }, spend: { role: "amount", currency: "USD" } } }, header: ["date", "country", "spend"], rows: [["2026-01-01", "BR", "10.00"]] }],
  MappingPreviewColumn: [{ column: "country", mapsTo: "Country", values: [{ raw: "Brasill", code: null, suggestion: "BR", count: 1 }], issues: ["1 value the registry does not know"], notes: [] }],
  MappingPreviewReport: [{ rowsChecked: 1, rowsRejected: 0, problems: [], columns: [{ column: "country", mapsTo: "Country", values: [{ raw: "Brasill", code: null, suggestion: "BR", count: 1 }], issues: ["1 value the registry does not know"], notes: [] }], rejects: [] }],
  BudgetImportTemplateQuery: [{}, { templateId: "01927a00-0000-7000-8000-0000000000e2" }],
  BudgetImportInput: [{ csv: "key,region,currency,amount,start_date,end_date\n,AMER,USD,10.00,2027-01-01,2027-12-31" }],
  BudgetImportCommitInput: [{ previewId: "01927a00-0000-7000-8000-0000000000e3", rationale: "FY2027 plan" }],
  BudgetImportProblem: [{ column: "country", message: "Country \"Germny\" is not in the registry", suggestion: "DE" }],
  BudgetImportLine: [{ line: 2, status: "new", envelopeId: null, name: "AMER US meta awareness prospecting", dimensionValues: { region: "AMER", country: "US" }, currency: "USD", amount: "1000.00", currentAmount: null, startDate: "2027-01-01", endDate: "2027-12-31", parent: { envelopeId: null, name: "AMER US" }, problems: [] }],
  BudgetImportParent: [{ name: "AMER", dimensionValues: { region: "AMER" }, currency: "USD", amount: "1000.00", startDate: "2027-01-01", endDate: "2027-12-31", parent: null }],
  BudgetImportOverCap: [{ envelopeId: "01927a00-0000-7000-8000-0000000000e1", name: "EMEA DE", approved: "100.00", childrenAfter: "120.00" }],
  BudgetImportPreview: [{ previewId: "01927a00-0000-7000-8000-0000000000e3", lines: [{ line: 2, status: "new", envelopeId: null, name: "AMER US meta awareness prospecting", dimensionValues: { region: "AMER", country: "US" }, currency: "USD", amount: "1000.00", currentAmount: null, startDate: "2027-01-01", endDate: "2027-12-31", parent: { envelopeId: null, name: "AMER US" }, problems: [] }], parents: [{ name: "AMER", dimensionValues: { region: "AMER" }, currency: "USD", amount: "1000.00", startDate: "2027-01-01", endDate: "2027-12-31", parent: null }], overCap: [{ envelopeId: "01927a00-0000-7000-8000-0000000000e1", name: "EMEA DE", approved: "100.00", childrenAfter: "120.00" }], counts: { new: 1, change: 0, same: 0, error: 0, parents: 1 }, totals: { new: "1000.00", change: "0.00" }, currency: "USD", unknownColumns: [], blocked: null }],
  SuggestMappingSampleInput: [{ header: ["date", "country", "spend"], rows: [["2026-01-01", "BR", 10.5], [null, "MX", "3"]] }],
  NamingKind: ["display", "match_key"],
  PeriodFormat: ["yyyy", "yyyy-QQ", "fiscal"],
  NamingChip: [{ type: "dimension", key: "country" }, { type: "separator", value: "_" }, { type: "text", value: "Q" }, { type: "period", format: "yyyy-QQ" }],
  CreateNamingTemplateInput: [{ kind: "display", chips: [{ type: "dimension", key: "country" }], casing: "original", whitespace: "keep", stripAccents: false }],
  UpdateNamingTemplateInput: [{ casing: "lower" }, { isActive: false }],
  NamingPreviewInput: [{ template: { kind: "match_key", chips: [{ type: "dimension", key: "country" }], casing: "lower", whitespace: "underscore", stripAccents: true }, sampleEnvelopeIds: [] }],
  ExperimentKind: ["PLATFORM_TEST", "GEO_HOLDOUT"],
  ExperimentStatus: ["PLANNED", "CONCLUDED"],
  ExperimentRole: ["TEST", "CONTROL"],
  SuccessCriterion: [{ comparator: "lte", vs: "control", minDays: 14 }, { comparator: "gte", vs: "absolute", value: "3.5" }],
  CreateExperimentInput: [{ name: "TikTok vs Meta", hypothesis: "TikTok beats Meta on CPA for prospecting", kind: "PLATFORM_TEST", testFilter: { logic: "and", children: [{ field: { kind: "dimension", key: "platform" }, op: "eq", value: "tiktok" }] }, controlFilter: { logic: "and", children: [{ field: { kind: "dimension", key: "platform" }, op: "eq", value: "meta" }] }, primaryMetric: "cpa", criterion: { comparator: "lte", vs: "control" }, startDate: "2026-04-01", endDate: "2026-06-30" }],
  UpdateExperimentInput: [{ name: "Renamed" }, { endDate: "2026-07-31" }],
  LinkEnvelopeInput: [{ envelopeId: "01927a00-0000-7000-8000-0000000000e1", role: "TEST" }],
  ConcludeExperimentInput: [{ decision: "TikTok wins on CPA; move 20% of Meta prospecting." }],
  ListExperimentsQuery: [{}, { status: "RUNNING,EVALUATING" }],
  MetricSet: [{ budget: "1000.00", actual: "400.00", metric: "18.5000", leafCount: 3 }],
  ExperimentReadout: [{ test: { budget: "1000.00", actual: "400.00", metric: "18.5", leafCount: 3 }, control: null, delta: null, criterionMet: null, daysRunning: 0 }],
  ManualEntryStatus: ["DRAFT", "APPROVED"],
  ManualEntryRowInput: [{ rowNo: 1, dimensionValues: { country: "BR" }, periodDate: "2026-03-01", currency: "BRL", amount: "1500.00", kpis: { conversions: "40" }, note: "Globo prime time" }],
  CreateManualEntryInput: [{ channel: "tv", periodStart: "2026-03-01", periodEnd: "2026-03-31", rows: [] }],
  UpdateManualEntryInput: [{ rows: [] }, { channel: "ooh" }],
  ListManualEntriesQuery: [{}, { status: "DRAFT,SUBMITTED", channel: "tv" }],
  ManualEntryIssue: [{ rowNo: 2, field: "dimension:country", message: 'unknown country "XX"' }],
  ManualEntryTotals: [{ amount: "1500.00", byCurrency: { BRL: "1500.00" }, rows: 1 }],
  TourRole: ["planner", "data_admin"],
  TourStep: [{ path: "/budgets", element: '[data-tour="filter-bar"]', title: "Filters", description: "Narrow the budgets you see." }, { element: '[data-tour="global-search"]', title: "Search", description: "Find anything." }],
  ListToursQuery: [{}, { role: "finance" }, { all: "true" }],
  UpdateTourInput: [{ name: "Planner basics" }, { steps: [{ element: '[data-tour="save-view"]', title: "Save", description: "Keep this view." }] }],
  NotificationItem: [{ id: "01927a00-0000-7000-8000-0000000000a1", kind: "mention", payload: { threadId: "x" }, readAt: null, createdAt: "2026-09-28T00:00:00.000Z" }],
  NotificationsResponse: [{ rows: [], unread: 0 }],
  MarkNotificationsReadInput: [{}, { ids: ["01927a00-0000-7000-8000-0000000000a1"] }],
  CompleteTourInput: [{ version: 2, dismissed: false }, { version: 3, dismissed: true }],
  CreateWorkspaceInput: [{ name: "Acme LATAM", templateId: "01927a00-0000-7000-8000-0000000000c1", withDemoData: true, reportingCurrency: "USD", fiscalYearStartMonth: 1 }],
  TemplateSavedView: [{ name: "By country", screen: "budgets", definition: { view: "pivot", groupBy: ["country"] } }],
  HomeScope: [{ label: "LATAM", filter: { logic: "and", children: [] }, envelopeId: "01927a00-0000-7000-8000-0000000000a1", budget: "1000.00", actual: "400.00", projected: null, paceIndex: "0.8000", spentPct: "0.4000" }],
  HomeResponse: [
    { waitingOnMe: { approvals: [], mentions: [], alerts: [], unmatched: 0 }, scopes: [], recents: [], pinnedViews: [] },
    { waitingOnMe: { approvals: [], mentions: [], alerts: [], unmatched: 0 }, scopes: [], recents: [], pinnedViews: [], workspace: { name: "OpenAI", currency: "USD", period: { start: "2026-01-01", end: "2026-12-31", elapsed: "0.74" } }, totals: null, setup: { budgets: 0, sources: 0, people: 1, spend: false, tags: 0 } },
  ],
  DataAsOfView: [{ lastFactDate: "2026-08-01", through: "2026-08-31", grain: "month", staleDays: 29, stale: false }, { lastFactDate: null, through: null, grain: null, staleDays: null, stale: false }],
  OverviewLeaf: [{ envelopeId: workspaceId, name: "MX meta awareness retargeting", path: ["LATAM", "MX", "meta"], budget: "6917.48", actual: "5442.74", pace_index: "1.0558", spend_to_date_pct: "0.7868" }],
  OverviewHeatmapCell: [{ row: "BR", col: "meta", budget: "30447.14", actual: "18573.00", pace_index: "0.9101", spend_to_date_pct: "0.6100" }, { row: null, col: "meta", budget: null, actual: null, pace_index: null, spend_to_date_pct: null }],
  OverviewHeatmap: [{ rowDimension: { key: "country", label: "Country" }, colDimension: { key: "platform", label: "Platform" }, rows: ["BR"], cols: ["meta"], labels: { rows: { BR: "Brazil" }, cols: { meta: "Meta" } }, cells: [{ row: "BR", col: "meta", budget: "30447.14", actual: "18573.00", pace_index: "0.9101", spend_to_date_pct: "0.6100" }], dimensions: [{ key: "country", label: "Country" }] }],
  OverviewMargin: [{ code: "BR", budget: "126000.00", budget_in_period: "126000.00", actual: "75600.00", pace_index: "0.90", spend_to_date_pct: "0.60", ahead_of_plan_abs: "-8316.00", alerts: 23 }],
  OverviewAttentionItem: [{ category: "over", envelopeId: workspaceId, name: "MX meta awareness retargeting", path: ["LATAM", "MX", "meta"], budget: "6917.48", budget_in_period: "6917.48", actual: "5442.74", pace_index: "1.18", spend_to_date_pct: "0.7868", ahead_of_plan_abs: "836.12", money: "836.12", alerts: 2, alertList: [{ id: workspaceId, rule: "Over-pace", severity: "warning", openedAt: "2026-08-15T00:00:00.000Z" }], pending: false, endDate: "2026-12-31", kpi: null }],
  OverviewAttention: [{ all: [{ category: "over", envelopeId: workspaceId, name: "MX meta awareness retargeting", path: ["LATAM", "MX", "meta"], budget: "6917.48", budget_in_period: "6917.48", actual: "5442.74", pace_index: "1.18", spend_to_date_pct: "0.7868", ahead_of_plan_abs: "836.12", money: "836.12", alerts: 2, alertList: [{ id: workspaceId, rule: "Over-pace", severity: "warning", openedAt: "2026-08-15T00:00:00.000Z" }], pending: false, endDate: "2026-12-31", kpi: null }], over: [{ category: "over", envelopeId: workspaceId, name: "MX meta awareness retargeting", path: ["LATAM", "MX", "meta"], budget: "6917.48", budget_in_period: "6917.48", actual: "5442.74", pace_index: "1.18", spend_to_date_pct: "0.7868", ahead_of_plan_abs: "836.12", money: "836.12", alerts: 2, alertList: [{ id: workspaceId, rule: "Over-pace", severity: "warning", openedAt: "2026-08-15T00:00:00.000Z" }], pending: false, endDate: "2026-12-31", kpi: null }], under: [], noSpend: [], kpi: [], counts: { over: 6, under: 0, noSpend: 0, kpi: 0 } }],
  OverviewRuleAlerts: [{ ruleId: "01927a00-0000-7000-8000-0000000000b1", ruleName: "CPA over target", severity: "warning", metric: "kpi_vs_target_pct", count: 100, budgets: 100, covered: 193, byRow: [{ code: "MX", label: "Mexico", count: 17 }] }],
  OverviewResponse: [
    {
      currency: "USD",
      period: { preset: "current_year", start: "2026-01-01", end: "2026-12-31", elapsed: "0.6658", elapsedToday: "0.7452", daysLeft: 94 },
      asOf: { lastFactDate: "2026-08-01", through: "2026-08-31", grain: "month", staleDays: 29, stale: false },
      dataAsOf: "2026-09-29T10:00:00.000Z",
      totals: { budget: "1114679.17", actual: "653984.46" },
      headline: { basis: "top_level", budget: "1386014.00", actual: "653984.46", spentPct: "0.4718", paceIndex: "0.7087", assigned: "1114679.17", remaining: "732029.54", runRateNeeded: "7787.55", projected: null, projectedClosePct: null },
      compare: { id: workspaceId, name: "FY2026 plan", kind: "plan", asOf: "2026-02-01T00:00:00.000Z", explicit: false, changeAbs: "750.00", changePct: "0.0005", counts: { increased: 24, decreased: 0, new: 1, ended: 1 } },
      heatmap: null,
      attention: { all: [], over: [], under: [], noSpend: [], kpi: [], counts: { over: 0, under: 0, noSpend: 0, kpi: 0 } },
      kpi: null,
      alerts: { open: 0, counts: { critical: 0, warning: 0, info: 0, data: 0 }, byRule: [], byRow: [] },
      queue: { waiting: 1, overdue: 0, oldestDays: 2, byRole: [{ role: "BUDGET_OWNER", count: 1 }], byKind: [{ kind: "bulk_change", count: 1 }] },
      freshness: { lastFactDate: "2026-08-01", sources: [], projections: null },
      elapsedMs: 120,
    },
  ],
  HomeRequestCard: [{ title: "Q4 retail push", count: 24, before: "137599.59", after: "144479.57", changePct: "0.0500" }, { title: "CPA target · MX meta conversion", count: 1, before: null, after: null }],
  HomeAlertGroup: [{ envelopeId: workspaceId, name: "EMEA", severity: "critical", count: 12, assigned: 1, rules: [{ ruleId: "01927a00-0000-7000-8000-0000000000b1", ruleName: "CPA far over target", severity: "critical", count: 5 }, { ruleId: "01927a00-0000-7000-8000-0000000000b2", ruleName: "CPA over target", severity: "warning", count: 7 }] }],
  UpdateMeInput: [{ name: "Maya Chen" }],
  UpdateWorkspaceInput: [{ name: "OpenAI" }],
  AppliedTagsQuery: [{ type: "alert", ids: "01927a00-0000-7000-8000-0000000000a1,01927a00-0000-7000-8000-0000000000a2" }],
  SlackSettings: [{}, { teamId: "T0GOLDEN1", teamName: "Golden", defaultChannel: "#budget-ops", alertChannel: "#alerts", alertSeverities: ["warning", "critical"], approvals: false }],
  UpdateSlackSettingsInput: [{ defaultChannel: "#budget-ops" }, { alertChannel: null, alertSeverities: ["critical"], link: true }],
  SlackTestInput: [{}, { channel: "#budget-ops" }],
  SlackActionValue: [{ ws: "01927a00-0000-7000-8000-0000000000c1", id: "01927a00-0000-7000-8000-0000000000a1" }],
  SlackSeverity: ["critical"],
  TimelineZoom: ["week", "month", "quarter", "fy"],
  TimelineMarker: [{ kind: "approval", at: "2026-02-01", id: "v1" }, { kind: "alert", at: "2026-08-14", id: "a1", severity: "warning" }],
  TimelinePeriod: [{ id: "2026-Q1", kind: "quarter", start: "2026-01-01", end: "2026-03-31", label: "Q1 FY2026" }],
  TimelineBar: [
    { key: "LATAM", parentKey: null, level: 0, kind: "group", name: "LATAM", path: ["LATAM"], start: "2026-01-01", end: "2026-12-31", budget: "1000.00", actual: "400.00", projected: "900.00", spendPct: 0.4, projectedPct: 0.9, paceIndex: 0.6, paceState: "under", status: "APPROVED", hasChildren: true, expanded: false, lane: 0, markers: [] },
    { key: "e1:t1", parentKey: "e1", level: 2, kind: "target", name: "CPA", path: ["LATAM", "BR"], start: "2026-10-01", end: "2026-12-31", envelopeId: "01927a00-0000-7000-8000-0000000000e1", targetId: "01927a00-0000-7000-8000-0000000000f1", metric: "cpa", value: "18.5000", comparator: "lte", paceState: "none", hasChildren: false, expanded: false, lane: 1, markers: [], effective: [{ start: "2026-10-01", end: "2026-12-31" }] },
  ],
  TimelineQuery: [{ zoom: "month", limit: 2000 }, { filter: "N4Ig", groupBy: "region,country", from: "2026-01-01", to: "2026-12-31", asOf: "2026-05-01T00:00:00.000Z", zoom: "quarter", limit: 50 }],
  TimelineResponse: [{ bars: [], nextCursor: null, calendar: { fiscalYearStartMonth: 1, periods: [], keyDates: [{ at: "2026-04-02", label: "2026-Q1", kind: "closure" }] }, dataVersion: "3", dataAsOf: "2026-09-26T00:00:00.000Z" }],
  ParsePattern: ["^(?<country>[A-Z]{2})_(?<platform>[a-z]+)"],
  MapUnmatchedInput: [{ dimensionValues: { country: "BR", platform: "meta" }, envelopeId: workspaceId }],
  CreateUploadInput: [{ filename: "spend 2026-Q1.csv" }],
  OverviewLayout: [{ hidden: [], order: [], axes: {} }, { hidden: ["heatmap"], order: ["kpi", "heatmap"], axes: { rows: "region" }, sort: "pace" }],
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
  AddChildInput: [{ name: "MX meta lookalike", amount: "5.00", dimensionValues: { audience: "lookalike" }, rationale: "test a new audience" }],
  StructurePreviewInput: [
    { op: "add_child", envelopeId: "0190a000-0000-7000-8000-000000000001", input: { name: "Child", amount: "1.00", dimensionValues: {}, rationale: "why not" } },
    { op: "move", envelopeId: "0190a000-0000-7000-8000-000000000001", input: { parentId: null, rowVersion: 3 } },
    { op: "merge", input: { sourceIds: ["0190a000-0000-7000-8000-000000000001", "0190a000-0000-7000-8000-000000000002"], name: "All", dimensionValues: { region: "LATAM" }, rationale: "one line" } },
  ],
  MergeEnvelopesInput: [{ sourceIds: [workspaceId, workspaceId], name: "Merged", dimensionValues: { country: "BR" }, rationale: "consolidate" }],
  AddValuesInput: [
    {
      values: [
        { code: "grocery", label: "Grocery" },
        { code: "carrefour", label: "Carrefour", parentCode: "grocery" },
      ],
    },
  ],
  UpdateHierarchyTemplateInput: [{ name: "By country" }, { path: ["region", "country"], isDefault: true }],
  UpdateValueInput: [{ label: "Carrefour" }, { isActive: false, aliases: ["old_code"] }, { parentCode: "latam" }, { parentCode: null }],
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
