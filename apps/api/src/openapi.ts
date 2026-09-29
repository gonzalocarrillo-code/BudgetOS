import { z } from "zod";
import {
  BaselineReport,
  BudgetImportCommitInput,
  BudgetImportInput,
  BudgetImportPreview,
  CreateMappingProfileInput,
  CreateMappingSynonymInput,
  MappingPreviewInput,
  MappingPreviewReport,
  MappingProfileView,
  MappingProfilesResponse,
  MappingSynonymsResponse,
  MatchMappingProfileInput,
  MatchMappingProfileResponse,
  UpdateMappingProfileInput,
  UpdateMappingSynonymInput,
  BaselineRowsResponse,
  BaselineView,
  EndEnvelopeInput,
  ReintroduceInput,
  BaselinesResponse,
  CreateBaselineInput,
  UpdateBaselineInput,
  AddMemberInput,
  MarkNotificationsReadInput,
  NotificationsResponse,
  DeleteWorkspaceInput,
  OrgPeopleResponse,
  OrgWorkspacesResponse,
  UpdateOrgPersonInput,
  UpdateWorkspaceStatusInput,
  AddValuesInput,
  AssignRoleInput,
  MergeEnvelopesInput,
  AddChildInput,
  StructurePreviewInput,
  MoveEnvelopeInput,
  SplitEnvelopeInput,
  BulkRequest,
  CsvExportInput,
  CsvImportInput,
  CreatePolicyInput,
  DecideInput,
  ExternalEvidenceInput,
  SubmitVersionInput,
  UpdatePolicyInput,
  WithdrawInput,
  CreateDraftVersionInput,
  CreateEnvelopeInput,
  RestoreVersionInput,
  UpdateEnvelopeInput,
  UpdatePhasingInput,
  GroupsSyncInput,
  CreateDimensionInput,
  MergeValuesInput,
  SaveHierarchyTemplateInput,
  UpdateHierarchyTemplateInput,
  UpdateDimensionInput,
  UpdateValueInput,
  UploadAssetInput,
  CreateMetricInput,
  CreateTargetInput,
  CreateTargetDraftInput,
  CreateSourceInput,
  UpdateSourceInput,
  MapUnmatchedInput,
  CreateNamingTemplateInput,
  NamingPreviewInput,
  UpdateNamingTemplateInput,
  SuggestMappingSampleInput,
  CreateUploadInput,
  CreateRuleInput,
  UpdateRuleInput,
  UpdateAlertInput,
  CreateThreadInput,
  CommentInput,
  UpdateCommentInput,
  SubscriptionInput,
  CreateTagInput,
  UpdateTagInput,
  ApplyTagInput,
  CreateExportInput,
  ExportJobView,
  CloseInput,
  ClosureView,
  RestateInput,
  RunSourceInput,
  QueryRequest,
  QueryResponse,
  CompleteTourInput,
  CreateWorkspaceInput,
  HomeResponse,
  UpdateTourInput,
  CreateManualEntryInput,
  UpdateManualEntryInput,
  CreateExperimentInput,
  UpdateExperimentInput,
  LinkEnvelopeInput,
  ConcludeExperimentInput,
  ExperimentReadout,
  TimelineResponse,
  TreeRequest,
  TreeResponse,
  CreateSavedViewInput,
  UpdateSavedViewInput,
  ReactionInput,
  FamilyInput,
  FamilyPlan,
  CreatePeriodInput,
  GeneratePeriodsInput,
  PeriodRow,
  UpdatePeriodInput,
  PeopleResponse,
  UpdateMeInput,
  UpdateWorkspaceInput,
  UpdateSlackSettingsInput,
  SlackTestInput,
} from "@budget/domain";
import { zodV3ToOpenAPI } from "nestjs-zod";

const json = (schema: Parameters<typeof zodV3ToOpenAPI>[0]) => ({
  content: { "application/json": { schema: zodV3ToOpenAPI(schema) } },
});

const workspaceParam = { name: "ws", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
/** Routes without :ws take the workspace from this header (spec §4). */
const workspaceHeader = { name: "X-Workspace-Id", in: "header", required: true, schema: { type: "string", format: "uuid" } };

export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title: "BudgetOS", version: "0.5.0" },
    components: {
      securitySchemes: { identityPlatform: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Identity Platform ID token" } },
    },
    security: [{ identityPlatform: [] }],
    paths: {
      "/api/v1/me": {
        get: { operationId: "getMe", responses: { "200": { description: "Caller, roles per workspace and permissions" } } },
        patch: { operationId: "updateMe", parameters: [workspaceHeader], requestBody: json(UpdateMeInput), responses: { "200": { description: "The caller's new display name" } } },
      },
      "/api/v1/workspaces/{ws}/roles": {
        get: { operationId: "listRoleAssignments", parameters: [workspaceParam], responses: { "200": { description: "Role assignments in the workspace" } } },
        post: { operationId: "assignRole", parameters: [workspaceParam], requestBody: json(AssignRoleInput), responses: { "200": { description: "Created role assignment" } } },
      },
      "/api/v1/workspaces/{ws}/members": {
        get: { operationId: "listMembers", parameters: [workspaceParam], responses: { "200": { description: "The people and groups with a role in this workspace (a superadmin sees the whole org), each with its role assignments here", ...json(PeopleResponse) } } },
        post: { operationId: "addMember", parameters: [workspaceParam], requestBody: json(AddMemberInput), responses: { "201": { description: "Added to this workspace by email with a role here (joins the org when new); they sign in with Google later" }, "409": { description: "The email belongs to another organisation" } } },
      },
      "/api/v1/roles/{id}": {
        delete: { operationId: "revokeRole", parameters: [idParam, workspaceHeader], responses: { "200": { description: "Revoked role assignment" } } },
      },
      "/api/v1/workspaces/{ws}/envelopes": {
        post: { operationId: "createEnvelope", parameters: [workspaceParam], requestBody: json(CreateEnvelopeInput), responses: { "200": { description: "Created envelope (with v1 draft when an amount is given)" } } },
      },
      "/api/v1/envelopes/{id}": {
        get: {
          operationId: "getEnvelope",
          parameters: [idParam, workspaceHeader, { name: "as_of", in: "query", required: false, schema: { type: "string" }, description: "YYYY-MM-DD (end of day UTC) or ISO datetime: adds the budget approved at that instant" }],
          responses: { "200": { description: "Envelope with its approved version, open draft and, with as_of, the approved version at that instant" } },
        },
        patch: { operationId: "updateEnvelope", parameters: [idParam, workspaceHeader], requestBody: json(UpdateEnvelopeInput), responses: { "200": { description: "Updated envelope metadata" }, "409": { description: "Stale rowVersion; details carry currentRowVersion and currentVersionId" } } },
      },
      "/api/v1/envelopes/{id}/timeline": {
        get: {
          operationId: "getEnvelopeTimeline",
          parameters: [
            idParam,
            workspaceHeader,
            { name: "descendants", in: "query", required: false, schema: { type: "boolean" }, description: "Roll-up timeline of the whole subtree" },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500 } },
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Decision timeline, newest first: { rows: [{ at, kind, title, actor, detail, refs }], nextCursor }" } },
        },
      },
      "/api/v1/envelopes/{id}/versions": {
        get: { operationId: "listEnvelopeVersions", parameters: [idParam, workspaceHeader], responses: { "200": { description: "All versions, newest first" } } },
      },
      "/api/v1/envelopes/{id}/draft": {
        patch: { operationId: "createDraftVersion", parameters: [idParam, workspaceHeader], requestBody: json(CreateDraftVersionInput), responses: { "200": { description: "New draft version" }, "409": { description: "Stale basedOnVersionId; details.currentVersionId" }, "423": { description: "Period closed" } } },
      },
      "/api/v1/envelopes/{id}/phasing": {
        patch: { operationId: "updateEnvelopePhasing", parameters: [idParam, workspaceHeader], requestBody: json(UpdatePhasingInput), responses: { "200": { description: "New draft version with the same amount and new phasing" } } },
      },
      "/api/v1/envelopes/{id}/restore/{versionId}": {
        post: {
          operationId: "restoreEnvelopeVersion",
          parameters: [idParam, { name: "versionId", in: "path", required: true, schema: { type: "string", format: "uuid" } }, workspaceHeader],
          requestBody: json(RestoreVersionInput),
          responses: { "200": { description: "New draft version copied from the given version" } },
        },
      },
      "/api/v1/envelopes/{id}/move": {
        post: { operationId: "moveEnvelope", parameters: [idParam, workspaceHeader], requestBody: json(MoveEnvelopeInput), responses: { "200": { description: "Moved; lineage written; an open request re-routed if its policy changed" }, "409": { description: "Stale rowVersion" }, "422": { description: "CAP_EXCEEDED under the new parent, or a cycle" } } },
      },
      "/api/v1/workspaces/{ws}/budget-import/template": {
        get: { operationId: "budgetImportTemplate", parameters: [workspaceParam, { name: "templateId", in: "query", required: false, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "The CSV this workspace's import takes: one column per granularity, the template's columns, the fiscal year's months, and two live budgets as examples (text/csv)" } } },
      },
      "/api/v1/workspaces/{ws}/budget-import/preview": {
        post: { operationId: "previewBudgetImport", parameters: [workspaceParam], requestBody: json(BudgetImportInput), responses: { "201": { description: "Each line's status and problems, the parents it creates, budgets that would go over cap (D-008); nothing is written", ...json(BudgetImportPreview) } } },
      },
      "/api/v1/workspaces/{ws}/budget-import/commit": {
        post: { operationId: "commitBudgetImport", parameters: [workspaceParam], requestBody: json(BudgetImportCommitInput), responses: { "201": { description: "Drafts under one approval (or applied at once by policy): new budgets, created parents and changes" } } },
      },
      "/api/v1/envelopes/{id}/spend": {
        get: { operationId: "getEnvelopeSpend", parameters: [idParam, workspaceHeader, { name: "through", in: "query", required: false, schema: { type: "string", format: "date" } }], responses: { "200": { description: "Spend up to a date in the budget's currency: { through, currency, spend } (H-011)" } } },
      },
      "/api/v1/envelopes/{id}/end": {
        post: { operationId: "endEnvelope", parameters: [idParam, workspaceHeader], requestBody: json(EndEnvelopeInput), responses: { "200": { description: "A final-amount version (and an optional successor) routed through the approval policy; the end date applies on approval (H-011)" } } },
      },
      "/api/v1/envelopes/{id}/reintroduce": {
        post: { operationId: "reintroduceEnvelope", parameters: [idParam, workspaceHeader], requestBody: json(ReintroduceInput), responses: { "200": { description: "A successor under the same parent with lineage `continues`, routed through the approval policy (H-012)" } } },
      },
      "/api/v1/envelopes/{id}/split": {
        post: { operationId: "splitEnvelope", parameters: [idParam, workspaceHeader], requestBody: json(SplitEnvelopeInput), responses: { "200": { description: "New siblings with drafts summing to the approved amount; one approval (or auto-approved); source archived once approved" } } },
      },
      "/api/v1/envelopes/structure/preview": {
        post: { operationId: "previewEnvelopeStructure", parameters: [workspaceHeader], requestBody: json(StructurePreviewInput), responses: { "200": { description: "{ ok, op, currency, amount, parent, previousParent, routing } or { ok: false, error }: the change is run and rolled back" } } },
      },
      "/api/v1/envelopes/{id}/children": {
        post: { operationId: "addChildEnvelope", parameters: [idParam, workspaceHeader], requestBody: json(AddChildInput), responses: { "201": { description: "The child, created under this envelope with its draft submitted (auto-approved or a request)" } } },
      },
      "/api/v1/envelopes/merge": {
        post: { operationId: "mergeEnvelopes", parameters: [workspaceHeader], requestBody: json(MergeEnvelopesInput), responses: { "200": { description: "New sibling holding the sources' approved total; one approval (or auto-approved); sources archived once approved" } } },
      },
      "/api/v1/envelopes/bulk": {
        post: { operationId: "previewBulkEdit", parameters: [workspaceHeader], requestBody: json(BulkRequest), responses: { "200": { description: "BulkPreview: before/after/delta per row, totals, cap violations, policy preview; kept 30 min" } } },
      },
      "/api/v1/envelopes/bulk/{previewId}/commit": {
        post: {
          operationId: "commitBulkEdit",
          parameters: [{ name: "previewId", in: "path", required: true, schema: { type: "string", format: "uuid" } }, workspaceHeader],
          responses: { "200": { description: "One draft per row, one bulk_change, one approval request (or auto-approved)" }, "409": { description: "Rows changed since the preview" }, "404": { description: "Preview expired" } },
        },
      },
      "/api/v1/workspaces/{ws}/envelopes/csv-export": {
        post: { operationId: "exportEnvelopesCsv", parameters: [workspaceParam], requestBody: json(CsvExportInput), responses: { "200": { description: "text/csv: envelope_id, path, currency, approved_amount, amount" } } },
      },
      "/api/v1/workspaces/{ws}/envelopes/csv-import": {
        post: { operationId: "importEnvelopesCsv", parameters: [workspaceParam], requestBody: json(CsvImportInput), responses: { "200": { description: "CsvImportReport: line errors plus a paste preview of the valid rows" } } },
      },
      "/api/v1/envelopes/{id}/family": {
        get: { operationId: "getEnvelopeFamily", parameters: [idParam, workspaceHeader], responses: { "200": { description: "The parent, its children (each % of the parent or manual) and how they add up", ...json(FamilyPlan) } } },
        post: { operationId: "saveEnvelopeFamily", parameters: [idParam, workspaceHeader], requestBody: json(FamilyInput), responses: { "201": { description: "Rules saved (audited); { plan, preview }: the bulk preview of every amount the plan changes, to commit (null when no amount changes)" } } },
      },
      "/api/v1/envelopes/{id}/family/preview": {
        post: { operationId: "previewEnvelopeFamily", parameters: [idParam, workspaceHeader], requestBody: json(FamilyInput), responses: { "201": { description: "The family as the change leaves it, down the tree; writes nothing", ...json(FamilyPlan) } } },
      },
      "/api/v1/envelopes/{id}/submit": {
        post: { operationId: "submitEnvelopeVersion", parameters: [idParam, workspaceHeader], requestBody: json(SubmitVersionInput), responses: { "200": { description: "Approval request created, or auto-approved by policy" }, "409": { description: "Not the open draft, request already open, or blocking threads" }, "500": { description: "POLICY_NOT_FOUND" } } },
      },
      "/api/v1/envelopes/{id}/withdraw": {
        post: { operationId: "withdrawEnvelopeRequest", parameters: [idParam, workspaceHeader], requestBody: json(WithdrawInput), responses: { "200": { description: "Open request withdrawn" } } },
      },
      "/api/v1/approvals": {
        get: {
          operationId: "listApprovals",
          parameters: [
            workspaceHeader,
            { name: "status", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated RequestStatus; default PENDING,ESCALATED" },
            { name: "assignee", in: "query", required: false, schema: { type: "string", enum: ["me"] } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } },
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Inbox page: { rows, nextCursor }" } },
        },
      },
      "/api/v1/approvals/{id}": {
        get: { operationId: "getApproval", parameters: [idParam, workspaceHeader], responses: { "200": { description: "Request with frozen policy, diff and decisions" } } },
      },
      "/api/v1/approvals/{id}/decisions": {
        post: { operationId: "decideApproval", parameters: [idParam, workspaceHeader], requestBody: json(DecideInput), responses: { "200": { description: "Request after the decision" }, "403": { description: "Not an eligible approver for the current step" }, "422": { description: "CAP_EXCEEDED on final approval" } } },
      },
      "/api/v1/approvals/{id}/external-evidence": {
        post: { operationId: "recordExternalEvidence", parameters: [idParam, workspaceHeader], requestBody: json(ExternalEvidenceInput), responses: { "200": { description: "Evidence recorded; counts toward the step when the policy allows it" } } },
      },
      "/api/v1/approvals/{id}/withdraw": {
        post: { operationId: "withdrawApproval", parameters: [idParam, workspaceHeader], requestBody: json(WithdrawInput), responses: { "200": { description: "Request withdrawn" } } },
      },
      "/api/v1/workspaces/{ws}/policies": {
        get: { operationId: "listPolicies", parameters: [workspaceParam], responses: { "200": { description: "Approval policies by priority" } } },
        post: { operationId: "createPolicy", parameters: [workspaceParam], requestBody: json(CreatePolicyInput), responses: { "200": { description: "Created policy" } } },
      },
      "/api/v1/policies/{id}": {
        patch: { operationId: "updatePolicy", parameters: [idParam, workspaceHeader], requestBody: json(UpdatePolicyInput), responses: { "200": { description: "Updated policy (version + 1)" }, "409": { description: "Stale version" } } },
      },
      "/api/v1/workspaces/{ws}/groups/sync": {
        post: { operationId: "syncGroups", parameters: [workspaceParam], requestBody: json(GroupsSyncInput), responses: { "200": { description: "Superadmins: group membership after sync" } } },
      },
      "/api/v1/workspaces/{ws}/dimensions": {
        get: { operationId: "listDimensions", parameters: [workspaceParam], responses: { "200": { description: "Registry dimensions visible to the workspace" } } },
        post: { operationId: "createDimension", parameters: [workspaceParam], requestBody: json(CreateDimensionInput), responses: { "200": { description: "Created dimension" } } },
      },
      "/api/v1/dimensions/{id}": {
        patch: { operationId: "updateDimension", parameters: [idParam, workspaceHeader], requestBody: json(UpdateDimensionInput), responses: { "200": { description: "Updated dimension" } } },
      },
      "/api/v1/dimensions/{id}/values": {
        post: { operationId: "addDimensionValues", parameters: [idParam, workspaceHeader], requestBody: json(AddValuesInput), responses: { "200": { description: "Upserted dimension values" } } },
      },
      "/api/v1/values/{id}": {
        patch: { operationId: "updateDimensionValue", parameters: [idParam, workspaceHeader], requestBody: json(UpdateValueInput), responses: { "200": { description: "Updated dimension value" } } },
      },
      "/api/v1/values/{id}/merge": {
        post: { operationId: "mergeDimensionValues", parameters: [idParam, workspaceHeader], requestBody: json(MergeValuesInput), responses: { "200": { description: "Merged dimension value" } } },
      },
      "/api/v1/workspaces/{ws}/hierarchy-templates": {
        get: { operationId: "listHierarchyTemplates", parameters: [workspaceParam], responses: { "200": { description: "Hierarchy templates" } } },
        post: { operationId: "saveHierarchyTemplate", parameters: [workspaceParam], requestBody: json(SaveHierarchyTemplateInput), responses: { "200": { description: "Saved hierarchy template" } } },
      },
      "/api/v1/hierarchy-templates/{id}": {
        patch: { operationId: "updateHierarchyTemplate", parameters: [idParam, workspaceHeader], requestBody: json(UpdateHierarchyTemplateInput), responses: { "200": { description: "Updated hierarchy template (rename, reorder, make default)" } } },
      },
      "/api/v1/workspaces/{ws}/metrics": {
        get: { operationId: "listMetrics", parameters: [workspaceParam], responses: { "200": { description: "The org's metric library (numerator / denominator over facts, multiplier)" } } },
        post: { operationId: "createMetric", parameters: [workspaceParam], requestBody: json(CreateMetricInput), responses: { "201": { description: "Created metric (org admin only)" } } },
      },
      "/api/v1/workspaces/{ws}/targets": {
        get: {
          operationId: "listTargets",
          parameters: [
            workspaceParam,
            { name: "metric", in: "query", required: false, schema: { type: "string" } },
            { name: "envelopeId", in: "query", required: false, schema: { type: "string", format: "uuid" } },
            { name: "scopeType", in: "query", required: false, schema: { type: "string", enum: ["envelope", "filter"] } },
          ],
          responses: { "200": { description: "Active targets with their current and draft versions" } },
        },
        post: { operationId: "createTarget", parameters: [workspaceParam], requestBody: json(CreateTargetInput), responses: { "201": { description: "Created target with its v1 draft" } } },
      },
      "/api/v1/targets/{id}/draft": {
        patch: { operationId: "createTargetDraft", parameters: [idParam, workspaceHeader], requestBody: json(CreateTargetDraftInput), responses: { "200": { description: "New draft version; 409 with currentVersionId when basedOnVersionId is stale" } } },
      },
      "/api/v1/targets/{id}/submit": {
        post: { operationId: "submitTarget", parameters: [idParam, workspaceHeader], requestBody: json(SubmitVersionInput), responses: { "201": { description: "Approval request, or auto-approved by policy (entityType target_version)" } } },
      },
      "/api/v1/targets/{id}/versions": {
        get: { operationId: "listTargetVersions", parameters: [idParam, workspaceHeader], responses: { "200": { description: "Target with every version, newest first" } } },
      },
      "/api/v1/envelopes/{id}/targets": {
        get: { operationId: "getEnvelopeTargets", parameters: [idParam, workspaceHeader], responses: { "200": { description: "Effective target per metric (own, inherited or filter-scoped) with implied volume = budget / target" } } },
      },
      "/api/v1/workspaces/{ws}/sources": {
        get: { operationId: "listSources", parameters: [workspaceParam], responses: { "200": { description: "Data sources (non-secret config and column mapping)" } } },
        post: { operationId: "createSource", parameters: [workspaceParam], requestBody: json(CreateSourceInput), responses: { "201": { description: "Created source; a csv source must point at this workspace's uploads" } } },
      },
      "/api/v1/sources/{id}": {
        patch: { operationId: "updateSource", parameters: [idParam, workspaceHeader], requestBody: json(UpdateSourceInput), responses: { "200": { description: "Updated source (the kind never changes)" } } },
      },
      "/api/v1/workspaces/{ws}/mapping-profiles": {
        get: { operationId: "listMappingProfiles", parameters: [workspaceParam, { name: "includeArchived", in: "query", required: false, schema: { type: "string", enum: ["true", "false"] } }], responses: { "200": { description: "Saved mappings (D-004)", ...json(MappingProfilesResponse) } } },
        post: { operationId: "createMappingProfile", parameters: [workspaceParam], requestBody: json(CreateMappingProfileInput), responses: { "201": { description: "Saved; its columns teach the workspace's synonyms", ...json(MappingProfileView) } } },
      },
      "/api/v1/workspaces/{ws}/mapping-profiles/match": {
        post: { operationId: "matchMappingProfile", parameters: [workspaceParam], requestBody: json(MatchMappingProfileInput), responses: { "201": { description: "The profile a file's header fits (exact, or one whose columns it covers), or none", ...json(MatchMappingProfileResponse) } } },
      },
      "/api/v1/mapping-profiles/{id}": {
        patch: { operationId: "updateMappingProfile", parameters: [idParam, workspaceHeader], requestBody: json(UpdateMappingProfileInput), responses: { "200": { description: "Renamed, remapped (reaching every source that follows it) or archived", ...json(MappingProfileView) } } },
      },
      "/api/v1/workspaces/{ws}/mapping-synonyms": {
        get: { operationId: "listMappingSynonyms", parameters: [workspaceParam], responses: { "200": { description: "Built-in, learned and manual words for columns and metrics (D-005)", ...json(MappingSynonymsResponse) } } },
        post: { operationId: "createMappingSynonym", parameters: [workspaceParam], requestBody: json(CreateMappingSynonymInput), responses: { "201": { description: "A word the workspace uses; a manual row wins over learned ones" } } },
      },
      "/api/v1/mapping-synonyms/{id}": {
        patch: { operationId: "updateMappingSynonym", parameters: [idParam, workspaceHeader], requestBody: json(UpdateMappingSynonymInput), responses: { "200": { description: "Switched off or back on" } } },
      },
      "/api/v1/workspaces/{ws}/mapping-preview": {
        post: { operationId: "previewMapping", parameters: [workspaceParam], requestBody: json(MappingPreviewInput), responses: { "201": { description: "What each column becomes, unknown values with the nearest known one, ratios, rejected rows (D-006); nothing is written", ...json(MappingPreviewReport) } } },
      },
      "/api/v1/workspaces/{ws}/mapping-suggestions": {
        post: { operationId: "suggestMappingFromSample", parameters: [workspaceParam], requestBody: json(SuggestMappingSampleInput), responses: { "201": { description: "A suggested mapping for a file's header and first rows (nothing saved); 503 without OPENAI_API_KEY" } } },
      },
      "/api/v1/sources/{id}/suggest-mapping": {
        post: { operationId: "suggestSourceMapping", parameters: [idParam, workspaceHeader], responses: { "201": { description: "Suggested column mapping from @budget/ai (not applied); 503 without OPENAI_API_KEY" } } },
      },
      "/api/v1/sources/{id}/run": {
        post: {
          operationId: "runSource",
          parameters: [idParam, workspaceHeader],
          requestBody: { required: false, ...json(RunSourceInput) },
          responses: { "201": { description: "Queued ingest run (the ingest worker runs it); 409 while a run is queued or running. restatementOf lets it load facts into that closed period" } },
        },
      },
      "/api/v1/sources/{id}/runs": {
        get: { operationId: "listSourceRuns", parameters: [idParam, workspaceHeader], responses: { "200": { description: "Runs, newest first: counts, match coverage summary, rejected-rows report URI" } } },
      },
      "/api/v1/workspaces/{ws}/unmatched-spend": {
        get: {
          operationId: "listUnmatchedSpend",
          parameters: [workspaceParam, { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 1000 } }],
          responses: { "200": { description: "Unmatched spend grouped by dimension tuple, largest first" } },
        },
      },
      "/api/v1/workspaces/{ws}/unmatched-spend/map": {
        post: { operationId: "mapUnmatchedSpend", parameters: [workspaceParam], requestBody: json(MapUnmatchedInput), responses: { "201": { description: "Facts assigned to the envelope, per fact table" } } },
      },
      "/api/v1/uploads": {
        post: { operationId: "createUpload", parameters: [workspaceHeader], requestBody: json(CreateUploadInput), responses: { "201": { description: "gs:// URI and a URL to PUT the CSV to" } } },
      },
      "/api/v1/comments/{id}/reactions": {
        post: { operationId: "addReaction", parameters: [idParam, workspaceHeader], requestBody: json(ReactionInput), responses: { "201": { description: "The caller's reaction (idempotent); the emoji's count" } } },
        delete: { operationId: "removeReaction", parameters: [idParam, workspaceHeader], requestBody: json(ReactionInput), responses: { "200": { description: "The caller's reaction removed (idempotent); the emoji's count" } } },
      },
      "/api/v1/workspaces/{ws}/people": {
        get: { operationId: "listPeople", parameters: [workspaceParam, { name: "q", in: "query", required: false, schema: { type: "string" } }, { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 50 } }], responses: { "200": { description: "Accounts and groups that can be @mentioned here" } } },
      },
      "/api/v1/workspaces/{ws}/query": {
        post: { operationId: "query", parameters: [workspaceParam], requestBody: json(QueryRequest), responses: { "201": { description: "One page of planner rows, the totals and the data version; the caller's read scope is ANDed into the filter", ...json(QueryResponse) } } },
      },
      "/api/v1/workspaces/{ws}/tree": {
        post: { operationId: "tree", parameters: [workspaceParam], requestBody: json(TreeRequest), responses: { "201": { description: "One level of a hierarchy template's tree from rollup_cache, with the root as totals; available: false (scoped caller or period not cached) means ask /query; X-Data-Version header", ...json(TreeResponse) } } },
      },
      "/api/v1/workspaces/{ws}/manual-entries": {
        get: { operationId: "listManualEntries", parameters: [workspaceParam, { name: "status", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated: DRAFT,SUBMITTED,APPROVED,REJECTED" }, { name: "channel", in: "query", required: false, schema: { type: "string" } }], responses: { "200": { description: "Batches, newest first (rows omitted, rowCount)" } } },
        post: { operationId: "createManualEntry", parameters: [workspaceParam], requestBody: json(CreateManualEntryInput), responses: { "201": { description: "A DRAFT batch, its rows' issues (validated like ingestion) and warnings (rows no budget would take)" } } },
      },
      "/api/v1/manual-entries/{id}": {
        get: { operationId: "getManualEntry", parameters: [idParam, workspaceHeader], responses: { "200": { description: "The batch, its issues and warnings, the latest approval decision and, once approved, the lineage of its facts" } } },
        patch: { operationId: "updateManualEntry", parameters: [idParam, workspaceHeader], requestBody: json(UpdateManualEntryInput), responses: { "200": { description: "Rows saved as typed, with their issues; only while DRAFT" } } },
      },
      "/api/v1/manual-entries/{id}/submit": {
        post: { operationId: "submitManualEntry", parameters: [idParam, workspaceHeader], responses: { "201": { description: "An approval request (entity_type manual_entry), or approved at once by an empty chain; 422 while a row has an issue" } } },
      },
      "/api/v1/me/home": {
        get: { operationId: "getHome", parameters: [workspaceHeader], responses: { "200": { description: "Waiting on me (approvals I can decide, mentions in open threads, alerts assigned to me, unmatched spend), then pacing per top-level budget, recents and saved views", ...json(HomeResponse) } } },
      },
      "/api/v1/tours": {
        get: { operationId: "listTours", parameters: [workspaceHeader, { name: "role", in: "query", required: false, schema: { type: "string", enum: ["planner", "approver", "finance", "data_admin"] } }, { name: "all", in: "query", required: false, schema: { type: "string", enum: ["true", "false"] } }], responses: { "200": { description: "The caller's role tours not completed at their current version (all=true: every one, with `completed`)" } } },
      },
      "/api/v1/tours/{id}/complete": {
        post: { operationId: "completeTour", parameters: [idParam, workspaceHeader], requestBody: json(CompleteTourInput), responses: { "201": { description: "Recorded for the caller (idempotent)" } } },
      },
      "/api/v1/tours/{id}": {
        patch: { operationId: "updateTour", parameters: [idParam, workspaceHeader], requestBody: json(UpdateTourInput), responses: { "200": { description: "Workspace admins: a new version (a default becomes the workspace's copy)" } } },
      },
      "/api/v1/workspace-templates": {
        get: { operationId: "listWorkspaceTemplates", responses: { "200": { description: "Org admins: the built-in default_agency template and the org's" } } },
      },
      "/api/v1/workspaces": {
        get: { operationId: "listWorkspaces", responses: { "200": { description: "Superadmins: every workspace of the org with its status, admins and counts", ...json(OrgWorkspacesResponse) } } },
        post: { operationId: "createWorkspace", requestBody: json(CreateWorkspaceInput), responses: { "201": { description: "Org admins: a workspace from a template (hierarchy templates, policies, rules, a view, tours; missing org dimensions), with the demo dataset when asked" } } },
      },
      "/api/v1/workspaces/{ws}": {
        patch: { operationId: "setWorkspaceStatus", parameters: [workspaceParam], requestBody: json(UpdateWorkspaceStatusInput), responses: { "200": { description: "Superadmins: archived (read-only, hidden from its members) or restored" } } },
        delete: { operationId: "deleteWorkspace", parameters: [workspaceParam], requestBody: json(DeleteWorkspaceInput), responses: { "200": { description: "Superadmins: an archived workspace, its name typed, becomes a tombstone purged after the retention window" }, "409": { description: "Not archived, or already deleted" } } },
      },
      "/api/v1/workspaces/{ws}/undelete": {
        post: { operationId: "undeleteWorkspace", parameters: [workspaceParam], responses: { "200": { description: "Superadmins: back as archived, within the retention window" } } },
      },
      "/api/v1/me/notifications": {
        get: { operationId: "myNotifications", parameters: [workspaceHeader], responses: { "200": { description: "The caller's latest notifications in the workspace and the unread count", ...json(NotificationsResponse) } } },
      },
      "/api/v1/me/notifications/read": {
        post: { operationId: "readNotifications", parameters: [workspaceHeader], requestBody: json(MarkNotificationsReadInput), responses: { "200": { description: "How many notifications were marked read" } } },
      },
      "/api/v1/workspaces/{ws}/baselines": {
        get: { operationId: "listBaselines", parameters: [workspaceParam, { name: "includeArchived", in: "query", required: false, schema: { type: "string", enum: ["true", "false"] } }, { name: "envelopeId", in: "query", required: false, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Snapshots, newest first (Phase E)", ...json(BaselinesResponse) } } },
        post: { operationId: "saveBaseline", parameters: [workspaceParam], requestBody: json(CreateBaselineInput), responses: { "201": { description: "A snapshot of the workspace, a filter or one budget's subtree, taken now" } } },
      },
      "/api/v1/baselines/{id}": {
        get: { operationId: "getBaseline", parameters: [idParam, workspaceHeader], responses: { "200": { description: "One snapshot", ...json(BaselineView) } } },
        patch: { operationId: "updateBaseline", parameters: [idParam, workspaceHeader], requestBody: json(UpdateBaselineInput), responses: { "200": { description: "Renamed, re-noted or archived; its rows never change" } } },
      },
      "/api/v1/baselines/{id}/rows": {
        get: { operationId: "getBaselineRows", parameters: [idParam, workspaceHeader, { name: "limit", in: "query", required: false, schema: { type: "integer" } }], responses: { "200": { description: "The snapshot's frozen rows as the tree they were saved in, cut to the caller's scope", ...json(BaselineRowsResponse) } } },
      },
      "/api/v1/baselines/{id}/export.csv": {
        get: { operationId: "exportBaselineCsv", parameters: [idParam, workspaceHeader], responses: { "200": { description: "The snapshot's rows as CSV (text/csv)" } } },
      },
      "/api/v1/baselines/{id}/report": {
        get: { operationId: "baselineReport", parameters: [idParam, workspaceHeader, { name: "against", in: "query", required: false, schema: { type: "string", format: "uuid" } }, { name: "limit", in: "query", required: false, schema: { type: "integer" } }], responses: { "200": { description: "The snapshot against now or another snapshot", ...json(BaselineReport) } } },
      },
      "/api/v1/org/people": {
        get: { operationId: "listOrgPeople", responses: { "200": { description: "Superadmins: everyone in the org and where they hold roles", ...json(OrgPeopleResponse) } } },
      },
      "/api/v1/org/people/{id}": {
        patch: { operationId: "updateOrgPerson", parameters: [idParam], requestBody: json(UpdateOrgPersonInput), responses: { "200": { description: "Superadmins: deactivate or reactivate someone" } } },
      },
      "/api/v1/workspaces/{ws}/demo-data": {
        get: { operationId: "getDemoData", parameters: [workspaceParam], responses: { "200": { description: "Demo rows left: envelopes and targets" } } },
      },
      "/api/v1/workspaces/{ws}/demo-data/purge": {
        post: { operationId: "purgeDemoData", parameters: [workspaceParam], responses: { "201": { description: "Every demo row deleted in one transaction; the template's configuration stays" } } },
      },
      "/api/v1/workspaces/{ws}/experiments": {
        get: { operationId: "listExperiments", parameters: [workspaceParam, { name: "status", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated statuses (PLANNED,RUNNING,EVALUATING,CONCLUDED,ABANDONED)" }], responses: { "200": { description: "Experiments, newest first, with their linked envelopes" } } },
        post: { operationId: "createExperiment", parameters: [workspaceParam], requestBody: json(CreateExperimentInput), responses: { "201": { description: "The experiment, PLANNED" } } },
      },
      "/api/v1/experiments/{id}": {
        get: { operationId: "getExperiment", parameters: [idParam, workspaceHeader], responses: { "200": { description: "{ experiment, readout }: the planner's totals and weighted primary metric for test and control over the window, the delta and whether the criterion is met", ...json(ExperimentReadout) } } },
        patch: { operationId: "updateExperiment", parameters: [idParam, workspaceHeader], requestBody: json(UpdateExperimentInput), responses: { "200": { description: "Updated (not once concluded or abandoned)" } } },
      },
      "/api/v1/experiments/{id}/link": {
        post: { operationId: "linkExperimentEnvelope", parameters: [idParam, workspaceHeader], requestBody: json(LinkEnvelopeInput), responses: { "201": { description: "Linked; a TEST envelope gets the system tag `experiment`" } } },
      },
      "/api/v1/experiments/{id}/start": { post: { operationId: "startExperiment", parameters: [idParam, workspaceHeader], responses: { "201": { description: "PLANNED → RUNNING" } } } },
      "/api/v1/experiments/{id}/evaluate": { post: { operationId: "evaluateExperiment", parameters: [idParam, workspaceHeader], responses: { "201": { description: "RUNNING → EVALUATING" } } } },
      "/api/v1/experiments/{id}/abandon": { post: { operationId: "abandonExperiment", parameters: [idParam, workspaceHeader], responses: { "201": { description: "→ ABANDONED (not once concluded)" } } } },
      "/api/v1/experiments/{id}/conclude": {
        post: { operationId: "concludeExperiment", parameters: [idParam, workspaceHeader], requestBody: json(ConcludeExperimentInput), responses: { "201": { description: "CONCLUDED; the decision is posted as a comment in a thread on every linked envelope" }, "422": { description: "No decision (min 20 characters), or no linked envelope" } } },
      },
      "/api/v1/workspaces/{ws}/timeline": {
        get: {
          operationId: "getTimeline",
          parameters: [
            workspaceParam,
            { name: "filter", in: "query", required: false, schema: { type: "string" }, description: "FilterGroup as lz-string (or JSON)" },
            { name: "groupBy", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated dimension keys; default the hierarchy template's path" },
            { name: "templateId", in: "query", required: false, schema: { type: "string", format: "uuid" } },
            { name: "from", in: "query", required: false, schema: { type: "string", format: "date" } },
            { name: "to", in: "query", required: false, schema: { type: "string", format: "date" } },
            { name: "period", in: "query", required: false, schema: { type: "string" }, description: "Preset name or a PeriodSpec as JSON when from/to are not given; default current_year" },
            { name: "asOf", in: "query", required: false, schema: { type: "string", format: "date-time" } },
            { name: "zoom", in: "query", required: false, schema: { type: "string", enum: ["week", "month", "quarter", "fy"] } },
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 5000 } },
          ],
          responses: { "200": { description: "Group, envelope and target bars on the fiscal calendar, with markers and key dates; X-Data-Version header", ...json(TimelineResponse) } },
        },
      },
      "/api/v1/workspaces/{ws}/saved-views": {
        get: { operationId: "listSavedViews", parameters: [workspaceParam, { name: "screen", in: "query", required: false, schema: { type: "string" } }], responses: { "200": { description: "The caller's views and the workspace's shared ones" } } },
        post: { operationId: "createSavedView", parameters: [workspaceParam], requestBody: json(CreateSavedViewInput), responses: { "201": { description: "Saved view; visibility workspace needs view.share_workspace" } } },
      },
      "/api/v1/saved-views/{id}": {
        patch: { operationId: "updateSavedView", parameters: [idParam, workspaceHeader], requestBody: json(UpdateSavedViewInput), responses: { "200": { description: "Updated view (owner, or an admin for a shared view)" } } },
        delete: { operationId: "deleteSavedView", parameters: [idParam, workspaceHeader], responses: { "200": { description: "Removed; the audit row keeps what it was" } } },
      },
      "/api/v1/workspaces/{ws}/periods": {
        get: { operationId: "listPeriods", parameters: [workspaceParam], responses: { "200": { description: "The fiscal calendar: years, quarters, months as defined and custom partitions, each with its closure", ...json(z.array(PeriodRow)) } } },
        post: { operationId: "createPeriod", parameters: [workspaceParam], requestBody: json(CreatePeriodInput), responses: { "201": { description: "Created; 409 when the key exists or it overlaps another period of its kind" } } },
      },
      "/api/v1/workspaces/{ws}/periods/generate": {
        post: { operationId: "generatePeriods", parameters: [workspaceParam], requestBody: json(GeneratePeriodsInput), responses: { "201": { description: "{ created, kept }: a fiscal year's periods in a pattern (calendar, 4-4-5, 4-5-4, 5-4-4); existing keys are kept" } } },
      },
      "/api/v1/workspaces/{ws}/fiscal-year": {
        get: { operationId: "getFiscalYearStart", parameters: [workspaceParam], responses: { "200": { description: "{ startMonth }: the month the fiscal year starts in", ...json(z.object({ startMonth: z.number().int() })) } } },
        patch: { operationId: "setFiscalYearStart", parameters: [workspaceParam], requestBody: json(z.object({ startMonth: z.number().int().min(1).max(12) })), responses: { "200": { description: "The month the fiscal year starts in; computed periods follow, rows stay" } } },
      },
      "/api/v1/periods/{id}": {
        patch: { operationId: "updatePeriod", parameters: [idParam, workspaceHeader], requestBody: json(UpdatePeriodInput), responses: { "200": { description: "Updated; 409 when it has a closure (its dates are frozen in the report)" } } },
        delete: { operationId: "deletePeriod", parameters: [idParam, workspaceHeader], responses: { "200": { description: "Deleted; 409 when it has a closure or budgets aligned to it" } } },
      },
      "/api/v1/workspaces/{ws}/closures": {
        get: { operationId: "listClosures", parameters: [workspaceParam], responses: { "200": { description: "Closures, newest first (restated ones included)" } } },
        post: {
          operationId: "closePeriod",
          parameters: [workspaceParam],
          requestBody: json(CloseInput),
          responses: {
            "201": { description: "Closed: overlapping envelopes are LOCKED and the rows are in the closure table", ...json(ClosureView) },
            "409": { description: "The period is already closed, or has not ended" },
            "503": { description: "No closure sink (BigQuery) in this environment" },
          },
        },
      },
      "/api/v1/closures/{id}/restate": {
        post: { operationId: "restateClosure", parameters: [idParam, workspaceHeader], requestBody: json(RestateInput), responses: { "201": { description: "Restated; envelopes no other closed closure covers get their prior status back" } } },
      },
      "/api/v1/closures/{id}/report": {
        get: { operationId: "getClosureReport", parameters: [idParam, workspaceHeader], responses: { "200": { description: "The frozen report: variance summary and registry snapshot as stored at close" } } },
      },
      "/api/v1/exports": {
        post: {
          operationId: "createExport",
          parameters: [workspaceHeader],
          requestBody: json(CreateExportInput),
          responses: { "201": { description: "Queued export job; the caller's read scope is ANDed into the filter", ...json(ExportJobView) }, "503": { description: "kind sheets: Sheets push is not configured in this environment" } },
        },
      },
      "/api/v1/exports/{jobId}": {
        get: {
          operationId: "getExport",
          parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string", format: "uuid" } }, workspaceHeader],
          responses: { "200": { description: "The caller's export job; downloadUrl while done", ...json(ExportJobView) } },
        },
      },
      "/api/v1/workspaces/{ws}/naming-templates": {
        get: { operationId: "listNamingTemplates", parameters: [workspaceParam], responses: { "200": { description: "Naming templates, the active one of each kind first" } } },
        post: { operationId: "createNamingTemplate", parameters: [workspaceParam], requestBody: json(CreateNamingTemplateInput), responses: { "201": { description: "The new active template of its kind; envelopes renamed (or queued on a large workspace)" } } },
      },
      "/api/v1/naming-templates/preview": {
        post: { operationId: "previewNamingTemplate", parameters: [workspaceHeader], requestBody: json(NamingPreviewInput), responses: { "201": { description: "{ previews: [{ envelopeId, name, rendered }] } for the samples (five live leaves when none are given)" } } },
      },
      "/api/v1/naming-templates/{id}": {
        patch: { operationId: "updateNamingTemplate", parameters: [idParam, workspaceHeader], requestBody: json(UpdateNamingTemplateInput), responses: { "200": { description: "A new version of the template" } } },
      },
      "/api/v1/workspaces/{ws}/overview": {
        get: { operationId: "getOverview", parameters: [workspaceParam, { name: "period", in: "query", required: false, schema: { type: "string" }, description: "A relative preset (current_month, current_quarter, current_year, last_30_days, last_90_days, ytd, next_90_days) or fiscal:<key>, one of the workspace's periods (e.g. fiscal:2026-Q2)" }, { name: "rows", in: "query", required: false, schema: { type: "string" }, description: "Heatmap rows: a registry granularity key (default country)" }, { name: "cols", in: "query", required: false, schema: { type: "string" }, description: "Heatmap columns: another granularity key (default platform)" }], responses: { "200": { description: "The Overview dashboard: heatmap (any two granularities; the registry's list for the pickers), top variances, KPI vs target, open alerts, approvals due, data freshness" } } },
      },
      "/api/v1/workspaces/{ws}/pacing": {
        get: {
          operationId: "getPacing",
          parameters: [
            workspaceParam,
            { name: "filter", in: "query", required: false, schema: { type: "string" }, description: "FilterGroup as JSON" },
            { name: "period", in: "query", required: false, schema: { type: "string" }, description: "Preset name (current_year, current_quarter, …) or a PeriodSpec as JSON; default current_year" },
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 1000 } },
          ],
          responses: { "200": { description: "Pace measures per envelope, CPA vs target, open alerts, totals" } },
        },
      },
      "/api/v1/workspaces/{ws}/rules": {
        get: { operationId: "listRules", parameters: [workspaceParam], responses: { "200": { description: "Pacing rules" } } },
        post: { operationId: "createRule", parameters: [workspaceParam], requestBody: json(CreateRuleInput), responses: { "201": { description: "Created rule (workspace-wide rule.manage role)" } } },
      },
      "/api/v1/rules/{id}": {
        patch: { operationId: "updateRule", parameters: [idParam, workspaceHeader], requestBody: json(UpdateRuleInput), responses: { "200": { description: "Updated rule" } } },
        delete: { operationId: "deleteRule", parameters: [idParam, workspaceHeader], responses: { "200": { description: "The rule stops and is kept for its alerts' history; its open alerts are resolved" } } },
      },
      "/api/v1/alerts": {
        get: {
          operationId: "listAlerts",
          parameters: [
            workspaceHeader,
            { name: "status", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated OPEN, ACKNOWLEDGED, SNOOZED, RESOLVED; default the open ones" },
            { name: "severity", in: "query", required: false, schema: { type: "string", enum: ["info", "warning", "critical", "data"] } },
            { name: "ruleId", in: "query", required: false, schema: { type: "string", format: "uuid" } },
            { name: "envelopeId", in: "query", required: false, schema: { type: "string", format: "uuid" } },
            { name: "filter", in: "query", required: false, schema: { type: "string" }, description: "FilterGroup as JSON" },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500 } },
          ],
          responses: { "200": { description: "Alerts, newest first, within the caller's scope" } },
        },
      },
      "/api/v1/alerts/{id}": {
        patch: { operationId: "updateAlert", parameters: [idParam, workspaceHeader], requestBody: json(UpdateAlertInput), responses: { "200": { description: "Updated alert; 409 once resolved" } } },
      },
      "/api/v1/threads": {
        get: {
          operationId: "listThreads",
          parameters: [
            workspaceHeader,
            { name: "anchorType", in: "query", required: true, schema: { type: "string" } },
            { name: "anchorId", in: "query", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: { "200": { description: "The anchor's threads with comments (deleted ones without body) and display names" } },
        },
        post: { operationId: "createThread", parameters: [workspaceHeader], requestBody: json(CreateThreadInput), responses: { "201": { description: "Created thread with its first comment; only envelope and target threads can block" } } },
      },
      "/api/v1/threads/{id}/comments": {
        post: { operationId: "addComment", parameters: [idParam, workspaceHeader], requestBody: json(CommentInput), responses: { "201": { description: "Created comment; mentions notify through notify-worker" } } },
      },
      "/api/v1/comments/{id}": {
        patch: { operationId: "editComment", parameters: [idParam, workspaceHeader], requestBody: json(UpdateCommentInput), responses: { "200": { description: "Edited comment (author only; history kept)" } } },
        delete: { operationId: "deleteComment", parameters: [idParam, workspaceHeader], responses: { "200": { description: "Soft-deleted comment (author or workspace admin)" } } },
      },
      "/api/v1/threads/{id}/resolve": {
        post: { operationId: "resolveThread", parameters: [idParam, workspaceHeader], responses: { "201": { description: "Resolved (thread author, anchor owner, eligible approver or admin)" } } },
      },
      "/api/v1/threads/{id}/reopen": {
        post: { operationId: "reopenThread", parameters: [idParam, workspaceHeader], responses: { "201": { description: "Reopened" } } },
      },
      "/api/v1/subscriptions": {
        post: { operationId: "setSubscription", parameters: [workspaceHeader], requestBody: json(SubscriptionInput), responses: { "201": { description: "Follow or stop following an entity's threads" } } },
      },
      "/api/v1/workspaces/{ws}/general": {
        get: { operationId: "getWorkspaceGeneral", parameters: [workspaceParam], responses: { "200": { description: "The workspace's name, slug, reporting currency and fiscal-year start" } } },
        patch: { operationId: "updateWorkspaceGeneral", parameters: [workspaceParam], requestBody: json(UpdateWorkspaceInput), responses: { "200": { description: "The renamed workspace" } } },
      },
      "/api/v1/workspaces/{ws}/integrations/slack": {
        get: { operationId: "getSlackSettings", parameters: [workspaceParam], responses: { "200": { description: "Whether the bot token and signing secret are set, the workspace's Slack settings, the URLs Slack calls and the app manifest" } } },
        patch: { operationId: "updateSlackSettings", parameters: [workspaceParam], requestBody: json(UpdateSlackSettingsInput), responses: { "200": { description: "The workspace's Slack settings" } } },
      },
      "/api/v1/workspaces/{ws}/integrations/slack/test": {
        post: { operationId: "sendSlackTest", parameters: [workspaceParam], requestBody: json(SlackTestInput), responses: { "201": { description: "A test message is queued for the notify worker" } } },
      },
      "/api/v1/slack/interactions": {
        post: { operationId: "slackInteractions", description: "Called by Slack (signed with SLACK_SIGNING_SECRET; no JWT): button clicks and form submissions", responses: { "200": { description: "What Slack expects: {} or form errors" } } },
      },
      "/api/v1/slack/commands": {
        post: { operationId: "slackCommands", description: "Called by Slack (signed; no JWT): the /budget slash command", responses: { "200": { description: "An ephemeral reply" } } },
      },
      "/api/v1/workspaces/{ws}/tags": {
        get: { operationId: "listTags", parameters: [workspaceParam], responses: { "200": { description: "Tags with usage counts" } } },
        post: { operationId: "createTag", parameters: [workspaceParam], requestBody: json(CreateTagInput), responses: { "201": { description: "Created tag" } } },
      },
      "/api/v1/workspaces/{ws}/tags/applied": {
        get: {
          operationId: "appliedTags",
          parameters: [workspaceParam, { name: "type", in: "query", required: true, schema: { type: "string", enum: ["envelope", "target", "alert", "approval_request", "thread"] } }, { name: "ids", in: "query", required: true, schema: { type: "string" }, description: "Comma-separated entity ids (up to 200)" }],
          responses: { "200": { description: "Each entity id's tags; entities without tags are left out" } },
        },
      },
      "/api/v1/tags/{id}": {
        patch: { operationId: "updateTag", parameters: [idParam, workspaceHeader], requestBody: json(UpdateTagInput), responses: { "200": { description: "Renamed, recoloured, or merged into another tag" } } },
      },
      "/api/v1/tags/apply": {
        post: { operationId: "applyTag", parameters: [workspaceHeader], requestBody: json(ApplyTagInput), responses: { "201": { description: "Tagged up to 10k entities (duplicates skipped)" } } },
        delete: { operationId: "removeTag", parameters: [workspaceHeader], requestBody: json(ApplyTagInput), responses: { "200": { description: "Untagged the entities" } } },
      },
      "/api/v1/workspaces/{ws}/search": {
        get: {
          operationId: "search",
          parameters: [
            workspaceParam,
            { name: "q", in: "query", required: false, schema: { type: "string" }, description: "Free text plus qualifiers: type:, status:, owner:@me, tag:, period:, budget:>N, cpa:>target, has:open-thread, mentions:@me, updated:<7d, <dimension key>:<code>" },
            { name: "types", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated entity types" },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 50 }, description: "Hits per type (default 5)" },
          ],
          responses: { "200": { description: "{ groups: [{ type, count, more (count is a lower bound), hits: [{ id, title, path, status, facets, deepLink }] }], parsed }" } },
        },
      },
      "/api/v1/workspaces/{ws}/search/suggest": {
        get: {
          operationId: "searchSuggest",
          parameters: [workspaceParam, { name: "prefix", in: "query", required: false, schema: { type: "string" }, description: "A qualifier-key prefix, or key: plus a value prefix" }],
          responses: { "200": { description: "{ keys: [{ key, label, kind }], values: [{ value, label }] }" } },
        },
      },
      "/api/v1/assets/icons/{file}": {
        get: { operationId: "getIconAsset", parameters: [{ name: "file", in: "path", required: true, schema: { type: "string" } }, workspaceHeader], responses: { "200": { description: "An uploaded icon's sanitized SVG: { icon, svg }" } } },
      },
      "/api/v1/assets": {
        post: { operationId: "uploadIconAsset", parameters: [workspaceHeader], requestBody: json(UploadAssetInput), responses: { "200": { description: "Sanitized SVG icon asset" } } },
      },
    },
  };
}
