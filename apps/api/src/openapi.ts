import {
  AddValuesInput,
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

export function registryOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title: "Budget OS", version: "0.5.0" },
    paths: {
      "/api/v1/workspaces/{ws}/dimensions": {
        get: { operationId: "listDimensions", parameters: [workspaceParam], responses: { "200": { description: "Registry dimensions visible to the workspace" } } },
        post: { operationId: "createDimension", parameters: [workspaceParam], requestBody: json(CreateDimensionInput), responses: { "200": { description: "Created dimension" } } },
      },
      "/api/v1/dimensions/{id}": {
        patch: { operationId: "updateDimension", parameters: [idParam], requestBody: json(UpdateDimensionInput), responses: { "200": { description: "Updated dimension" } } },
      },
      "/api/v1/dimensions/{id}/values": {
        post: { operationId: "addDimensionValues", parameters: [idParam], requestBody: json(AddValuesInput), responses: { "200": { description: "Upserted dimension values" } } },
      },
      "/api/v1/values/{id}": {
        patch: { operationId: "updateDimensionValue", parameters: [idParam], requestBody: json(UpdateValueInput), responses: { "200": { description: "Updated dimension value" } } },
      },
      "/api/v1/values/{id}/merge": {
        post: { operationId: "mergeDimensionValues", parameters: [idParam], requestBody: json(MergeValuesInput), responses: { "200": { description: "Merged dimension value" } } },
      },
      "/api/v1/workspaces/{ws}/hierarchy-templates": {
        get: { operationId: "listHierarchyTemplates", parameters: [workspaceParam], responses: { "200": { description: "Hierarchy templates" } } },
        post: { operationId: "saveHierarchyTemplate", parameters: [workspaceParam], requestBody: json(SaveHierarchyTemplateInput), responses: { "200": { description: "Saved hierarchy template" } } },
      },
      "/api/v1/assets": {
        post: { operationId: "uploadIconAsset", requestBody: json(UploadAssetInput), responses: { "200": { description: "Sanitized SVG icon asset" } } },
      },
    },
  };
}
