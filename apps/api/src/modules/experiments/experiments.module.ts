import { Module } from "@nestjs/common";
import { ExperimentsController } from "./experiments.controller.js";

@Module({ controllers: [ExperimentsController] })
export class ExperimentsModule {}
