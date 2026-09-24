import { CreateRuleInput, ListAlertsQuery, UpdateAlertInput, UpdateRuleInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class CreateRuleDto extends createZodDto(CreateRuleInput) {}
export class UpdateRuleDto extends createZodDto(UpdateRuleInput) {}
export class UpdateAlertDto extends createZodDto(UpdateAlertInput) {}
export class ListAlertsQueryDto extends createZodDto(ListAlertsQuery) {}
