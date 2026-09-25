import { Module } from "@nestjs/common";
import { ClosuresController } from "./closures.controller.js";
import { ClosuresService } from "./closures.service.js";
import { CLOSURE_SINK, closureSinkFromEnv } from "./sink.js";

@Module({
  controllers: [ClosuresController],
  providers: [ClosuresService, { provide: CLOSURE_SINK, useFactory: () => closureSinkFromEnv() }],
  exports: [CLOSURE_SINK],
})
export class ClosuresModule {}
