import { CreatePolicyInput, DecideInput, ExternalEvidenceInput, SubmitVersionInput, UpdatePolicyInput, WithdrawInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";

export class SubmitVersionDto extends createZodDto(SubmitVersionInput) {}
export class DecideDto extends createZodDto(DecideInput) {}
export class ExternalEvidenceDto extends createZodDto(ExternalEvidenceInput) {}
export class WithdrawDto extends createZodDto(WithdrawInput) {}
export class CreatePolicyDto extends createZodDto(CreatePolicyInput) {}
export class UpdatePolicyDto extends createZodDto(UpdatePolicyInput) {}
