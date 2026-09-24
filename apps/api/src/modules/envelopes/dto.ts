import { BulkRequest, MergeEnvelopesInput, MoveEnvelopeInput, SplitEnvelopeInput, CreateDraftVersionInput, CreateEnvelopeInput, CsvExportInput, CsvImportInput, RestoreVersionInput, UpdateEnvelopeInput, UpdatePhasingInput } from "@budget/domain";
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
export class MergeEnvelopesDto extends createZodDto(MergeEnvelopesInput) {}
