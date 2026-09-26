import { Module } from "@nestjs/common";
import { CommonModule } from "./common/common.module.js";
import { AdminModule } from "./modules/admin/admin.module.js";
import { ApprovalsModule } from "./modules/approvals/approvals.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { ClosuresModule } from "./modules/closures/closures.module.js";
import { QueryModule } from "./modules/query/query.module.js";
import { ViewsModule } from "./modules/views/views.module.js";
import { EnvelopesModule } from "./modules/envelopes/envelopes.module.js";
import { ExportsModule } from "./modules/exports/exports.module.js";
import { RegistryModule } from "./modules/registry/registry.module.js";
import { NamingModule } from "./modules/naming/naming.module.js";
import { OverviewModule } from "./modules/overview/overview.module.js";
import { PacingModule } from "./modules/pacing/pacing.module.js";
import { SearchModule } from "./modules/search/search.module.js";
import { ThreadsModule } from "./modules/threads/threads.module.js";
import { SourcesModule } from "./modules/sources/sources.module.js";
import { TargetsModule } from "./modules/targets/targets.module.js";

@Module({
  imports: [CommonModule, AuthModule, AdminModule, RegistryModule, EnvelopesModule, ApprovalsModule, TargetsModule, SourcesModule, PacingModule, ThreadsModule, SearchModule, ExportsModule, ClosuresModule, QueryModule, ViewsModule, OverviewModule, NamingModule],
})
export class AppModule {}
