import {
  AddValuesInput,
  AssignRoleInput,
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
        get: { operationId: "getEnvelope", parameters: [idParam, workspaceHeader], responses: { "200": { description: "Envelope with its approved version and open draft" } } },
        patch: { operationId: "updateEnvelope", parameters: [idParam, workspaceHeader], requestBody: json(UpdateEnvelopeInput), responses: { "200": { description: "Updated envelope metadata" }, "409": { description: "Stale rowVersion; details carry currentRowVersion and currentVersionId" } } },
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
      "/api/v1/assets": {
        post: { operationId: "uploadIconAsset", parameters: [workspaceHeader], requestBody: json(UploadAssetInput), responses: { "200": { description: "Sanitized SVG icon asset" } } },
      },
    },
  };
}
