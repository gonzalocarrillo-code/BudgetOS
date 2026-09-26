import { CreateSourceInput, CreateUploadInput, MapUnmatchedInput, RunSourceInput, SuggestMappingSampleInput, UpdateSourceInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateSourceDto extends createZodDto(CreateSourceInput) {}
export class UpdateSourceDto extends createZodDto(UpdateSourceInput) {}
export class MapUnmatchedDto extends createZodDto(MapUnmatchedInput) {}
export class CreateUploadDto extends createZodDto(CreateUploadInput) {}
export class RunSourceDto extends createZodDto(RunSourceInput) {}
export class SuggestMappingSampleDto extends createZodDto(SuggestMappingSampleInput) {}
