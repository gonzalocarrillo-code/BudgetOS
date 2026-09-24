import {
  AddValuesInput,
  AssignRoleInput,
  MergeEnvelopesInput,
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
  UpdateDimensionInput,
  UpdateValueInput,
  UploadAssetInput,
  CreateMetricInput,
  CreateTargetInput,
  CreateTargetDraftInput,
  CreateSourceInput,
  UpdateSourceInput,
  MapUnmatchedInput,
  CreateUploadInput,
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
    info: { title: "Budget OS", version: "0.5.0" },
    components: {
      securitySchemes: { identityPlatform: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Identity Platform ID token" } },
    },
    security: [{ identityPlatform: [] }],
    paths: {
      "/api/v1/me": {
        get: { operationId: "getMe", responses: { "200": { description: "Caller, roles per workspace and permissions" } } },
      },
      "/api/v1/workspaces/{ws}/roles": {
        get: { operationId: "listRoleAssignments", parameters: [workspaceParam], responses: { "200": { description: "Role assignments in the workspace" } } },
        post: { operationId: "assignRole", parameters: [workspaceParam], requestBody: json(AssignRoleInput), responses: { "200": { description: "Created role assignment" } } },
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
      "/api/v1/envelopes/{id}/split": {
        post: { operationId: "splitEnvelope", parameters: [idParam, workspaceHeader], requestBody: json(SplitEnvelopeInput), responses: { "200": { description: "New siblings with drafts summing to the approved amount; one approval (or auto-approved); source archived once approved" } } },
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
        post: { operationId: "syncGroups", parameters: [workspaceParam], requestBody: json(GroupsSyncInput), responses: { "200": { description: "Group membership after sync" } } },
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
      "/api/v1/sources/{id}/suggest-mapping": {
        post: { operationId: "suggestSourceMapping", parameters: [idParam, workspaceHeader], responses: { "201": { description: "Suggested column mapping from @budget/ai (not applied); 503 without OPENAI_API_KEY" } } },
      },
      "/api/v1/sources/{id}/run": {
        post: { operationId: "runSource", parameters: [idParam, workspaceHeader], responses: { "201": { description: "Queued ingest run (the ingest worker runs it); 409 while a run is queued or running" } } },
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
      "/api/v1/assets": {
        post: { operationId: "uploadIconAsset", parameters: [workspaceHeader], requestBody: json(UploadAssetInput), responses: { "200": { description: "Sanitized SVG icon asset" } } },
      },
    },
  };
}
