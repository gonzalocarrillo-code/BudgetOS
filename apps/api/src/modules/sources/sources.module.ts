import { Module } from "@nestjs/common";
import { objectStoreFromEnv } from "@budget/workers";
import { SourcesController } from "./sources.controller.js";
import { OBJECT_STORE, SourcesService } from "./sources.service.js";

@Module({
  controllers: [SourcesController],
  providers: [SourcesService, { provide: OBJECT_STORE, useFactory: () => objectStoreFromEnv() }],
})
export class SourcesModule {}
