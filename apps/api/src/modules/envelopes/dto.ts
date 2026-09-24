import { CreateDraftVersionInput, CreateEnvelopeInput, RestoreVersionInput, UpdateEnvelopeInput, UpdatePhasingInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateEnvelopeDto extends createZodDto(CreateEnvelopeInput) {}
export class CreateDraftVersionDto extends createZodDto(CreateDraftVersionInput) {}
export class UpdatePhasingDto extends createZodDto(UpdatePhasingInput) {}
export class RestoreVersionDto extends createZodDto(RestoreVersionInput) {}
export class UpdateEnvelopeDto extends createZodDto(UpdateEnvelopeInput) {}
