import { Module } from "@nestjs/common";
import { ViewsController } from "./views.controller.js";

@Module({ controllers: [ViewsController] })
export class ViewsModule {}
