import { Inject, Injectable } from "@nestjs/common";
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

@Injectable()
export class EnvelopesService {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  create(auth: AuthContext, body: unknown) {
    return createEnvelope(this.prisma, auth, body).then((e) => getEnvelope(this.prisma, auth, e.id));
  }
  get(auth: AuthContext, id: string) {
    return getEnvelope(this.prisma, auth, id);
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
