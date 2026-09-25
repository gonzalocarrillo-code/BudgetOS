import { CloseInput, RestateInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CloseDto extends createZodDto(CloseInput) {}
export class RestateDto extends createZodDto(RestateInput) {}
