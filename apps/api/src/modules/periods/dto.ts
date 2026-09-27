import { CreatePeriodInput, GeneratePeriodsInput, UpdatePeriodInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreatePeriodDto extends createZodDto(CreatePeriodInput) {}
export class GeneratePeriodsDto extends createZodDto(GeneratePeriodsInput) {}
export class UpdatePeriodDto extends createZodDto(UpdatePeriodInput) {}
