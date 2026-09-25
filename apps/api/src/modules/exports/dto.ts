import { CreateExportInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateExportDto extends createZodDto(CreateExportInput) {}
