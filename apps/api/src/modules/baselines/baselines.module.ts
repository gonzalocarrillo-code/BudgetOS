import { Module } from "@nestjs/common";
import { BaselinesController } from "./baselines.controller.js";

@Module({ controllers: [BaselinesController] })
export class BaselinesModule {}
