import { QueryRequest, TimelineQuery } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class QueryRequestDto extends createZodDto(QueryRequest) {}
export class TimelineQueryDto extends createZodDto(TimelineQuery) {}
