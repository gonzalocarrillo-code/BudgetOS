import { ApplyTagInput, CommentInput, CreateTagInput, CreateThreadInput, ListThreadsQuery, SubscriptionInput, UpdateCommentInput, UpdateTagInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateThreadDto extends createZodDto(CreateThreadInput) {}
export class CommentDto extends createZodDto(CommentInput) {}
export class UpdateCommentDto extends createZodDto(UpdateCommentInput) {}
export class ListThreadsQueryDto extends createZodDto(ListThreadsQuery) {}
export class SubscriptionDto extends createZodDto(SubscriptionInput) {}
export class CreateTagDto extends createZodDto(CreateTagInput) {}
export class UpdateTagDto extends createZodDto(UpdateTagInput) {}
export class ApplyTagDto extends createZodDto(ApplyTagInput) {}
