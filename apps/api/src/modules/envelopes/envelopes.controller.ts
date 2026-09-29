import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { TimelineParams } from "./queries/timeline.js";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { SubmitVersionDto, WithdrawDto } from "../approvals/dto.js";
import { AddChildDto, BudgetImportCommitDto, BudgetImportDto, BudgetImportTemplateDto, BulkRequestDto, EndEnvelopeDto, ReintroduceDto, FamilyInputDto, MergeEnvelopesDto, StructurePreviewDto, MoveEnvelopeDto, SplitEnvelopeDto, CsvExportDto, CsvImportDto, CreateDraftVersionDto, CreateEnvelopeDto, RestoreVersionDto, UpdateEnvelopeDto, UpdatePhasingDto } from "./dto.js";
import { EnvelopesService } from "./envelopes.service.js";

@Controller()
export class EnvelopesController {
  constructor(@Inject(EnvelopesService) private readonly envelopes: EnvelopesService) {}

  @Post("workspaces/:ws/envelopes")
  @Permission("envelope.create")
  create(@Tenant() auth: AuthContext, @Body() body: CreateEnvelopeDto) {
    return this.envelopes.create(auth, body);
  }

  @Get("envelopes/:id")
  @Permission("envelope.read")
  get(@Tenant() auth: AuthContext, @Param("id") id: string, @Query("as_of") asOf?: string) {
    return this.envelopes.get(auth, id, asOf);
  }

  @Get("envelopes/:id/timeline")
  @Permission("envelope.read")
  timeline(@Tenant() auth: AuthContext, @Param("id") id: string, @Query() params: TimelineParams) {
    return this.envelopes.timeline(auth, id, params);
  }

  /** H-011: spend up to a date, which End proposes as the final amount. */
  @Get("envelopes/:id/spend")
  @Permission("envelope.read")
  spend(@Tenant() auth: AuthContext, @Param("id") id: string, @Query("through") through?: string) {
    return this.envelopes.spend(auth, id, through);
  }

  @Get("envelopes/:id/versions")
  @Permission("envelope.read")
  versions(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.envelopes.versions(auth, id);
  }

  @Patch("envelopes/:id")
  @Permission("envelope.edit_draft")
  update(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateEnvelopeDto) {
    return this.envelopes.update(auth, id, body);
  }

  @Patch("envelopes/:id/draft")
  @Permission("envelope.edit_draft")
  draft(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: CreateDraftVersionDto) {
    return this.envelopes.draft(auth, id, body);
  }

  @Patch("envelopes/:id/phasing")
  @Permission("envelope.edit_draft")
  phasing(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdatePhasingDto) {
    return this.envelopes.phasing(auth, id, body);
  }

  @Post("envelopes/:id/restore/:versionId")
  @Permission("envelope.edit_draft")
  restore(@Tenant() auth: AuthContext, @Param("id") id: string, @Param("versionId") versionId: string, @Body() body: RestoreVersionDto) {
    return this.envelopes.restore(auth, id, versionId, body);
  }

  /** GET /envelopes/:id/family (ADR-039): the parent, its children and how each follows it. */
  @Get("envelopes/:id/family")
  @Permission("envelope.read")
  family(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.envelopes.family(auth, id);
  }

  /** POST /envelopes/:id/family/preview: what a family change does, down the tree; writes nothing. */
  @Post("envelopes/:id/family/preview")
  @Permission("envelope.read")
  familyPreview(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: FamilyInputDto) {
    return this.envelopes.familyPreview(auth, id, body);
  }

  /** POST /envelopes/:id/family: saves how the children follow and opens the amounts as a bulk preview. */
  @Post("envelopes/:id/family")
  @Permission("envelope.edit_draft")
  familySave(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: FamilyInputDto) {
    return this.envelopes.familySave(auth, id, body);
  }

  @Post("envelopes/:id/submit")
  @Permission("envelope.submit")
  submit(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: SubmitVersionDto) {
    return this.envelopes.submit(auth, id, body);
  }

  @Post("envelopes/:id/withdraw")
  @Permission("envelope.submit")
  withdraw(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: WithdrawDto) {
    return this.envelopes.withdraw(auth, id, body);
  }

  /** Re-parent / split / merge (spec §7.5). Literal "merge" is registered before ":id" routes by Fastify's static-first matching. */
  @Post("envelopes/merge")
  @Permission("envelope.move")
  merge(@Tenant() auth: AuthContext, @Body() body: MergeEnvelopesDto) {
    return this.envelopes.merge(auth, body);
  }

  /** T-031b: what an add-child / move / split / merge would do, without doing it (the command runs and is rolled back). */
  @Post("envelopes/structure/preview")
  @Permission("envelope.read")
  previewStructure(@Tenant() auth: AuthContext, @Body() body: StructurePreviewDto) {
    return this.envelopes.previewStructure(auth, body);
  }

  /** T-031b: a child under this envelope in one action (created, then its draft submitted). */
  @Post("envelopes/:id/children")
  @Permission("envelope.create")
  addChild(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: AddChildDto) {
    return this.envelopes.addChild(auth, id, body);
  }

  @Post("envelopes/:id/move")
  @Permission("envelope.move")
  move(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: MoveEnvelopeDto) {
    return this.envelopes.move(auth, id, body);
  }

  @Post("envelopes/:id/split")
  @Permission("envelope.move")
  split(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: SplitEnvelopeDto) {
    return this.envelopes.split(auth, id, body);
  }

  /** D-007: the budget import template, from this workspace's registry (a CSV download). */
  @Get("workspaces/:ws/budget-import/template")
  @Permission("envelope.create")
  async importTemplate(@Tenant() auth: AuthContext, @Query() query: BudgetImportTemplateDto, @Res({ passthrough: true }) reply: { header(name: string, value: string): unknown }) {
    const { filename, csv } = await this.envelopes.importTemplate(auth, query);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${filename}"`);
    return csv;
  }

  /** D-008: a file read into new budgets, parents and changes; nothing is written. */
  @Post("workspaces/:ws/budget-import/preview")
  @Permission("envelope.create")
  importPreview(@Tenant() auth: AuthContext, @Body() body: BudgetImportDto) {
    return this.envelopes.importPreview(auth, body);
  }

  /** D-008: the previewed file, re-checked, as drafts under one approval. */
  @Post("workspaces/:ws/budget-import/commit")
  @Permission("envelope.create")
  importCommit(@Tenant() auth: AuthContext, @Body() body: BudgetImportCommitDto) {
    return this.envelopes.importCommit(auth, body);
  }

  /** H-011: end a budget with its final amount (and optionally its successor), through the approval policy. */
  @Post("envelopes/:id/end")
  @Permission("envelope.move")
  end(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: EndEnvelopeDto) {
    return this.envelopes.end(auth, id, body);
  }

  /** H-012: a successor for an ended budget (lineage `continues`), through the approval policy. */
  @Post("envelopes/:id/reintroduce")
  @Permission("envelope.create")
  reintroduce(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: ReintroduceDto) {
    return this.envelopes.reintroduce(auth, id, body);
  }

  /** Bulk edit (spec §7.4): preview first; nothing changes until commit. */
  @Post("envelopes/bulk")
  @Permission("envelope.bulk")
  bulkPreview(@Tenant() auth: AuthContext, @Body() body: BulkRequestDto) {
    return this.envelopes.bulkPreview(auth, body);
  }

  @Post("envelopes/bulk/:previewId/commit")
  @Permission("envelope.bulk")
  bulkCommit(@Tenant() auth: AuthContext, @Param("previewId") previewId: string) {
    return this.envelopes.bulkCommit(auth, previewId);
  }

  @Post("workspaces/:ws/envelopes/csv-export")
  @Permission("export.run")
  async csvExport(@Tenant() auth: AuthContext, @Body() body: CsvExportDto, @Res({ passthrough: true }) reply: { header(name: string, value: string): unknown }) {
    const csv = await this.envelopes.csvExport(auth, body);
    // Set only on success: a CSV content type on an error would break the JSON error body.
    reply.header("content-type", "text/csv; charset=utf-8");
    return csv;
  }

  @Post("workspaces/:ws/envelopes/csv-import")
  @Permission("envelope.bulk")
  csvImport(@Tenant() auth: AuthContext, @Body() body: CsvImportDto) {
    return this.envelopes.csvImport(auth, body);
  }
}
