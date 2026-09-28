import { AddMemberInput, AssignRoleInput, GroupsSyncInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class AssignRoleDto extends createZodDto(AssignRoleInput) {}
export class GroupsSyncDto extends createZodDto(GroupsSyncInput) {}
export class AddPersonDto extends createZodDto(AddMemberInput) {}
