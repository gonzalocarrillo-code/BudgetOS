import { QueryRequest } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class QueryRequestDto extends createZodDto(QueryRequest) {}
