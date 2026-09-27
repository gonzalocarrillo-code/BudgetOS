import { Module } from "@nestjs/common";
import { ManualEntryController } from "./manual-entry.controller.js";

@Module({ controllers: [ManualEntryController] })
export class ManualEntryModule {}
