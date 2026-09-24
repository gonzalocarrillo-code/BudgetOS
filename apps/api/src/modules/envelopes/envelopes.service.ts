import { Inject, Injectable } from "@nestjs/common";
import { commitBulk } from "./bulk/commit.js";
import { exportCsv, importCsv } from "./bulk/csv-roundtrip.js";
import { buildPreview } from "./bulk/preview.js";
import { PREVIEW_STORE, type PreviewStore } from "./bulk/preview-store.js";
import { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../common/tenant.js";
import { createDraftVersion } from "./commands/create-draft-version.js";
import { createEnvelope } from "./commands/create-envelope.js";
import { restoreVersion } from "./commands/restore-version.js";
import { submitVersion } from "./commands/submit-version.js";
import { withdrawEnvelope } from "../approvals/commands/withdraw.js";
import { updateEnvelope } from "./commands/update-envelope.js";
import { updatePhasing } from "./commands/update-phasing.js";
import { getEnvelope, listVersions, versionDto } from "./queries/get-envelope.js";
import { getTimeline, type TimelineParams } from "./queries/timeline.js";

@Injectable()
export class EnvelopesService {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(PREVIEW_STORE) private readonly previews: PreviewStore,
  ) {}

  bulkPreview(auth: AuthContext, body: unknown) {
    return buildPreview(this.prisma, auth, body, this.previews);
  }
  bulkCommit(auth: AuthContext, previewId: string) {
    return commitBulk(this.prisma, auth, previewId, this.previews);
  }
  csvExport(auth: AuthContext, body: unknown) {
    return exportCsv(this.prisma, auth, body);
  }
  csvImport(auth: AuthContext, body: unknown) {
    return importCsv(this.prisma, auth, body, this.previews);
  }

  create(auth: AuthContext, body: unknown) {
    return createEnvelope(this.prisma, auth, body).then((e) => getEnvelope(this.prisma, auth, e.id));
  }
  get(auth: AuthContext, id: string, asOf?: string) {
    return getEnvelope(this.prisma, auth, id, asOf);
  }
  timeline(auth: AuthContext, id: string, params: TimelineParams) {
    return getTimeline(this.prisma, auth, id, params);
  }
  versions(auth: AuthContext, id: string) {
    return listVersions(this.prisma, auth, id);
  }
  async draft(auth: AuthContext, id: string, body: unknown) {
    const v = await createDraftVersion(this.prisma, auth, id, body);
    return versionDto({ ...v, phasing: await this.prisma.envelopePhasing.findMany({ where: { versionId: v.id }, orderBy: { month: "asc" } }) });
  }
  async phasing(auth: AuthContext, id: string, body: unknown) {
    const v = await updatePhasing(this.prisma, auth, id, body);
    return (await listVersions(this.prisma, auth, id)).find((x) => x.id === v.id);
  }
  async restore(auth: AuthContext, id: string, versionId: string, body: unknown) {
    const v = await restoreVersion(this.prisma, auth, id, versionId, body);
    return (await listVersions(this.prisma, auth, id)).find((x) => x.id === v.id);
  }
  submit(auth: AuthContext, id: string, body: unknown) {
    return submitVersion(this.prisma, auth, id, body);
  }
  withdraw(auth: AuthContext, id: string, body: unknown) {
    return withdrawEnvelope(this.prisma, auth, id, body);
  }
  async update(auth: AuthContext, id: string, body: unknown) {
    await updateEnvelope(this.prisma, auth, id, body);
    return getEnvelope(this.prisma, auth, id);
  }
}
