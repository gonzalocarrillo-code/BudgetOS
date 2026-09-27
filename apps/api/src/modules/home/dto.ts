import { CompleteTourInput, CreateWorkspaceInput, ListToursQuery, UpdateTourInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class ListToursQueryDto extends createZodDto(ListToursQuery) {}
export class CompleteTourDto extends createZodDto(CompleteTourInput) {}
export class UpdateTourDto extends createZodDto(UpdateTourInput) {}
export class CreateWorkspaceDto extends createZodDto(CreateWorkspaceInput) {}
