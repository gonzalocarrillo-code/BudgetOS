import { Module } from "@nestjs/common";
import { objectStoreFromEnv } from "@budget/workers";
import { ExportsController } from "./exports.controller.js";
import { EXPORT_STORE, ExportsService } from "./exports.service.js";

@Module({
  controllers: [ExportsController],
  providers: [ExportsService, { provide: EXPORT_STORE, useFactory: () => objectStoreFromEnv() }],
})
export class ExportsModule {}
