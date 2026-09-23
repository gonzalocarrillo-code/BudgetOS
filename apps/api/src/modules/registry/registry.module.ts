import { Module } from "@nestjs/common";
import { APP_FILTER, APP_PIPE } from "@nestjs/core";
import { PrismaClient } from "@prisma/client";
import { ZodValidationPipe } from "nestjs-zod";
import { DomainExceptionFilter } from "../../common/domain-exception.filter.js";
import { ASSET_STORE, InMemoryAssetStore } from "./assets/asset-store.js";
import { REGISTRY_ACTOR, UnauthenticatedActor } from "./registry.actor.js";
import { RegistryController } from "./registry.controller.js";
import { RegistryService } from "./registry.service.js";

@Module({
  controllers: [RegistryController],
  providers: [
    RegistryService,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    {
      provide: PrismaClient,
      useFactory: () => {
        const url = process.env["APP_DATABASE_URL"] ?? process.env["DATABASE_URL"];
        if (url === undefined) {
          throw new Error("APP_DATABASE_URL is required");
        }
        return new PrismaClient({ datasources: { db: { url } } });
      },
    },
    { provide: ASSET_STORE, useClass: InMemoryAssetStore },
    { provide: REGISTRY_ACTOR, useClass: UnauthenticatedActor },
  ],
})
export class RegistryModule {}
