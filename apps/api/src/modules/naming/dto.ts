import { CreateNamingTemplateInput, NamingPreviewInput } from "@budget/domain";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export class CreateNamingTemplateDto extends createZodDto(CreateNamingTemplateInput) {}
/** The refine-wrapped schema is parsed in full by the command; the pipe checks the shape. */
export class UpdateNamingTemplateDto extends createZodDto(z.object({}).passthrough()) {}
export class NamingPreviewDto extends createZodDto(NamingPreviewInput) {}
