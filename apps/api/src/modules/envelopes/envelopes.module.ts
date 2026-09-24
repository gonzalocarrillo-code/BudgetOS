import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { PREVIEW_STORE, RedisPreviewStore, previewStoreFromEnv, type PreviewStore } from "./bulk/preview-store.js";
import { EnvelopesController } from "./envelopes.controller.js";
import { EnvelopesService } from "./envelopes.service.js";

@Module({
  controllers: [EnvelopesController],
  providers: [EnvelopesService, { provide: PREVIEW_STORE, useFactory: () => previewStoreFromEnv() }],
})
export class EnvelopesModule implements OnModuleDestroy {
  constructor(@Inject(PREVIEW_STORE) private readonly previews: PreviewStore) {}

  async onModuleDestroy(): Promise<void> {
    if (this.previews instanceof RedisPreviewStore) await this.previews.close();
  }
}
