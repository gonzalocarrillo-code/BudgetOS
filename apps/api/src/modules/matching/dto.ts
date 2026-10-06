import { CreateMatchRuleInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateMatchRuleDto extends createZodDto(CreateMatchRuleInput) {}
