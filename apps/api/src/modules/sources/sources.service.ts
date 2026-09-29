import { Inject, Injectable } from "@nestjs/common";
import type { ObjectStore } from "@budget/workers";
import { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../common/tenant.js";
import { createSource, createUpload, mapUnmatched, queueRun, updateSource } from "./commands/sources.js";
import { listRuns, listSources, listUnmatched, suggestMapping, suggestMappingFromSample } from "./queries/sources.js";
import { createMappingProfile, createMappingSynonym, updateMappingProfile, updateMappingSynonym } from "./commands/mapping.js";
import { listMappingProfiles, listMappingSynonyms, matchMappingProfile, previewMapping } from "./queries/mapping.js";

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
  listProfiles(auth: AuthContext, query: { includeArchived?: string }) {
    return listMappingProfiles(this.prisma, auth, query);
  }
  createProfile(auth: AuthContext, body: unknown) {
    return createMappingProfile(this.prisma, auth, body);
  }
  matchProfile(auth: AuthContext, body: unknown) {
    return matchMappingProfile(this.prisma, auth, body);
  }
  updateProfile(auth: AuthContext, id: string, body: unknown) {
    return updateMappingProfile(this.prisma, auth, id, body);
  }
  listSynonyms(auth: AuthContext) {
    return listMappingSynonyms(this.prisma, auth);
  }
  createSynonym(auth: AuthContext, body: unknown) {
    return createMappingSynonym(this.prisma, auth, body);
  }
  updateSynonym(auth: AuthContext, id: string, body: unknown) {
    return updateMappingSynonym(this.prisma, auth, id, body);
  }
  preview(auth: AuthContext, body: unknown) {
    return previewMapping(this.prisma, auth, body);
  }
  create(auth: AuthContext, body: unknown) {
    return createSource(this.prisma, auth, body);
  }
  update(auth: AuthContext, id: string, body: unknown) {
    return updateSource(this.prisma, auth, id, body);
  }
  run(auth: AuthContext, id: string, body: unknown) {
    return queueRun(this.prisma, auth, id, body);
  }
  runs(auth: AuthContext, id: string) {
    return listRuns(this.prisma, auth, id);
  }
  suggestMapping(auth: AuthContext, id: string) {
    return suggestMapping(this.prisma, this.store, auth, id);
  }
  suggestFromSample(auth: AuthContext, body: unknown) {
    return suggestMappingFromSample(this.prisma, auth, body);
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
