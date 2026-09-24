import { Module } from "@nestjs/common";
import { CommonModule } from "./common/common.module.js";
import { AdminModule } from "./modules/admin/admin.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { EnvelopesModule } from "./modules/envelopes/envelopes.module.js";
import { RegistryModule } from "./modules/registry/registry.module.js";

@Module({
  imports: [CommonModule, AuthModule, AdminModule, RegistryModule, EnvelopesModule],
})
export class AppModule {}
