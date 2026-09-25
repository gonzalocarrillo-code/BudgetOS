import { CreateSavedViewInput, ListSavedViewsQuery, UpdateSavedViewInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateSavedViewDto extends createZodDto(CreateSavedViewInput) {}
export class UpdateSavedViewDto extends createZodDto(UpdateSavedViewInput) {}
export class ListSavedViewsQueryDto extends createZodDto(ListSavedViewsQuery) {}
