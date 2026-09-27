import { CreateManualEntryInput, ListManualEntriesQuery, UpdateManualEntryInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateManualEntryDto extends createZodDto(CreateManualEntryInput) {}
export class UpdateManualEntryDto extends createZodDto(UpdateManualEntryInput) {}
export class ListManualEntriesQueryDto extends createZodDto(ListManualEntriesQuery) {}
