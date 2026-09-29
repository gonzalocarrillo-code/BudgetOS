import { CreateTargetDraftInput, CreateTargetInput, ListTargetsQuery, UpdateTargetDatesInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateTargetDto extends createZodDto(CreateTargetInput) {}
export class CreateTargetDraftDto extends createZodDto(CreateTargetDraftInput) {}
export class ListTargetsQueryDto extends createZodDto(ListTargetsQuery) {}
export class UpdateTargetDatesDto extends createZodDto(UpdateTargetDatesInput) {}
