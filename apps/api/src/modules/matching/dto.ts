import { AddNamingAliasInput, AnalyzeNamesInput, CreateMatchRuleInput, CreateNamingConventionInput, NamingConventionPreviewInput, SuggestNamingInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateMatchRuleDto extends createZodDto(CreateMatchRuleInput) {}
export class CreateNamingConventionDto extends createZodDto(CreateNamingConventionInput) {}
export class NamingConventionPreviewDto extends createZodDto(NamingConventionPreviewInput) {}
export class AddNamingAliasDto extends createZodDto(AddNamingAliasInput) {}
export class AnalyzeNamesDto extends createZodDto(AnalyzeNamesInput) {}
export class SuggestNamingDto extends createZodDto(SuggestNamingInput) {}
