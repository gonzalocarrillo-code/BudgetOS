import { CompleteTourInput, CreateWorkspaceInput, ListToursQuery, MarkNotificationsReadInput, PurgeDemoInput, UpdateTourInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class ListToursQueryDto extends createZodDto(ListToursQuery) {}
export class CompleteTourDto extends createZodDto(CompleteTourInput) {}
export class UpdateTourDto extends createZodDto(UpdateTourInput) {}
export class CreateWorkspaceDto extends createZodDto(CreateWorkspaceInput) {}
export class MarkNotificationsReadDto extends createZodDto(MarkNotificationsReadInput) {}
export class PurgeDemoDto extends createZodDto(PurgeDemoInput) {}
