import { Module } from "@nestjs/common";
import { TargetsController } from "./targets.controller.js";
import { TargetsService } from "./targets.service.js";

@Module({ controllers: [TargetsController], providers: [TargetsService] })
export class TargetsModule {}
