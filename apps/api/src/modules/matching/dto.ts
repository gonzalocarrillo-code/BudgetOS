import { CreateMatchRuleInput, CreateNamingConventionInput, NamingConventionPreviewInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateMatchRuleDto extends createZodDto(CreateMatchRuleInput) {}
export class CreateNamingConventionDto extends createZodDto(CreateNamingConventionInput) {}
export class NamingConventionPreviewDto extends createZodDto(NamingConventionPreviewInput) {}
