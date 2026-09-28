import { Module } from "@nestjs/common";
import { SlackController } from "./slack.controller.js";

@Module({ controllers: [SlackController] })
export class SlackModule {}
