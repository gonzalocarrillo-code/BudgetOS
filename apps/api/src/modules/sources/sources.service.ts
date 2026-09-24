import { Inject, Injectable } from "@nestjs/common";
import type { ObjectStore } from "@budget/workers";
import { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../common/tenant.js";
import { createSource, createUpload, mapUnmatched, queueRun, updateSource } from "./commands/sources.js";
import { listRuns, listSources, listUnmatched, suggestMapping } from "./queries/sources.js";

export const OBJECT_STORE = Symbol("OBJECT_STORE");

@Injectable()
export class SourcesService {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  list(auth: AuthContext) {
    return listSources(this.prisma, auth);
  }
  create(auth: AuthContext, body: unknown) {
    return createSource(this.prisma, auth, body);
  }
  update(auth: AuthContext, id: string, body: unknown) {
    return updateSource(this.prisma, auth, id, body);
  }
  run(auth: AuthContext, id: string) {
    return queueRun(this.prisma, auth, id);
  }
  runs(auth: AuthContext, id: string) {
    return listRuns(this.prisma, auth, id);
  }
  suggestMapping(auth: AuthContext, id: string) {
    return suggestMapping(this.prisma, this.store, auth, id);
  }
  unmatched(auth: AuthContext, limit: string | undefined) {
    return listUnmatched(this.prisma, auth, limit);
  }
  mapUnmatched(auth: AuthContext, body: unknown) {
    return mapUnmatched(this.prisma, auth, body);
  }
  upload(auth: AuthContext, body: unknown) {
    return createUpload(this.store, auth, body);
  }
}
