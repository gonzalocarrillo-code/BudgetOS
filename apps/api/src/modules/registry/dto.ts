import {
  AddValuesInput,
  CreateDimensionInput,
  MergeValuesInput,
  SaveHierarchyTemplateInput,
  UpdateDimensionInput,
  UpdateValueInput,
  UploadAssetInput,
} from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateDimensionDto extends createZodDto(CreateDimensionInput) {}
export class UpdateDimensionDto extends createZodDto(UpdateDimensionInput) {}
export class AddValuesDto extends createZodDto(AddValuesInput) {}
export class UpdateValueDto extends createZodDto(UpdateValueInput) {}
export class MergeValuesDto extends createZodDto(MergeValuesInput) {}
export class SaveHierarchyTemplateDto extends createZodDto(SaveHierarchyTemplateInput) {}
export class UploadAssetDto extends createZodDto(UploadAssetInput) {}
