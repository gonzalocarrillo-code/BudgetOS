import { Inject, Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../common/tenant.js";
import { createMatchRule, deleteMatchRule, rematchWorkspace } from "./commands/match-rules.js";
import { addNamingAlias, createNamingConvention, deleteNamingConvention, saveNamingConvention } from "./commands/naming-conventions.js";
import { suggestNaming } from "./commands/naming-suggest.js";
import { addDictionaryEntry, bulkDictionaryEntries, fillDictionaryWithAi, removeDictionaryEntry, resetDictionary, updateDictionaryEntry } from "./commands/naming-dictionaries.js";
import { getNamingDictionary, listNamingDictionaries } from "./queries/naming-dictionaries.js";
import { analyzeNames, getNamingConvention } from "./queries/naming.js";
import { getMatchCoverage, listMatchRules, previewNamingConvention } from "./queries/match-rules.js";

@Injectable()
export class MatchingService {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  list(auth: AuthContext) {
    return listMatchRules(this.prisma, auth);
  }
  create(auth: AuthContext, body: unknown) {
    return createMatchRule(this.prisma, auth, body);
  }
  remove(auth: AuthContext, id: string) {
    return deleteMatchRule(this.prisma, auth, id);
  }
  rematch(auth: AuthContext) {
    return rematchWorkspace(this.prisma, auth);
  }
  coverage(auth: AuthContext, query: unknown) {
    return getMatchCoverage(this.prisma, auth, query);
  }
  createConvention(auth: AuthContext, body: unknown) {
    return createNamingConvention(this.prisma, auth, body);
  }
  removeConvention(auth: AuthContext, id: string) {
    return deleteNamingConvention(this.prisma, auth, id);
  }
  previewConvention(auth: AuthContext, body: unknown) {
    return previewNamingConvention(this.prisma, auth, body);
  }
  getConvention(auth: AuthContext) {
    return getNamingConvention(this.prisma, auth);
  }
  saveConvention(auth: AuthContext, body: unknown) {
    return saveNamingConvention(this.prisma, auth, body);
  }
  addAlias(auth: AuthContext, body: unknown) {
    return addNamingAlias(this.prisma, auth, body);
  }
  analyzeNames(auth: AuthContext, body: unknown) {
    return analyzeNames(this.prisma, auth, body);
  }
  suggestNaming(auth: AuthContext, body: unknown) {
    return suggestNaming(this.prisma, auth, body);
  }
  listDictionaries(auth: AuthContext) {
    return listNamingDictionaries(this.prisma, auth);
  }
  getDictionary(auth: AuthContext, key: string, query: unknown) {
    return getNamingDictionary(this.prisma, auth, key, query);
  }
  addDictionaryEntry(auth: AuthContext, key: string, body: unknown) {
    return addDictionaryEntry(this.prisma, auth, key, body);
  }
  updateDictionaryEntry(auth: AuthContext, key: string, id: string, body: unknown) {
    return updateDictionaryEntry(this.prisma, auth, key, id, body);
  }
  removeDictionaryEntry(auth: AuthContext, key: string, id: string) {
    return removeDictionaryEntry(this.prisma, auth, key, id);
  }
  bulkDictionary(auth: AuthContext, key: string, body: unknown) {
    return bulkDictionaryEntries(this.prisma, auth, key, body);
  }
  resetDictionary(auth: AuthContext, key: string) {
    return resetDictionary(this.prisma, auth, key);
  }
  fillDictionary(auth: AuthContext, key: string, body: unknown) {
    return fillDictionaryWithAi(this.prisma, auth, key, body);
  }
}
