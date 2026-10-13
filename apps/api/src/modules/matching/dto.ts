import { AddNamingAliasInput, BulkDictionaryInput, DictionaryEntryInput, FillDictionaryAiInput, UpdateDictionaryEntryInput, AnalyzeNamesInput, CreateMatchRuleInput, CreateNamingConventionInput, NamingConventionPreviewInput, SuggestNamingInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateMatchRuleDto extends createZodDto(CreateMatchRuleInput) {}
export class CreateNamingConventionDto extends createZodDto(CreateNamingConventionInput) {}
export class NamingConventionPreviewDto extends createZodDto(NamingConventionPreviewInput) {}
export class AddNamingAliasDto extends createZodDto(AddNamingAliasInput) {}
export class AnalyzeNamesDto extends createZodDto(AnalyzeNamesInput) {}
export class SuggestNamingDto extends createZodDto(SuggestNamingInput) {}
export class DictionaryEntryDto extends createZodDto(DictionaryEntryInput) {}
export class UpdateDictionaryEntryDto extends createZodDto(UpdateDictionaryEntryInput) {}
export class BulkDictionaryDto extends createZodDto(BulkDictionaryInput) {}
export class FillDictionaryAiDto extends createZodDto(FillDictionaryAiInput) {}
