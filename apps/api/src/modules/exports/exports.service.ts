import { Inject, Injectable } from "@nestjs/common";
import type { ObjectStore } from "@budget/workers";
import { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../common/tenant.js";
import { createExport } from "./commands/create-export.js";
import { getExport } from "./queries/get-export.js";

export const EXPORT_STORE = Symbol("EXPORT_STORE");

@Injectable()
export class ExportsService {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(EXPORT_STORE) private readonly store: ObjectStore,
  ) {}

  create(auth: AuthContext, body: unknown) {
    return createExport(this.prisma, auth, body);
  }
  get(auth: AuthContext, jobId: string) {
    return getExport(this.prisma, this.store, auth, jobId);
  }
}
