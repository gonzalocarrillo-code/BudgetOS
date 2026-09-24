import { Module } from "@nestjs/common";
import { ApprovalsController } from "./approvals.controller.js";
import { ApprovalsService } from "./approvals.service.js";

@Module({ controllers: [ApprovalsController], providers: [ApprovalsService] })
export class ApprovalsModule {}
