import { Module } from "@nestjs/common";
import { PeriodsController } from "./periods.controller.js";

@Module({ controllers: [PeriodsController] })
export class PeriodsModule {}
