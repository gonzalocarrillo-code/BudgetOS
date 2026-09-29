import { z } from "zod";
import { BudgetImportCommitInput, BudgetImportInput, BudgetImportTemplateQuery, AddChildInput, BulkRequest, EndEnvelopeInput, ReintroduceInput, MergeEnvelopesInput, MoveEnvelopeInput, SplitEnvelopeInput, CreateDraftVersionInput, CreateEnvelopeInput, CsvExportInput, CsvImportInput, RestoreVersionInput, UpdateEnvelopeInput, UpdatePhasingInput, FamilyInput, ChangeDatesInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateEnvelopeDto extends createZodDto(CreateEnvelopeInput) {}
export class CreateDraftVersionDto extends createZodDto(CreateDraftVersionInput) {}
export class UpdatePhasingDto extends createZodDto(UpdatePhasingInput) {}
export class RestoreVersionDto extends createZodDto(RestoreVersionInput) {}
export class UpdateEnvelopeDto extends createZodDto(UpdateEnvelopeInput) {}
export class BulkRequestDto extends createZodDto(BulkRequest) {}
export class CsvExportDto extends createZodDto(CsvExportInput) {}
export class CsvImportDto extends createZodDto(CsvImportInput) {}
export class MoveEnvelopeDto extends createZodDto(MoveEnvelopeInput) {}
export class SplitEnvelopeDto extends createZodDto(SplitEnvelopeInput) {}
export class EndEnvelopeDto extends createZodDto(EndEnvelopeInput) {}
export class ChangeDatesDto extends createZodDto(ChangeDatesInput) {}
export class ReintroduceDto extends createZodDto(ReintroduceInput) {}
export class MergeEnvelopesDto extends createZodDto(MergeEnvelopesInput) {}
export class AddChildDto extends createZodDto(AddChildInput) {}
/** The union is parsed in full by previewStructure (StructurePreviewInput); the pipe checks the tag. */
export class StructurePreviewDto extends createZodDto(z.object({ op: z.enum(["add_child", "move", "split", "merge"]) }).passthrough()) {}
export class FamilyInputDto extends createZodDto(FamilyInput) {}
export class BudgetImportDto extends createZodDto(BudgetImportInput) {}
export class BudgetImportCommitDto extends createZodDto(BudgetImportCommitInput) {}
export class BudgetImportTemplateDto extends createZodDto(BudgetImportTemplateQuery) {}
