import { Module } from "@nestjs/common";
import { NamingController } from "./naming.controller.js";

@Module({ controllers: [NamingController] })
export class NamingModule {}
