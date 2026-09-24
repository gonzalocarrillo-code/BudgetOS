import { Module } from "@nestjs/common";
import { ASSET_STORE, InMemoryAssetStore } from "./assets/asset-store.js";
import { RegistryController } from "./registry.controller.js";
import { RegistryService } from "./registry.service.js";

@Module({
  controllers: [RegistryController],
  providers: [RegistryService, { provide: ASSET_STORE, useClass: InMemoryAssetStore }],
})
export class RegistryModule {}
