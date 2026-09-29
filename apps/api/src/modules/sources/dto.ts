import { CreateMappingProfileInput, CreateMappingSynonymInput, CreateSourceInput, CreateUploadInput, MapUnmatchedInput, MappingPreviewInput, MatchMappingProfileInput, RunSourceInput, SuggestMappingSampleInput, UpdateMappingProfileInput, UpdateMappingSynonymInput, UpdateSourceInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateSourceDto extends createZodDto(CreateSourceInput) {}
export class UpdateSourceDto extends createZodDto(UpdateSourceInput) {}
export class MapUnmatchedDto extends createZodDto(MapUnmatchedInput) {}
export class CreateUploadDto extends createZodDto(CreateUploadInput) {}
export class RunSourceDto extends createZodDto(RunSourceInput) {}
export class SuggestMappingSampleDto extends createZodDto(SuggestMappingSampleInput) {}
export class CreateMappingProfileDto extends createZodDto(CreateMappingProfileInput) {}
export class UpdateMappingProfileDto extends createZodDto(UpdateMappingProfileInput) {}
export class MatchMappingProfileDto extends createZodDto(MatchMappingProfileInput) {}
export class CreateMappingSynonymDto extends createZodDto(CreateMappingSynonymInput) {}
export class UpdateMappingSynonymDto extends createZodDto(UpdateMappingSynonymInput) {}
export class MappingPreviewDto extends createZodDto(MappingPreviewInput) {}
