import { Module } from "@nestjs/common";
import { PacingController } from "./pacing.controller.js";

@Module({ controllers: [PacingController] })
export class PacingModule {}
