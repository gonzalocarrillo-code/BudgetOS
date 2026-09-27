import { ConcludeExperimentInput, CreateExperimentInput, LinkEnvelopeInput, ListExperimentsQuery, UpdateExperimentInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateExperimentDto extends createZodDto(CreateExperimentInput) {}
export class UpdateExperimentDto extends createZodDto(UpdateExperimentInput) {}
export class LinkEnvelopeDto extends createZodDto(LinkEnvelopeInput) {}
export class ConcludeExperimentDto extends createZodDto(ConcludeExperimentInput) {}
export class ListExperimentsQueryDto extends createZodDto(ListExperimentsQuery) {}
