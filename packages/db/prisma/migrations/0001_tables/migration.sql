-- Generated from packages/db/prisma/schema.prisma (spec §3.2).
-- Prisma schema blocks are expanded to multiple lines because the schema language does not accept the spec's one-line generator, datasource, and enum blocks.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('VIEWER', 'PLANNER', 'BUDGET_OWNER', 'APPROVER', 'FINANCE', 'DATA_ADMIN', 'WORKSPACE_ADMIN', 'ORG_ADMIN');

-- CreateEnum
CREATE TYPE "DimensionDataType" AS ENUM ('ENUM', 'TEXT', 'REFERENCE', 'DATE_BUCKET');

-- CreateEnum
CREATE TYPE "EnvelopeStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'LOCKED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "VersionStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AmountType" AS ENUM ('BUDGET', 'COMMITTED', 'FORECAST', 'SCENARIO');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'WITHDRAWN', 'ESCALATED');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'SNOOZED', 'RESOLVED');

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reporting_currency" CHAR(3) NOT NULL,
    "fiscal_year_start_month" INTEGER NOT NULL DEFAULT 1,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "google_sub" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_group" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "google_group" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "app_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_group_member" (
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_group_member_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateTable
CREATE TABLE "role_assignment" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "principal_type" TEXT NOT NULL,
    "principal_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dimension" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "data_type" "DimensionDataType" NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'lucide:tag',
    "color" TEXT,
    "allowed_parents" TEXT[],
    "is_required_for_leaf" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dimension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dimension_value" (
    "id" UUID NOT NULL,
    "dimension_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "parent_value_id" UUID,
    "path" ltree NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "external_ids" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "retired_at" TIMESTAMPTZ,
    "merged_into_id" UUID,

    CONSTRAINT "dimension_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hierarchy_template" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT[],
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,

    CONSTRAINT "hierarchy_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "value_constraint" (
    "id" UUID NOT NULL,
    "dimension_id" UUID NOT NULL,
    "when_dimension_key" TEXT NOT NULL,
    "when_value_code" TEXT NOT NULL,
    "allowed_value_codes" TEXT[],

    CONSTRAINT "value_constraint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_period" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,

    CONSTRAINT "fiscal_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "envelope" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "dimension_values" JSONB NOT NULL,
    "period_id" UUID,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "EnvelopeStatus" NOT NULL DEFAULT 'DRAFT',
    "owner_id" UUID,
    "allow_over_allocation" BOOLEAN NOT NULL DEFAULT false,
    "current_version_id" UUID,
    "draft_version_id" UUID,
    "row_version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "envelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "envelope_dimension" (
    "envelope_id" UUID NOT NULL,
    "dimension_id" UUID NOT NULL,
    "value_id" UUID NOT NULL,

    CONSTRAINT "envelope_dimension_pkey" PRIMARY KEY ("envelope_id","dimension_id")
);

-- CreateTable
CREATE TABLE "envelope_version" (
    "id" UUID NOT NULL,
    "envelope_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "amount_type" "AmountType" NOT NULL DEFAULT 'BUDGET',
    "amount" DECIMAL(18,2) NOT NULL,
    "amount_reporting" DECIMAL(18,2) NOT NULL,
    "fx_rate_id" UUID,
    "status" "VersionStatus" NOT NULL DEFAULT 'DRAFT',
    "based_on_version_id" UUID,
    "rationale" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "formula" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ,
    "superseded_at" TIMESTAMPTZ,

    CONSTRAINT "envelope_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "envelope_phasing" (
    "version_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "envelope_phasing_pkey" PRIMARY KEY ("version_id","month")
);

-- CreateTable
CREATE TABLE "envelope_lineage" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "from_envelope_id" UUID NOT NULL,
    "to_envelope_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "version_id" UUID,
    "actor_id" UUID NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "envelope_lineage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rate" (
    "id" UUID NOT NULL,
    "base" CHAR(3) NOT NULL,
    "quote" CHAR(3) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "as_of_date" DATE NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "fx_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_definition" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "numerator" TEXT NOT NULL,
    "denominator" TEXT,
    "direction" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "unit" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "metric_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "target" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "scope_type" TEXT NOT NULL,
    "envelope_id" UUID,
    "scope_filter" JSONB,
    "metric_key" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "owner_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "current_version_id" UUID,
    "draft_version_id" UUID,

    CONSTRAINT "target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "target_version" (
    "id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "value" DECIMAL(18,4) NOT NULL,
    "comparator" TEXT NOT NULL,
    "value_upper" DECIMAL(18,4),
    "currency" CHAR(3),
    "rationale" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" "VersionStatus" NOT NULL DEFAULT 'DRAFT',
    "approval_request_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ,

    CONSTRAINT "target_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_policy" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "conditions" JSONB NOT NULL,
    "chain" JSONB NOT NULL,
    "allow_external_evidence" BOOLEAN NOT NULL DEFAULT false,
    "block_self_approval" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "approval_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_request" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMPTZ,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "approval_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_decision" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "step_index" INTEGER NOT NULL,
    "decided_by" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "evidence" JSONB,
    "channel" TEXT NOT NULL DEFAULT 'app',
    "decided_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pacing_rule" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "metric" TEXT NOT NULL,
    "metric_args" JSONB NOT NULL DEFAULT '{}',
    "comparator" TEXT NOT NULL,
    "threshold" DECIMAL(18,4) NOT NULL,
    "consecutive_days" INTEGER NOT NULL DEFAULT 1,
    "severity" TEXT NOT NULL,
    "delivery" JSONB NOT NULL DEFAULT '{"inApp":true}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pacing_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_state" (
    "rule_id" UUID NOT NULL,
    "envelope_id" UUID NOT NULL,
    "consecutive_days" INTEGER NOT NULL DEFAULT 0,
    "last_eval_date" DATE NOT NULL,
    "last_value" DECIMAL(18,4),

    CONSTRAINT "rule_state_pkey" PRIMARY KEY ("rule_id","envelope_id")
);

-- CreateTable
CREATE TABLE "alert" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "envelope_id" UUID NOT NULL,
    "severity" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "metric_value" DECIMAL(18,4) NOT NULL,
    "threshold" DECIMAL(18,4) NOT NULL,
    "context" JSONB NOT NULL,
    "owner_id" UUID,
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snoozed_until" TIMESTAMPTZ,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thread" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "anchor_type" TEXT NOT NULL,
    "anchor_id" UUID NOT NULL,
    "anchor_meta" JSONB NOT NULL DEFAULT '{}',
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "is_blocking" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "parent_comment_id" UUID,
    "author_id" UUID NOT NULL,
    "body_md" TEXT NOT NULL,
    "mentions" JSONB NOT NULL DEFAULT '[]',
    "references" JSONB NOT NULL DEFAULT '[]',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "edit_history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'label',
    "created_by" UUID NOT NULL,

    CONSTRAINT "tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taggable" (
    "workspace_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "tagged_by" UUID NOT NULL,
    "tagged_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "taggable_pkey" PRIMARY KEY ("tag_id","entity_type","entity_id")
);

-- CreateTable
CREATE TABLE "saved_view" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "screen" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "shared_with" JSONB NOT NULL DEFAULT '[]',
    "created_by" UUID NOT NULL,

    CONSTRAINT "saved_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "period_closure" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'closed',
    "closed_by" UUID NOT NULL,
    "closed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registry_version" JSONB NOT NULL,
    "bq_table" TEXT NOT NULL,
    "variance_summary" JSONB NOT NULL,

    CONSTRAINT "period_closure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_source" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "mapping" JSONB NOT NULL,
    "schedule" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "data_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingest_run" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,
    "status" TEXT NOT NULL DEFAULT 'running',
    "rows_read" INTEGER NOT NULL DEFAULT 0,
    "rows_accepted" INTEGER NOT NULL DEFAULT 0,
    "rows_rejected" INTEGER NOT NULL DEFAULT 0,
    "error_report_uri" TEXT,
    "formula_version" TEXT,

    CONSTRAINT "ingest_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_org_id_slug_key" ON "workspace"("org_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_google_sub_key" ON "app_user"("google_sub");

-- CreateIndex
CREATE UNIQUE INDEX "app_group_org_id_google_group_key" ON "app_group"("org_id", "google_group");

-- CreateIndex
CREATE INDEX "role_assignment_workspace_id_principal_id_idx" ON "role_assignment"("workspace_id", "principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "dimension_org_id_workspace_id_key_key" ON "dimension"("org_id", "workspace_id", "key");

-- CreateIndex
CREATE INDEX "dimension_value_dimension_id_parent_value_id_idx" ON "dimension_value"("dimension_id", "parent_value_id");

-- CreateIndex
CREATE UNIQUE INDEX "dimension_value_dimension_id_code_key" ON "dimension_value"("dimension_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "hierarchy_template_workspace_id_name_key" ON "hierarchy_template"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_period_workspace_id_key_key" ON "fiscal_period"("workspace_id", "key");

-- CreateIndex
CREATE INDEX "envelope_workspace_id_parent_id_idx" ON "envelope"("workspace_id", "parent_id");

-- CreateIndex
CREATE INDEX "envelope_workspace_id_start_date_end_date_idx" ON "envelope"("workspace_id", "start_date", "end_date");

-- CreateIndex
CREATE INDEX "envelope_dimension_dimension_id_value_id_envelope_id_idx" ON "envelope_dimension"("dimension_id", "value_id", "envelope_id");

-- CreateIndex
CREATE INDEX "envelope_version_envelope_id_status_approved_at_idx" ON "envelope_version"("envelope_id", "status", "approved_at");

-- CreateIndex
CREATE UNIQUE INDEX "envelope_version_envelope_id_version_no_key" ON "envelope_version"("envelope_id", "version_no");

-- CreateIndex
CREATE INDEX "envelope_lineage_from_envelope_id_idx" ON "envelope_lineage"("from_envelope_id");

-- CreateIndex
CREATE INDEX "envelope_lineage_to_envelope_id_idx" ON "envelope_lineage"("to_envelope_id");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rate_base_quote_as_of_date_key" ON "fx_rate"("base", "quote", "as_of_date");

-- CreateIndex
CREATE UNIQUE INDEX "metric_definition_org_id_key_key" ON "metric_definition"("org_id", "key");

-- CreateIndex
CREATE INDEX "target_workspace_id_envelope_id_metric_key_idx" ON "target"("workspace_id", "envelope_id", "metric_key");

-- CreateIndex
CREATE UNIQUE INDEX "target_version_target_id_version_no_key" ON "target_version"("target_id", "version_no");

-- CreateIndex
CREATE INDEX "approval_policy_workspace_id_priority_idx" ON "approval_policy"("workspace_id", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "approval_policy_workspace_id_name_key" ON "approval_policy"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "approval_request_workspace_id_status_due_at_idx" ON "approval_request"("workspace_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "approval_request_entity_type_entity_id_idx" ON "approval_request"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "approval_decision_request_id_step_index_idx" ON "approval_decision"("request_id", "step_index");

-- CreateIndex
CREATE INDEX "alert_workspace_id_status_severity_idx" ON "alert"("workspace_id", "status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "alert_rule_id_envelope_id_opened_at_key" ON "alert"("rule_id", "envelope_id", "opened_at");

-- CreateIndex
CREATE INDEX "thread_workspace_id_anchor_type_anchor_id_idx" ON "thread"("workspace_id", "anchor_type", "anchor_id");

-- CreateIndex
CREATE INDEX "comment_thread_id_created_at_idx" ON "comment"("thread_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tag_workspace_id_name_key" ON "tag"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "taggable_entity_type_entity_id_idx" ON "taggable"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "period_closure_workspace_id_period_id_closed_at_key" ON "period_closure"("workspace_id", "period_id", "closed_at");

-- CreateIndex
CREATE INDEX "ingest_run_source_id_started_at_idx" ON "ingest_run"("source_id", "started_at");

-- AddForeignKey
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_group_member" ADD CONSTRAINT "app_group_member_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "app_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dimension_value" ADD CONSTRAINT "dimension_value_dimension_id_fkey" FOREIGN KEY ("dimension_id") REFERENCES "dimension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelope" ADD CONSTRAINT "envelope_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "envelope"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelope_dimension" ADD CONSTRAINT "envelope_dimension_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelope_version" ADD CONSTRAINT "envelope_version_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "envelope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelope_phasing" ADD CONSTRAINT "envelope_phasing_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "envelope_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "target_version" ADD CONSTRAINT "target_version_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "target"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

