import { Module } from "@nestjs/common";
import { RegistryModule } from "./modules/registry/registry.module.js";

@Module({
  imports: [RegistryModule],
})
export class AppModule {}
