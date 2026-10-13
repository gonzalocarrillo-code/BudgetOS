import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { Permission } from "../../common/permission.decorator.js";
import { RateLimit } from "../../common/rate-limit.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { AddNamingAliasDto, AnalyzeNamesDto, BulkDictionaryDto, DictionaryEntryDto, FillDictionaryAiDto, UpdateDictionaryEntryDto, CreateMatchRuleDto, CreateNamingConventionDto, NamingConventionPreviewDto, SuggestNamingDto } from "./dto.js";
import { MatchingService } from "./matching.service.js";

/**
 * EX-1 (ADR-0085): match rules and match coverage. Writing a rule needs envelope.edit_draft in the
 * target budget's scope (checked in the service); coverage and the workspace re-match are data
 * operations (source.manage), like the unmatched queue. EX-5 (ADR-0090): naming conventions decide
 * where spend lands across budgets, so writing or previewing one is a data operation too.
 * EX-6 (ADR-0092): the workspace's convention (edited in Registry), "map to…" aliases, "Analyze
 * names" and "Suggest with AI" are data operations as well; reading the convention is not.
 * EX-7 (ADR-0093): the naming dictionaries likewise: reading them needs envelope.read, writing
 * them, resetting them and "Fill dictionary with AI" need source.manage.
 */
@Controller()
export class MatchingController {
  constructor(@Inject(MatchingService) private readonly matching: MatchingService) {}

  @Get("workspaces/:ws/match-rules")
  @Permission("envelope.read")
  list(@Tenant() auth: AuthContext) {
    return this.matching.list(auth);
  }

  @Post("workspaces/:ws/match-rules")
  @Permission("envelope.edit_draft")
  create(@Tenant() auth: AuthContext, @Body() body: CreateMatchRuleDto) {
    return this.matching.create(auth, body);
  }

  @Post("workspaces/:ws/match-rules/rematch")
  @Permission("source.manage")
  rematch(@Tenant() auth: AuthContext) {
    return this.matching.rematch(auth);
  }

  @Delete("match-rules/:id")
  @Permission("envelope.edit_draft")
  remove(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.matching.remove(auth, id);
  }

  @Get("workspaces/:ws/match-coverage")
  @Permission("source.manage")
  coverage(@Tenant() auth: AuthContext, @Query() query: Record<string, string>) {
    return this.matching.coverage(auth, query);
  }

  @Post("workspaces/:ws/naming-conventions")
  @Permission("source.manage")
  createConvention(@Tenant() auth: AuthContext, @Body() body: CreateNamingConventionDto) {
    return this.matching.createConvention(auth, body);
  }

  @Post("workspaces/:ws/naming-conventions/preview")
  @Permission("source.manage")
  previewConvention(@Tenant() auth: AuthContext, @Body() body: NamingConventionPreviewDto) {
    return this.matching.previewConvention(auth, body);
  }

  @Delete("naming-conventions/:id")
  @Permission("source.manage")
  removeConvention(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.matching.removeConvention(auth, id);
  }

  @Get("workspaces/:ws/naming-convention")
  @Permission("envelope.read")
  getConvention(@Tenant() auth: AuthContext) {
    return this.matching.getConvention(auth);
  }

  @Put("workspaces/:ws/naming-convention")
  @Permission("source.manage")
  saveConvention(@Tenant() auth: AuthContext, @Body() body: CreateNamingConventionDto) {
    return this.matching.saveConvention(auth, body);
  }

  @Post("workspaces/:ws/naming-convention/aliases")
  @Permission("source.manage")
  addAlias(@Tenant() auth: AuthContext, @Body() body: AddNamingAliasDto) {
    return this.matching.addAlias(auth, body);
  }

  @Post("workspaces/:ws/naming-conventions/analyze")
  @Permission("source.manage")
  analyzeNames(@Tenant() auth: AuthContext, @Body() body: AnalyzeNamesDto) {
    return this.matching.analyzeNames(auth, body);
  }

  /** Calls OpenAI (via @budget/ai): the stricter 10/min, like the source mapping suggestions. */
  @Post("workspaces/:ws/naming-conventions/suggest")
  @Permission("source.manage")
  @RateLimit("ai-suggest", 10)
  suggestNaming(@Tenant() auth: AuthContext, @Body() body: SuggestNamingDto) {
    return this.matching.suggestNaming(auth, body);
  }

  @Get("workspaces/:ws/naming-dictionaries")
  @Permission("envelope.read")
  listDictionaries(@Tenant() auth: AuthContext) {
    return this.matching.listDictionaries(auth);
  }

  @Get("workspaces/:ws/naming-dictionaries/:dimension")
  @Permission("envelope.read")
  getDictionary(@Tenant() auth: AuthContext, @Param("dimension") dimension: string, @Query() query: Record<string, string>) {
    return this.matching.getDictionary(auth, dimension, query);
  }

  @Post("workspaces/:ws/naming-dictionaries/:dimension/entries")
  @Permission("source.manage")
  addDictionaryEntry(@Tenant() auth: AuthContext, @Param("dimension") dimension: string, @Body() body: DictionaryEntryDto) {
    return this.matching.addDictionaryEntry(auth, dimension, body);
  }

  @Patch("workspaces/:ws/naming-dictionaries/:dimension/entries/:id")
  @Permission("source.manage")
  updateDictionaryEntry(@Tenant() auth: AuthContext, @Param("dimension") dimension: string, @Param("id") id: string, @Body() body: UpdateDictionaryEntryDto) {
    return this.matching.updateDictionaryEntry(auth, dimension, id, body);
  }

  @Delete("workspaces/:ws/naming-dictionaries/:dimension/entries/:id")
  @Permission("source.manage")
  removeDictionaryEntry(@Tenant() auth: AuthContext, @Param("dimension") dimension: string, @Param("id") id: string) {
    return this.matching.removeDictionaryEntry(auth, dimension, id);
  }

  @Post("workspaces/:ws/naming-dictionaries/:dimension/bulk")
  @Permission("source.manage")
  bulkDictionary(@Tenant() auth: AuthContext, @Param("dimension") dimension: string, @Body() body: BulkDictionaryDto) {
    return this.matching.bulkDictionary(auth, dimension, body);
  }

  @Post("workspaces/:ws/naming-dictionaries/:dimension/reset")
  @Permission("source.manage")
  resetDictionary(@Tenant() auth: AuthContext, @Param("dimension") dimension: string) {
    return this.matching.resetDictionary(auth, dimension);
  }

  /** Calls OpenAI (via @budget/ai): the stricter 10/min, like the other AI suggestions. */
  @Post("workspaces/:ws/naming-dictionaries/:dimension/ai-fill")
  @Permission("source.manage")
  @RateLimit("ai-suggest", 10)
  fillDictionary(@Tenant() auth: AuthContext, @Param("dimension") dimension: string, @Body() body: FillDictionaryAiDto) {
    return this.matching.fillDictionary(auth, dimension, body);
  }
}
