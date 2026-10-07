import { DeleteWorkspaceInput, InviteOrgPersonInput, SetWorkspaceRolesInput, UpdateOrgPersonInput, UpdateWorkspaceStatusInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class UpdateWorkspaceStatusDto extends createZodDto(UpdateWorkspaceStatusInput) {}
export class DeleteWorkspaceDto extends createZodDto(DeleteWorkspaceInput) {}
export class UpdateOrgPersonDto extends createZodDto(UpdateOrgPersonInput) {}
export class InviteOrgPersonDto extends createZodDto(InviteOrgPersonInput) {}
export class SetWorkspaceRolesDto extends createZodDto(SetWorkspaceRolesInput) {}
