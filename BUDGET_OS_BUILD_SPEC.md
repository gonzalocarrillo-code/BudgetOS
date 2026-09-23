# Budget OS — Build Specification (for the coding agent)

**Spec version 0.5 — tracks plan v0.5.** No commercial components (plan §3.9): grid on Glide Data Grid (MIT), timeline on SVAR React Gantt open-source core (MIT), search on Postgres FTS with Meilisearch (MIT) as swap target. Sections 23–27 cover the v0.3–0.5 additions (timeline, naming templates and match keys, experiments, manual result entry, home and tours).

Companion to `BUDGET_OS_MASTER_PLAN.md`. The plan says what and why; this file says exactly how. Code here is the starting point: keep names, signatures and file paths. Section references (§) point to the plan.

---

## 1. Repository layout

```
budget-os/
├─ AGENTS.md
├─ package.json                     # pnpm workspaces + turbo
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json
├─ docker-compose.yml               # postgres:16 + redis:7 for local dev
├─ .github/workflows/ci.yml
├─ infra/                           # Terraform (one module per service)
│  ├─ envs/{dev,staging,prod}/main.tf
│  └─ modules/{project,network,cloudsql,cloudrun_service,cloudrun_job,pubsub,bigquery,secrets,iap}/
├─ docs/
│  ├─ BUDGET_OS_MASTER_PLAN.md
│  ├─ BUDGET_OS_BUILD_SPEC.md
│  └─ adr/0000-template.md
├─ packages/
│  ├─ domain/                       # @budget/domain — zod schemas, types, permission matrix, errors
│  │  └─ src/{index.ts,errors.ts,ids.ts,filter-ast.ts,query.ts,envelopes.ts,targets.ts,approvals.ts,registry.ts,permissions.ts,search.ts,timeline.ts,naming.ts,experiments.ts,manual-entry.ts}
│  ├─ db/                           # @budget/db — Prisma schema, migrations, seed, tenant wrapper, raw SQL types
│  │  ├─ prisma/schema.prisma
│  │  ├─ prisma/migrations/
│  │  ├─ seed/{golden.ts,golden.assertions.ts,defaults.registry.ts,defaults.metrics.ts,defaults.policies.ts,defaults.rules.ts}
│  │  └─ src/{client.ts,tenant.ts,sql.ts,facts.types.ts}
│  ├─ query-planner/                # @budget/query-planner — FilterGroup → SQL
│  │  └─ src/{index.ts,compile-filter.ts,compile-query.ts,measures.ts,planner.test.ts}
│  ├─ ai/                           # @budget/ai — OpenAI client wrapper, prompt registry, logging
│  │  └─ src/{index.ts,client.ts,prompts/{map-columns.ts,summarize-diff.ts}}
│  ├─ ui/                           # @budget/ui — shadcn components themed with design tokens (design team supplies tokens.css)
│  ├─ grid/                         # @budget/grid — Glide Data Grid adapter: server-side row model, tree cell, editors, paste (§18.2)
│  └─ timeline/                     # @budget/timeline — SVAR Gantt core adapter: fiscal scales, lanes, marker overlay, as-of (§23)
├─ apps/
│  ├─ api/                          # NestJS: budget-api
│  │  └─ src/{main.ts,app.module.ts,common/,modules/<module>/{*.module.ts,*.controller.ts,*.service.ts,*.repository.ts,commands/,queries/,dto/}}
│  ├─ web/                          # React 19 + Vite + TanStack Router
│  │  └─ src/{main.tsx,routes/,features/{explorer,timeline,search,approvals,targets,experiments,manual-entry,alerts,threads,registry,home}/,lib/{api.ts,filters.ts,tours.ts}}
│  ├─ mcp/                          # mcp-readonly (Streamable HTTP)
│  │  └─ src/{main.ts,server.ts,tools/*.ts,auth.ts}
│  └─ workers/                      # Cloud Run jobs/services: one entry per worker
│     └─ src/{ingest/,pacing/,rollup/,search-indexer/,notify/,export/}
└─ scripts/{dev-reset.sh,load-test.ts}
```

## 2. Tooling and versions (pin these)

| Tool | Version | Notes |
|---|---|---|
| Node | 22.x LTS | `.nvmrc` = `22` |
| pnpm | 9.x | `packageManager` field in root `package.json` |
| TypeScript | 5.6+ | `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true` |
| Turborepo | 2.x | pipelines: `build`, `lint`, `typecheck`, `test`, `test:acceptance` |
| NestJS | 11.x | `@nestjs/platform-fastify` |
| Prisma | 6.x | provider `postgresql`, `previewFeatures = ["relationJoins"]` |
| PostgreSQL | 16 | extensions: `pgcrypto`, `ltree`, `pg_trgm`, `btree_gin` |
| zod | 3.23+ | single source of validation |
| decimal.js | 10.x | money |
| uuidv7 | 1.x | ids |
| React | 19.x | |
| Vite | 6.x | |
| TanStack Router / Query / Table / Virtual | latest 1.x / 5.x / 8.x / 3.x | |
| Glide Data Grid | `@glideapps/glide-data-grid` 6.x (MIT) | Canvas grid engine; wrapped by `@budget/grid` (§18.2). No paid grid of any kind. |
| SVAR React Gantt (open-source core) | `@svar-ui/react-gantt` 2.x (MIT) | Timeline engine; wrapped by `@budget/timeline` (§23). **Never** install `@svar/*` PRO scope. |
| exceljs | 4.x (MIT) | XLSX export in a Web Worker / export-worker |
| driver.js | 1.x (MIT) | Guided tours (§27) |
| dnd-kit | 6.x (MIT) | Chip builders (naming templates, hierarchy builder) |
| Meilisearch | 1.x (MIT), self-hosted on Cloud Run | Search swap target behind `SearchProvider` (§12); not used in Phase 1 by default |
| license-checker-rseidelsohn | 4.x | `pnpm license-check`; allowlist `MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;0BSD;CC0-1.0;Unlicense` |
| Tailwind | 4.x | tokens from design team |
| cmdk | 1.x | search palette |
| TipTap | 2.x | comments |
| @modelcontextprotocol/sdk | latest 1.x | `StreamableHTTPServerTransport` |
| Vitest / Playwright | 2.x / 1.4x | |
| OpenAI SDK | `openai` 4.x+ | only in `packages/ai` |
| Terraform | 1.9+ | `google` provider 6.x |

Root `package.json` scripts:

```json
{
  "scripts": {
    "dev": "turbo run dev --parallel",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "test:acceptance": "turbo run test:acceptance",
    "db:migrate": "pnpm --filter @budget/db prisma migrate deploy",
    "db:seed": "pnpm --filter @budget/db tsx seed/golden.ts",
    "db:reset": "./scripts/dev-reset.sh",
    "license-check": "license-checker-rseidelsohn --production --onlyAllow \"MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;0BSD;CC0-1.0;Unlicense\" --excludePrivatePackages",
    "bench": "turbo run bench"
  }
}
```

`docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16
    environment: { POSTGRES_USER: budget, POSTGRES_PASSWORD: budget, POSTGRES_DB: budget }
    ports: ["5432:5432"]
    command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements"]
  redis:
    image: redis:7
    ports: ["6379:6379"]
```

---

## 3. Database

### 3.1 Roles

Two Postgres roles. Migrations run as `budget_owner` (table owner). The application connects as `budget_app`, which has `NOBYPASSRLS` and only DML grants. RLS policies check `current_setting('app.workspace_id', true)` and `current_setting('app.user_id', true)`, which `withTenant()` sets per transaction (§7).

```sql
-- migrations/0001_roles/migration.sql
CREATE ROLE budget_app LOGIN NOBYPASSRLS PASSWORD 'replace-in-secret-manager';
GRANT USAGE ON SCHEMA public TO budget_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO budget_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO budget_app;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
```

### 3.2 Prisma schema (Prisma-owned tables)

`packages/db/prisma/schema.prisma`. Facts, search index, outbox and audit are **not** Prisma models (see §3.3); they are created by SQL and accessed through typed raw queries.

```prisma
generator client { provider = "prisma-client-js"; previewFeatures = ["relationJoins"] }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

// ---------- Tenancy & identity ----------
model Organization {
  id         String      @id @db.Uuid
  name       String
  workspaces Workspace[]
  createdAt  DateTime    @default(now()) @map("created_at") @db.Timestamptz
  @@map("organization")
}

model Workspace {
  id                String   @id @db.Uuid
  orgId             String   @map("org_id") @db.Uuid
  org               Organization @relation(fields: [orgId], references: [id])
  slug              String
  name              String
  reportingCurrency String   @map("reporting_currency") @db.Char(3)
  fiscalYearStartMonth Int   @default(1) @map("fiscal_year_start_month")
  settings          Json     @default("{}")
  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz
  @@unique([orgId, slug])
  @@map("workspace")
}

model User {
  id        String   @id @db.Uuid
  orgId     String   @map("org_id") @db.Uuid
  email     String   @unique
  name      String
  googleSub String?  @unique @map("google_sub")
  isActive  Boolean  @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz
  @@map("app_user")
}

model Group {
  id          String @id @db.Uuid
  orgId       String @map("org_id") @db.Uuid
  googleGroup String @map("google_group")   // e.g. latam-media-leads@dept.com
  name        String
  members     GroupMember[]
  @@unique([orgId, googleGroup])
  @@map("app_group")
}

model GroupMember {
  groupId String @map("group_id") @db.Uuid
  userId  String @map("user_id") @db.Uuid
  group   Group  @relation(fields: [groupId], references: [id])
  syncedAt DateTime @default(now()) @map("synced_at") @db.Timestamptz
  @@id([groupId, userId])
  @@map("app_group_member")
}

enum Role { VIEWER PLANNER BUDGET_OWNER APPROVER FINANCE DATA_ADMIN WORKSPACE_ADMIN ORG_ADMIN }

model RoleAssignment {
  id          String   @id @db.Uuid
  workspaceId String?  @map("workspace_id") @db.Uuid   // null => org-wide (ORG_ADMIN only)
  principalType String @map("principal_type")           // 'user' | 'group'
  principalId String   @map("principal_id") @db.Uuid
  role        Role
  scope       Json     @default("{}")                   // FilterGroup or {} = whole workspace
  createdBy   String   @map("created_by") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz
  @@index([workspaceId, principalId])
  @@map("role_assignment")
}

// ---------- Registry (§4.2) ----------
enum DimensionDataType { ENUM TEXT REFERENCE DATE_BUCKET }

model Dimension {
  id                 String   @id @db.Uuid
  orgId              String   @map("org_id") @db.Uuid
  workspaceId        String?  @map("workspace_id") @db.Uuid   // null = org-wide default
  key                String
  label              String
  description        String?
  dataType           DimensionDataType @map("data_type")
  icon               String   @default("lucide:tag")         // 'lucide:<name>' | 'asset:<gcs-object>'
  color              String?
  allowedParents     String[] @map("allowed_parents")         // dimension keys
  isRequiredForLeaf  Boolean  @default(false) @map("is_required_for_leaf")
  sortOrder          Int      @default(0) @map("sort_order")
  isActive           Boolean  @default(true) @map("is_active")
  version            Int      @default(1)
  createdBy          String   @map("created_by") @db.Uuid
  createdAt          DateTime @default(now()) @map("created_at") @db.Timestamptz
  values             DimensionValue[]
  @@unique([orgId, workspaceId, key])
  @@map("dimension")
}

model DimensionValue {
  id            String   @id @db.Uuid
  dimensionId   String   @map("dimension_id") @db.Uuid
  dimension     Dimension @relation(fields: [dimensionId], references: [id])
  code          String
  label         String
  parentValueId String?  @map("parent_value_id") @db.Uuid
  path          Unsupported("ltree")            // set by trigger from parent chain; e.g. 'emea.de'
  aliases       String[] @default([])
  externalIds   Json     @default("{}") @map("external_ids")
  isActive      Boolean  @default(true) @map("is_active")
  retiredAt     DateTime? @map("retired_at") @db.Timestamptz
  mergedIntoId  String?  @map("merged_into_id") @db.Uuid
  @@unique([dimensionId, code])
  @@index([dimensionId, parentValueId])
  @@map("dimension_value")
}

model HierarchyTemplate {
  id          String   @id @db.Uuid
  workspaceId String   @map("workspace_id") @db.Uuid
  name        String
  path        String[]                         // ['client','region','country','platform','objective']
  isDefault   Boolean  @default(false) @map("is_default")
  version     Int      @default(1)
  createdBy   String   @map("created_by") @db.Uuid
  @@unique([workspaceId, name])
  @@map("hierarchy_template")
}

model ValueConstraint {
  id                String @id @db.Uuid
  dimensionId       String @map("dimension_id") @db.Uuid
  whenDimensionKey  String @map("when_dimension_key")
  whenValueCode     String @map("when_value_code")
  allowedValueCodes String[] @map("allowed_value_codes")
  @@map("value_constraint")
}

model FiscalPeriod {
  id          String   @id @db.Uuid
  workspaceId String   @map("workspace_id") @db.Uuid
  key         String                          // '2026-Q4', '2026-11', 'FY26'
  kind        String                          // month | quarter | year | custom
  startDate   DateTime @map("start_date") @db.Date
  endDate     DateTime @map("end_date") @db.Date
  @@unique([workspaceId, key])
  @@map("fiscal_period")
}

// ---------- Envelopes (§4.3) ----------
enum EnvelopeStatus { DRAFT PENDING APPROVED LOCKED ARCHIVED }
enum VersionStatus { DRAFT PENDING APPROVED REJECTED SUPERSEDED WITHDRAWN }
enum AmountType { BUDGET COMMITTED FORECAST SCENARIO }

model Envelope {
  id               String   @id @db.Uuid
  workspaceId      String   @map("workspace_id") @db.Uuid
  parentId         String?  @map("parent_id") @db.Uuid
  parent           Envelope? @relation("EnvelopeTree", fields: [parentId], references: [id])
  children         Envelope[] @relation("EnvelopeTree")
  name             String
  dimensionValues  Json     @map("dimension_values")     // {"country":"BR","platform":"meta"} — denormalised copy
  periodId         String?  @map("period_id") @db.Uuid
  startDate        DateTime @map("start_date") @db.Date
  endDate          DateTime @map("end_date") @db.Date
  currency         String   @db.Char(3)
  status           EnvelopeStatus @default(DRAFT)
  ownerId          String?  @map("owner_id") @db.Uuid
  allowOverAllocation Boolean @default(false) @map("allow_over_allocation")
  currentVersionId String?  @map("current_version_id") @db.Uuid   // latest APPROVED
  draftVersionId   String?  @map("draft_version_id") @db.Uuid     // open draft, if any
  rowVersion       Int      @default(1) @map("row_version")       // optimistic concurrency for metadata edits
  createdBy        String   @map("created_by") @db.Uuid
  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt        DateTime @updatedAt @map("updated_at") @db.Timestamptz
  versions         EnvelopeVersion[]
  dims             EnvelopeDimension[]
  @@index([workspaceId, parentId])
  @@index([workspaceId, startDate, endDate])
  @@map("envelope")
}

model EnvelopeDimension {
  envelopeId  String @map("envelope_id") @db.Uuid
  dimensionId String @map("dimension_id") @db.Uuid
  valueId     String @map("value_id") @db.Uuid
  envelope    Envelope @relation(fields: [envelopeId], references: [id], onDelete: Cascade)
  @@id([envelopeId, dimensionId])
  @@index([dimensionId, valueId, envelopeId])
  @@map("envelope_dimension")
}

model EnvelopeVersion {
  id                  String   @id @db.Uuid
  envelopeId          String   @map("envelope_id") @db.Uuid
  envelope            Envelope @relation(fields: [envelopeId], references: [id])
  versionNo           Int      @map("version_no")
  amountType          AmountType @default(BUDGET) @map("amount_type")
  amount              Decimal  @db.Decimal(18, 2)                    // envelope currency
  amountReporting     Decimal  @map("amount_reporting") @db.Decimal(18, 2)
  fxRateId            String?  @map("fx_rate_id") @db.Uuid
  status              VersionStatus @default(DRAFT)
  basedOnVersionId    String?  @map("based_on_version_id") @db.Uuid
  rationale           String?
  attachments         Json     @default("[]")
  formula             Json?                                          // Phase 2
  createdBy           String   @map("created_by") @db.Uuid
  createdAt           DateTime @default(now()) @map("created_at") @db.Timestamptz
  approvedAt          DateTime? @map("approved_at") @db.Timestamptz
  supersededAt        DateTime? @map("superseded_at") @db.Timestamptz
  phasing             EnvelopePhasing[]
  @@unique([envelopeId, versionNo])
  @@index([envelopeId, status, approvedAt])
  @@map("envelope_version")
}

model EnvelopePhasing {
  versionId String   @map("version_id") @db.Uuid
  version   EnvelopeVersion @relation(fields: [versionId], references: [id], onDelete: Cascade)
  month     DateTime @db.Date                 // first day of month
  amount    Decimal  @db.Decimal(18, 2)
  @@id([versionId, month])
  @@map("envelope_phasing")
}

model EnvelopeLineage {
  id             String   @id @db.Uuid
  workspaceId    String   @map("workspace_id") @db.Uuid
  fromEnvelopeId String   @map("from_envelope_id") @db.Uuid
  toEnvelopeId   String   @map("to_envelope_id") @db.Uuid
  kind           String                        // move | split | merge
  versionId      String?  @map("version_id") @db.Uuid
  actorId        String   @map("actor_id") @db.Uuid
  at             DateTime @default(now()) @db.Timestamptz
  @@index([fromEnvelopeId]) @@index([toEnvelopeId])
  @@map("envelope_lineage")
}

model FxRate {
  id        String   @id @db.Uuid
  base      String   @db.Char(3)
  quote     String   @db.Char(3)
  rate      Decimal  @db.Decimal(18, 8)
  asOfDate  DateTime @map("as_of_date") @db.Date
  source    String
  @@unique([base, quote, asOfDate])
  @@map("fx_rate")
}

// ---------- Targets (§4.8) ----------
model MetricDefinition {
  id          String  @id @db.Uuid
  orgId       String  @map("org_id") @db.Uuid
  key         String                         // budget | cpa | cpl | roas | cpm | cpc | ctr | conversions | revenue | ...
  label       String
  numerator   String                         // 'spend' | 'kpi:<metric>' | 'budget'
  denominator String?                        // null => plain sum
  direction   String                         // lower_is_better | higher_is_better
  format      String                         // currency | number | percent | ratio
  unit        String?
  isActive    Boolean @default(true) @map("is_active")
  @@unique([orgId, key])
  @@map("metric_definition")
}

model Target {
  id               String   @id @db.Uuid
  workspaceId      String   @map("workspace_id") @db.Uuid
  scopeType        String   @map("scope_type")          // envelope | filter
  envelopeId       String?  @map("envelope_id") @db.Uuid
  scopeFilter      Json?    @map("scope_filter")        // FilterGroup
  metricKey        String   @map("metric_key")
  startDate        DateTime @map("start_date") @db.Date
  endDate          DateTime @map("end_date") @db.Date
  ownerId          String?  @map("owner_id") @db.Uuid
  status           String   @default("active")
  currentVersionId String?  @map("current_version_id") @db.Uuid
  draftVersionId   String?  @map("draft_version_id") @db.Uuid
  versions         TargetVersion[]
  @@index([workspaceId, envelopeId, metricKey])
  @@map("target")
}

model TargetVersion {
  id                String   @id @db.Uuid
  targetId          String   @map("target_id") @db.Uuid
  target            Target   @relation(fields: [targetId], references: [id])
  versionNo         Int      @map("version_no")
  value             Decimal  @db.Decimal(18, 4)
  comparator        String                                // lte | gte | eq | between
  valueUpper        Decimal? @map("value_upper") @db.Decimal(18, 4)
  currency          String?  @db.Char(3)
  rationale         String?
  source            String   @default("manual")           // manual | sheet | snowflake | derived
  status            VersionStatus @default(DRAFT)
  approvalRequestId String?  @map("approval_request_id") @db.Uuid
  createdBy         String   @map("created_by") @db.Uuid
  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz
  approvedAt        DateTime? @map("approved_at") @db.Timestamptz
  @@unique([targetId, versionNo])
  @@map("target_version")
}

// ---------- Approvals (§8.1–8.2) ----------
model ApprovalPolicy {
  id          String  @id @db.Uuid
  workspaceId String  @map("workspace_id") @db.Uuid
  name        String
  priority    Int
  conditions  Json                    // see §9.1 of this spec
  chain       Json                    // [{ role, groupId?, minApprovals, timeoutHours, escalateTo? }]
  allowExternalEvidence Boolean @default(false) @map("allow_external_evidence")
  blockSelfApproval     Boolean @default(true) @map("block_self_approval")
  version     Int     @default(1)
  isActive    Boolean @default(true) @map("is_active")
  @@unique([workspaceId, name])
  @@index([workspaceId, priority])
  @@map("approval_policy")
}

enum RequestStatus { PENDING APPROVED REJECTED CHANGES_REQUESTED WITHDRAWN ESCALATED }

model ApprovalRequest {
  id               String   @id @db.Uuid
  workspaceId      String   @map("workspace_id") @db.Uuid
  entityType       String   @map("entity_type")          // envelope_version | target_version | bulk_change
  entityId         String   @map("entity_id") @db.Uuid
  policyId         String   @map("policy_id") @db.Uuid
  policyVersion    Int      @map("policy_version")
  policySnapshot   Json     @map("policy_snapshot")      // frozen copy of chain+conditions
  currentStep      Int      @default(0) @map("current_step")
  status           RequestStatus @default(PENDING)
  summary          String
  requestedBy      String   @map("requested_by") @db.Uuid
  requestedAt      DateTime @default(now()) @map("requested_at") @db.Timestamptz
  dueAt            DateTime? @map("due_at") @db.Timestamptz
  resolvedAt       DateTime? @map("resolved_at") @db.Timestamptz
  decisions        ApprovalDecision[]
  @@index([workspaceId, status, dueAt])
  @@index([entityType, entityId])
  @@map("approval_request")
}

model ApprovalDecision {
  id           String   @id @db.Uuid
  requestId    String   @map("request_id") @db.Uuid
  request      ApprovalRequest @relation(fields: [requestId], references: [id])
  stepIndex    Int      @map("step_index")
  decidedBy    String   @map("decided_by") @db.Uuid
  decision     String                              // approve | reject | request_changes | external_evidence
  comment      String?
  evidence     Json?                               // { gcsUri, sha256, approverName, approvedOn }
  channel      String   @default("app")            // app | slack | email | external_upload
  decidedAt    DateTime @default(now()) @map("decided_at") @db.Timestamptz
  @@index([requestId, stepIndex])
  @@map("approval_decision")
}

// ---------- Pacing (§8.4) ----------
model PacingRule {
  id          String  @id @db.Uuid
  workspaceId String  @map("workspace_id") @db.Uuid
  name        String
  scope       Json    @default("{}")             // FilterGroup
  metric      String                             // pace_index | projected_close_pct | kpi_vs_target_pct | ...
  metricArgs  Json    @default("{}") @map("metric_args")   // e.g. { "metricKey": "cpa" }
  comparator  String                             // gt | gte | lt | lte
  threshold   Decimal @db.Decimal(18, 4)
  consecutiveDays Int @default(1) @map("consecutive_days")
  severity    String                             // info | warning | critical | data
  delivery    Json    @default("{\"inApp\":true}")   // { inApp, slackChannel?, emails? }
  isActive    Boolean @default(true) @map("is_active")
  @@map("pacing_rule")
}

model RuleState {
  ruleId          String   @map("rule_id") @db.Uuid
  envelopeId      String   @map("envelope_id") @db.Uuid
  consecutiveDays Int      @default(0) @map("consecutive_days")
  lastEvalDate    DateTime @map("last_eval_date") @db.Date
  lastValue       Decimal? @map("last_value") @db.Decimal(18, 4)
  @@id([ruleId, envelopeId])
  @@map("rule_state")
}

enum AlertStatus { OPEN ACKNOWLEDGED SNOOZED RESOLVED }

model Alert {
  id           String   @id @db.Uuid
  workspaceId  String   @map("workspace_id") @db.Uuid
  ruleId       String   @map("rule_id") @db.Uuid
  envelopeId   String   @map("envelope_id") @db.Uuid
  severity     String
  status       AlertStatus @default(OPEN)
  metricValue  Decimal  @map("metric_value") @db.Decimal(18, 4)
  threshold    Decimal  @db.Decimal(18, 4)
  context      Json                              // { budget, actual, projected, target?, dataAsOf }
  ownerId      String?  @map("owner_id") @db.Uuid
  openedAt     DateTime @default(now()) @map("opened_at") @db.Timestamptz
  snoozedUntil DateTime? @map("snoozed_until") @db.Timestamptz
  resolvedAt   DateTime? @map("resolved_at") @db.Timestamptz
  @@unique([ruleId, envelopeId, openedAt])
  @@index([workspaceId, status, severity])
  @@map("alert")
}

// ---------- Collaboration (§8.6) ----------
model Thread {
  id          String   @id @db.Uuid
  workspaceId String   @map("workspace_id") @db.Uuid
  anchorType  String   @map("anchor_type")   // envelope | envelope_version | target | approval_request | alert | closure | dimension_value | cell | diff_field
  anchorId    String   @map("anchor_id") @db.Uuid
  anchorMeta  Json     @default("{}") @map("anchor_meta")   // cell: { month }, diff_field: { field }
  title       String?
  status      String   @default("open")      // open | resolved
  isBlocking  Boolean  @default(false) @map("is_blocking")
  createdBy   String   @map("created_by") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz
  resolvedBy  String?  @map("resolved_by") @db.Uuid
  resolvedAt  DateTime? @map("resolved_at") @db.Timestamptz
  comments    Comment[]
  @@index([workspaceId, anchorType, anchorId])
  @@map("thread")
}

model Comment {
  id              String   @id @db.Uuid
  threadId        String   @map("thread_id") @db.Uuid
  thread          Thread   @relation(fields: [threadId], references: [id])
  parentCommentId String?  @map("parent_comment_id") @db.Uuid
  authorId        String   @map("author_id") @db.Uuid
  bodyMd          String   @map("body_md")
  mentions        Json     @default("[]")   // [{ type:'user'|'group', id }]
  references      Json     @default("[]")   // [{ type:'envelope'|'target'|'alert'|'request', id }]
  attachments     Json     @default("[]")
  editHistory     Json     @default("[]") @map("edit_history")
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
  editedAt        DateTime? @map("edited_at") @db.Timestamptz
  deletedAt       DateTime? @map("deleted_at") @db.Timestamptz
  @@index([threadId, createdAt])
  @@map("comment")
}

model Tag {
  id          String @id @db.Uuid
  workspaceId String @map("workspace_id") @db.Uuid
  name        String
  color       String?
  kind        String @default("label")       // label | status | team | custom
  createdBy   String @map("created_by") @db.Uuid
  @@unique([workspaceId, name])
  @@map("tag")
}

model Taggable {
  tagId      String   @map("tag_id") @db.Uuid
  entityType String   @map("entity_type")
  entityId   String   @map("entity_id") @db.Uuid
  taggedBy   String   @map("tagged_by") @db.Uuid
  taggedAt   DateTime @default(now()) @map("tagged_at") @db.Timestamptz
  @@id([tagId, entityType, entityId])
  @@index([entityType, entityId])
  @@map("taggable")
}

model SavedView {
  id          String @id @db.Uuid
  workspaceId String @map("workspace_id") @db.Uuid
  name        String
  screen      String                            // explorer | alerts | approvals | targets | report
  definition  Json                              // { filter, groupBy, measures, period, grain, columns, sort }
  visibility  String @default("private")        // private | shared | workspace_default
  sharedWith  Json   @default("[]") @map("shared_with")
  createdBy   String @map("created_by") @db.Uuid
  @@map("saved_view")
}

// ---------- Closures & ingestion (§4.5, §6.1) ----------
model PeriodClosure {
  id                String   @id @db.Uuid
  workspaceId       String   @map("workspace_id") @db.Uuid
  periodId          String   @map("period_id") @db.Uuid
  status            String   @default("closed")   // closed | restated
  closedBy          String   @map("closed_by") @db.Uuid
  closedAt          DateTime @default(now()) @map("closed_at") @db.Timestamptz
  registryVersion   Json     @map("registry_version")   // { dimensions: {key: version}, templates: {...} }
  bqTable           String   @map("bq_table")
  varianceSummary   Json     @map("variance_summary")
  @@unique([workspaceId, periodId, closedAt])
  @@map("period_closure")
}

model DataSource {
  id          String @id @db.Uuid
  workspaceId String @map("workspace_id") @db.Uuid
  kind        String                            // snowflake | sheets | bigquery | csv
  name        String
  config      Json                              // non-secret config; secretRef points to Secret Manager
  mapping     Json                              // column → dimension/measure mapping
  schedule    String?                           // cron
  isActive    Boolean @default(true) @map("is_active")
  @@map("data_source")
}

model IngestRun {
  id            String   @id @db.Uuid
  sourceId      String   @map("source_id") @db.Uuid
  startedAt     DateTime @default(now()) @map("started_at") @db.Timestamptz
  finishedAt    DateTime? @map("finished_at") @db.Timestamptz
  status        String   @default("running")   // running | ok | failed
  rowsRead      Int      @default(0) @map("rows_read")
  rowsAccepted  Int      @default(0) @map("rows_accepted")
  rowsRejected  Int      @default(0) @map("rows_rejected")
  errorReportUri String? @map("error_report_uri")
  formulaVersion String? @map("formula_version")
  @@index([sourceId, startedAt])
  @@map("ingest_run")
}
```

### 3.3 Hand-written SQL migration (facts, audit, outbox, search, RLS, triggers)

`packages/db/prisma/migrations/0002_platform/migration.sql`. Applied by `prisma migrate deploy` like any other migration.

```sql
-- ===== Facts (partitioned; not Prisma models) =====
CREATE TABLE IF NOT EXISTS spend_fact (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  envelope_id uuid NULL,
  dimension_values jsonb NOT NULL,
  period_date date NOT NULL,
  currency char(3) NOT NULL,
  amount numeric(18,2) NOT NULL,
  amount_reporting numeric(18,2) NOT NULL,
  fx_rate_id uuid NULL,
  source_system text NOT NULL,
  source_run_id uuid NOT NULL,
  source_row_hash text NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, period_date),
  UNIQUE (workspace_id, source_row_hash, period_date)
) PARTITION BY RANGE (period_date);

CREATE TABLE IF NOT EXISTS kpi_fact (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  envelope_id uuid NULL,
  dimension_values jsonb NOT NULL,
  period_date date NOT NULL,
  metric text NOT NULL,                    -- conversions | revenue | impressions | clicks | leads | <custom>
  value numeric(18,4) NOT NULL,
  attribution_model text NULL,
  source_system text NOT NULL,
  source_run_id uuid NOT NULL,
  source_row_hash text NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, period_date),
  UNIQUE (workspace_id, source_row_hash, period_date)
) PARTITION BY RANGE (period_date);

CREATE TABLE IF NOT EXISTS projection_fact (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  envelope_id uuid NULL,
  dimension_values jsonb NOT NULL,
  period_date date NOT NULL,               -- the date the projection is FOR
  metric text NOT NULL DEFAULT 'spend',
  value numeric(18,4) NOT NULL,
  value_reporting numeric(18,4) NULL,
  formula_version text NOT NULL,
  horizon_end date NOT NULL,
  source_system text NOT NULL,
  source_run_id uuid NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, period_date)
) PARTITION BY RANGE (period_date);

-- Partition maintenance: create month partitions 3 months ahead. Called by pacing job daily.
CREATE OR REPLACE FUNCTION ensure_fact_partitions(from_month date, months_ahead int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m date; t text; BEGIN
  FOR i IN 0..months_ahead LOOP
    m := (date_trunc('month', from_month) + (i || ' month')::interval)::date;
    FOREACH t IN ARRAY ARRAY['spend_fact','kpi_fact','projection_fact','audit_event'] LOOP
      EXECUTE format('CREATE TABLE IF NOT EXISTS %I_%s PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        t, to_char(m,'YYYYMM'), t, m, (m + interval '1 month')::date);
    END LOOP;
  END LOOP; END $$;

CREATE INDEX IF NOT EXISTS spend_fact_env_date ON spend_fact (workspace_id, envelope_id, period_date);
CREATE INDEX IF NOT EXISTS spend_fact_unmatched ON spend_fact (workspace_id, period_date) WHERE envelope_id IS NULL;
CREATE INDEX IF NOT EXISTS spend_fact_dims ON spend_fact USING gin (dimension_values);
CREATE INDEX IF NOT EXISTS kpi_fact_env_date ON kpi_fact (workspace_id, envelope_id, metric, period_date);
CREATE INDEX IF NOT EXISTS projection_fact_env_date ON projection_fact (workspace_id, envelope_id, metric, period_date);

-- ===== Audit (partitioned by month on occurred_at) =====
CREATE TABLE IF NOT EXISTS audit_event (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NULL,
  actor_id uuid NULL,
  actor_type text NOT NULL,                -- user | system | mcp
  action text NOT NULL,                    -- envelope.version.created, approval.decided, ...
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  before jsonb NULL,
  after jsonb NULL,
  reason text NULL,
  request_id text NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX IF NOT EXISTS audit_entity ON audit_event (entity_type, entity_id, occurred_at);
CREATE INDEX IF NOT EXISTS audit_ws_time ON audit_event (workspace_id, occurred_at);
-- append-only
CREATE OR REPLACE FUNCTION audit_no_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_event is append-only'; END $$;
DROP TRIGGER IF EXISTS audit_event_immutable ON audit_event;
CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION audit_no_update();

-- ===== Transactional outbox =====
CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY,
  workspace_id uuid NULL,
  topic text NOT NULL,                     -- budget.changed | target.changed | facts.loaded | registry.changed | thread.changed | tag.changed | approval.changed | alert.triggered
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- ===== Roll-up cache (§5.3) =====
CREATE TABLE IF NOT EXISTS rollup_cache (
  workspace_id uuid NOT NULL,
  template_id uuid NOT NULL,
  node_path text NOT NULL,                 -- 'nordwind/latam/br/meta'
  envelope_id uuid NULL,                   -- the envelope this node is (if it exists as one)
  period_start date NOT NULL,
  period_end date NOT NULL,
  measures jsonb NOT NULL,                 -- { budget, actual, projected, leafCount, pendingCount, openAlerts, openThreads }
  data_version bigint NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, template_id, node_path, period_start, period_end)
);

-- ===== Search index (§11.3) =====
CREATE TABLE IF NOT EXISTS search_document (
  workspace_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  title text NOT NULL,
  path text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  dimension_values jsonb NOT NULL DEFAULT '{}',
  numeric_facets jsonb NOT NULL DEFAULT '{}',     -- { budget, actual, cpa, pace_index }
  owner_id uuid NULL,
  status text NULL,
  period_key text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(path,'')), 'B') ||
    setweight(to_tsvector('simple', array_to_string(tags,' ')), 'B') ||
    setweight(to_tsvector('simple', coalesce(body,'')), 'C')
  ) STORED,
  trigram text GENERATED ALWAYS AS (lower(coalesce(title,'') || ' ' || coalesce(path,''))) STORED,
  PRIMARY KEY (workspace_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS search_tsv ON search_document USING gin (tsv);
CREATE INDEX IF NOT EXISTS search_trgm ON search_document USING gin (trigram gin_trgm_ops);
CREATE INDEX IF NOT EXISTS search_dims ON search_document USING gin (dimension_values);
CREATE INDEX IF NOT EXISTS search_type_time ON search_document (workspace_id, entity_type, updated_at DESC);

-- ===== ltree path maintenance for dimension_value =====
CREATE OR REPLACE FUNCTION dimension_value_set_path() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_path ltree; BEGIN
  IF NEW.parent_value_id IS NULL THEN
    NEW.path := text2ltree(regexp_replace(lower(NEW.code), '[^a-z0-9_]', '_', 'g'));
  ELSE
    SELECT path INTO parent_path FROM dimension_value WHERE id = NEW.parent_value_id;
    NEW.path := parent_path || text2ltree(regexp_replace(lower(NEW.code), '[^a-z0-9_]', '_', 'g'));
  END IF;
  RETURN NEW; END $$;
DROP TRIGGER IF EXISTS dimension_value_path ON dimension_value;
CREATE TRIGGER dimension_value_path BEFORE INSERT OR UPDATE OF code, parent_value_id ON dimension_value FOR EACH ROW EXECUTE FUNCTION dimension_value_set_path();
CREATE INDEX IF NOT EXISTS dimension_value_path_gist ON dimension_value USING gist (path);

-- ===== RLS =====
-- Helper: current tenant / user from session settings (set by withTenant)
CREATE OR REPLACE FUNCTION app_workspace_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_is_org_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.is_org_admin', true), 'false')::boolean $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'envelope','envelope_lineage','target','approval_policy','approval_request','pacing_rule','alert',
    'thread','tag','taggable','saved_view','period_closure','data_source','hierarchy_template','fiscal_period',
    'spend_fact','kpi_fact','projection_fact','rollup_cache','search_document','outbox'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_is_org_admin() OR workspace_id = app_workspace_id()) WITH CHECK (app_is_org_admin() OR workspace_id = app_workspace_id())', t);
  END LOOP; END $$;

-- Child tables inherit tenancy through their parent (envelope_version, envelope_phasing, envelope_dimension, target_version, approval_decision, comment, rule_state)
ALTER TABLE envelope_version ENABLE ROW LEVEL SECURITY; ALTER TABLE envelope_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON envelope_version;
CREATE POLICY tenant_isolation ON envelope_version USING (EXISTS (SELECT 1 FROM envelope e WHERE e.id = envelope_id)) WITH CHECK (EXISTS (SELECT 1 FROM envelope e WHERE e.id = envelope_id));
ALTER TABLE envelope_dimension ENABLE ROW LEVEL SECURITY; ALTER TABLE envelope_dimension FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON envelope_dimension;
CREATE POLICY tenant_isolation ON envelope_dimension USING (EXISTS (SELECT 1 FROM envelope e WHERE e.id = envelope_id)) WITH CHECK (EXISTS (SELECT 1 FROM envelope e WHERE e.id = envelope_id));
ALTER TABLE target_version ENABLE ROW LEVEL SECURITY; ALTER TABLE target_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON target_version;
CREATE POLICY tenant_isolation ON target_version USING (EXISTS (SELECT 1 FROM target t WHERE t.id = target_id)) WITH CHECK (EXISTS (SELECT 1 FROM target t WHERE t.id = target_id));
ALTER TABLE approval_decision ENABLE ROW LEVEL SECURITY; ALTER TABLE approval_decision FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON approval_decision;
CREATE POLICY tenant_isolation ON approval_decision USING (EXISTS (SELECT 1 FROM approval_request r WHERE r.id = request_id)) WITH CHECK (EXISTS (SELECT 1 FROM approval_request r WHERE r.id = request_id));
ALTER TABLE comment ENABLE ROW LEVEL SECURITY; ALTER TABLE comment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON comment;
CREATE POLICY tenant_isolation ON comment USING (EXISTS (SELECT 1 FROM thread t WHERE t.id = thread_id)) WITH CHECK (EXISTS (SELECT 1 FROM thread t WHERE t.id = thread_id));

-- audit_event: readable within tenant, insert-only
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_read ON audit_event; DROP POLICY IF EXISTS audit_insert ON audit_event;
CREATE POLICY audit_read ON audit_event FOR SELECT USING (app_is_org_admin() OR workspace_id = app_workspace_id());
CREATE POLICY audit_insert ON audit_event FOR INSERT WITH CHECK (true);

-- Org-wide registry rows (workspace_id NULL) are readable by everyone in the org; workspace rows by their tenant.
ALTER TABLE dimension ENABLE ROW LEVEL SECURITY; ALTER TABLE dimension FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS registry_read ON dimension;
CREATE POLICY registry_read ON dimension USING (workspace_id IS NULL OR workspace_id = app_workspace_id() OR app_is_org_admin())
  WITH CHECK (workspace_id = app_workspace_id() OR app_is_org_admin());

-- Guard: an approved child sum may not exceed the parent's approved amount (belt and braces; the service checks first).
CREATE OR REPLACE FUNCTION check_parent_cap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_amt numeric(18,2); child_sum numeric(18,2); parent_env uuid; allow boolean; BEGIN
  IF NEW.status <> 'APPROVED' THEN RETURN NEW; END IF;
  SELECT e.parent_id INTO parent_env FROM envelope e WHERE e.id = NEW.envelope_id;
  IF parent_env IS NULL THEN RETURN NEW; END IF;
  SELECT p.allow_over_allocation, v.amount_reporting INTO allow, parent_amt
    FROM envelope p LEFT JOIN envelope_version v ON v.id = p.current_version_id WHERE p.id = parent_env;
  IF allow OR parent_amt IS NULL THEN RETURN NEW; END IF;
  SELECT coalesce(sum(cv.amount_reporting),0) INTO child_sum
    FROM envelope c JOIN envelope_version cv ON cv.id = c.current_version_id
    WHERE c.parent_id = parent_env AND c.id <> NEW.envelope_id;
  IF child_sum + NEW.amount_reporting > parent_amt THEN
    RAISE EXCEPTION 'CAP_EXCEEDED: children % + % > parent %', child_sum, NEW.amount_reporting, parent_amt USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW; END $$;
DROP TRIGGER IF EXISTS envelope_version_cap ON envelope_version;
CREATE TRIGGER envelope_version_cap BEFORE INSERT OR UPDATE OF status ON envelope_version FOR EACH ROW EXECUTE FUNCTION check_parent_cap();

SELECT ensure_fact_partitions(current_date, 6);
```

### 3.4 Typed access to non-Prisma tables

`packages/db/src/facts.types.ts`:

```ts
export interface SpendFactRow {
  id: string; workspace_id: string; envelope_id: string | null; dimension_values: Record<string, string>;
  period_date: string; currency: string; amount: string; amount_reporting: string; fx_rate_id: string | null;
  source_system: 'snowflake' | 'sheets' | 'bigquery' | 'csv'; source_run_id: string; source_row_hash: string; loaded_at: string;
}
export interface KpiFactRow extends Omit<SpendFactRow, 'currency' | 'amount' | 'amount_reporting' | 'fx_rate_id'> {
  metric: string; value: string; attribution_model: string | null;
}
export interface AuditEventInput {
  workspaceId: string | null; actorId: string | null; actorType: 'user' | 'system' | 'mcp';
  action: string; entityType: string; entityId: string; before?: unknown; after?: unknown; reason?: string; requestId?: string;
}
export interface OutboxInput { workspaceId: string | null; topic: string; payload: unknown }
```

`packages/db/src/sql.ts` — helpers used by every command:

```ts
import { Prisma, PrismaClient } from '@prisma/client';
import type { AuditEventInput, OutboxInput } from './facts.types';

export type Tx = Prisma.TransactionClient;

export async function audit(tx: Tx, e: AuditEventInput): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit_event (workspace_id, actor_id, actor_type, action, entity_type, entity_id, before, after, reason, request_id)
    VALUES (${e.workspaceId}::uuid, ${e.actorId}::uuid, ${e.actorType}, ${e.action}, ${e.entityType}, ${e.entityId}::uuid,
            ${JSON.stringify(e.before ?? null)}::jsonb, ${JSON.stringify(e.after ?? null)}::jsonb, ${e.reason ?? null}, ${e.requestId ?? null})`;
}

export async function outbox(tx: Tx, o: OutboxInput): Promise<void> {
  await tx.$executeRaw`INSERT INTO outbox (workspace_id, topic, payload) VALUES (${o.workspaceId}::uuid, ${o.topic}, ${JSON.stringify(o.payload)}::jsonb)`;
}

/** Bump the workspace data_version (used by caches). Stored in workspace.settings->>'dataVersion'. */
export async function bumpDataVersion(tx: Tx, workspaceId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ v: number }[]>`
    UPDATE workspace SET settings = jsonb_set(settings, '{dataVersion}', to_jsonb(coalesce((settings->>'dataVersion')::bigint,0)+1))
    WHERE id = ${workspaceId}::uuid RETURNING (settings->>'dataVersion')::int AS v`;
  return rows[0]!.v;
}
```

---

## 4. Tenancy wrapper (every request goes through this)

`packages/db/src/tenant.ts`:

```ts
import { PrismaClient, Prisma } from '@prisma/client';

export interface TenantContext {
  workspaceId: string | null;   // null only for org-admin cross-workspace calls
  userId: string | null;        // null for system workers
  isOrgAdmin: boolean;
  actorType: 'user' | 'system' | 'mcp';
  requestId: string;
}

/**
 * Runs fn inside one transaction with RLS session settings applied.
 * SET LOCAL is transaction-scoped, so settings never leak across pooled connections.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  ctx: TenantContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: { isolation?: Prisma.TransactionIsolationLevel; timeoutMs?: number } = {},
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.workspace_id', $1, true)`, ctx.workspaceId ?? '');
    await tx.$executeRawUnsafe(`SELECT set_config('app.user_id', $1, true)`, ctx.userId ?? '');
    await tx.$executeRawUnsafe(`SELECT set_config('app.is_org_admin', $1, true)`, String(ctx.isOrgAdmin));
    return fn(tx);
  }, { isolationLevel: opts.isolation ?? 'ReadCommitted', timeout: opts.timeoutMs ?? 15_000 });
}
```

NestJS wiring: `apps/api/src/common/tenant.interceptor.ts` builds `TenantContext` from the verified JWT (`sub`, `email`) + `X-Workspace-Id` header, resolves roles via `RoleAssignment` (cached 60 s in Redis), and stores it on `request.tenant`. Services receive `ctx` as the first argument. **No service method takes a Prisma client without a ctx.**

---

## 5. Domain package (`@budget/domain`)

### 5.1 Errors

```ts
// packages/domain/src/errors.ts
export type ErrorCode = 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'VALIDATION' | 'CAP_EXCEEDED' | 'LOCKED' | 'POLICY_NOT_FOUND' | 'RATE_LIMITED';
export class DomainError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: Record<string, unknown>) { super(message); }
}
export const httpStatus: Record<ErrorCode, number> = {
  NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409, VALIDATION: 422, CAP_EXCEEDED: 422, LOCKED: 423, POLICY_NOT_FOUND: 500, RATE_LIMITED: 429,
};
```

### 5.2 Filter AST (§11.2) — the single filter language

```ts
// packages/domain/src/filter-ast.ts
import { z } from 'zod';

export const Comparator = z.enum([
  'eq', 'neq', 'in', 'nin', 'contains', 'starts_with', 'is_empty', 'not_empty',
  'between', 'gt', 'gte', 'lt', 'lte', 'descends_from', 'within',
]);
export type Comparator = z.infer<typeof Comparator>;

export const MeasureKey = z.enum([
  'budget', 'actual', 'projected', 'remaining', 'variance_abs', 'variance_pct', 'pace_index', 'projected_close_pct', 'spend_to_date_pct',
]);
export type MeasureKey = z.infer<typeof MeasureKey>;

export const AttrKey = z.enum([
  'status', 'owner_id', 'approver_id', 'requested_by', 'tag', 'currency', 'source_system', 'has_open_thread',
  'mentions_user', 'commented_by', 'created_at', 'updated_at', 'start_date', 'end_date', 'name', 'has_attachments', 'alert_severity',
]);

export const FieldRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dimension'), key: z.string().min(1) }),
  z.object({ kind: z.literal('measure'), key: MeasureKey }),
  z.object({ kind: z.literal('target'), metric: z.string().min(1), field: z.enum(['value', 'actual', 'vs_target_pct', 'exists']) }),
  z.object({ kind: z.literal('attr'), key: AttrKey }),
]);
export type FieldRef = z.infer<typeof FieldRef>;

/** Relative date spec for `within`: { unit, amount, anchor } e.g. last 30 days = { unit:'day', amount:-30 } */
export const RelativeDate = z.object({
  unit: z.enum(['day', 'week', 'month', 'quarter', 'year']),
  amount: z.number().int(),
  anchor: z.enum(['today', 'period_start', 'period_end']).default('today'),
});

export const Predicate = z.object({
  field: FieldRef,
  op: Comparator,
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()])), z.tuple([z.union([z.string(), z.number()]), z.union([z.string(), z.number()])]), RelativeDate, z.null()]).optional(),
});
export type Predicate = z.infer<typeof Predicate>;

export interface FilterGroupT { logic: 'and' | 'or'; not?: boolean; children: Array<Predicate | FilterGroupT> }
export const FilterGroup: z.ZodType<FilterGroupT> = z.lazy(() =>
  z.object({ logic: z.enum(['and', 'or']), not: z.boolean().optional(), children: z.array(z.union([Predicate, FilterGroup])).max(200) }),
);

export const emptyFilter: FilterGroupT = { logic: 'and', children: [] };
export const isPredicate = (n: Predicate | FilterGroupT): n is Predicate => 'field' in n;
```

### 5.3 Query request/response (§10.2)

```ts
// packages/domain/src/query.ts
import { z } from 'zod';
import { FilterGroup, MeasureKey } from './filter-ast';

export const PeriodSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fiscal'), key: z.string() }),                       // '2026-Q4'
  z.object({ kind: z.literal('range'), start: z.string().date(), end: z.string().date() }),
  z.object({ kind: z.literal('relative'), preset: z.enum(['current_month', 'current_quarter', 'current_year', 'last_30_days', 'last_90_days', 'ytd', 'next_90_days']) }),
]);
export const Grain = z.enum(['total', 'day', 'week', 'month', 'quarter']);

export const QueryRequest = z.object({
  workspaceId: z.string().uuid(),
  filter: FilterGroup.optional(),
  groupBy: z.array(z.string()).max(8).default([]),               // dimension keys; [] => per-envelope rows
  measures: z.array(MeasureKey).min(1).default(['budget', 'actual', 'projected', 'pace_index']),
  targets: z.array(z.string()).default([]),                      // metric keys to include as target/actual columns
  period: PeriodSpec,
  grain: Grain.default('total'),
  asOf: z.string().datetime().optional(),                        // point-in-time for budget
  templateId: z.string().uuid().optional(),                      // when set, returns tree order + depth
  sort: z.array(z.object({ key: z.string(), dir: z.enum(['asc', 'desc']) })).max(3).default([]),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(200),
});
export type QueryRequest = z.infer<typeof QueryRequest>;

export const QueryRow = z.object({
  key: z.string(),                                  // envelope id or group key hash
  envelopeId: z.string().uuid().nullable(),
  depth: z.number().int().optional(),
  path: z.array(z.string()),                        // ['LATAM','Brazil','Meta']
  dimensions: z.record(z.string(), z.string().nullable()),
  measures: z.record(z.string(), z.string().nullable()),   // decimals as strings
  targets: z.record(z.string(), z.object({ target: z.string().nullable(), actual: z.string().nullable(), vsTargetPct: z.string().nullable() })).default({}),
  status: z.string().nullable(),
  pendingCount: z.number().int().default(0),
  openAlerts: z.number().int().default(0),
  openThreads: z.number().int().default(0),
});
export const QueryResponse = z.object({
  rows: z.array(QueryRow), nextCursor: z.string().nullable(), totals: z.record(z.string(), z.string().nullable()),
  dataAsOf: z.string().datetime(), dataVersion: z.number().int(), elapsedMs: z.number(),
});
export type QueryResponse = z.infer<typeof QueryResponse>;
```

### 5.4 Permission matrix (§7)

```ts
// packages/domain/src/permissions.ts
export type Role = 'VIEWER' | 'PLANNER' | 'BUDGET_OWNER' | 'APPROVER' | 'FINANCE' | 'DATA_ADMIN' | 'WORKSPACE_ADMIN' | 'ORG_ADMIN';
export type Action =
  | 'envelope.read' | 'envelope.create' | 'envelope.edit_draft' | 'envelope.submit' | 'envelope.move' | 'envelope.bulk'
  | 'target.read' | 'target.edit_draft' | 'target.submit'
  | 'approval.decide' | 'approval.force'
  | 'registry.manage' | 'policy.manage' | 'rule.manage' | 'tag.create' | 'tag.apply'
  | 'thread.comment' | 'thread.resolve'
  | 'closure.close' | 'closure.restate'
  | 'source.manage' | 'export.run' | 'view.share_workspace' | 'user.manage';

const ALL: Action[] = [
  'envelope.read','envelope.create','envelope.edit_draft','envelope.submit','envelope.move','envelope.bulk','target.read','target.edit_draft','target.submit',
  'approval.decide','approval.force','registry.manage','policy.manage','rule.manage','tag.create','tag.apply','thread.comment','thread.resolve',
  'closure.close','closure.restate','source.manage','export.run','view.share_workspace','user.manage',
];
const READ: Action[] = ['envelope.read', 'target.read', 'export.run', 'tag.apply', 'thread.comment'];
const PLAN: Action[] = [...READ, 'envelope.create', 'envelope.edit_draft', 'envelope.submit', 'envelope.move', 'envelope.bulk', 'target.edit_draft', 'target.submit', 'thread.resolve'];

export const permissions: Record<Role, ReadonlySet<Action>> = {
  VIEWER: new Set(READ),
  PLANNER: new Set(PLAN),
  BUDGET_OWNER: new Set([...PLAN, 'approval.decide', 'rule.manage']),
  APPROVER: new Set([...READ, 'approval.decide', 'thread.resolve']),
  FINANCE: new Set([...READ, 'approval.decide', 'closure.close', 'thread.resolve']),
  DATA_ADMIN: new Set([...READ, 'source.manage']),
  WORKSPACE_ADMIN: new Set(ALL.filter(a => a !== 'approval.force')),
  ORG_ADMIN: new Set(ALL),
};

export function can(roles: Role[], action: Action): boolean {
  return roles.some(r => permissions[r].has(action));
}
```

Scope check (dimension-scoped roles): `RoleAssignment.scope` is a `FilterGroup`. `apps/api/src/common/scope.guard.ts` evaluates it against the target envelope's `dimensionValues` with `matchesScope(scope, dimensionValues)` (pure function in `packages/domain/src/permissions.ts`, supports `eq/in/descends_from` on dimensions only). Approver eligibility for a step = has the step's role **and** scope matches **and** (`blockSelfApproval` ⇒ not the version author).

---

## 6. Query planner (`@budget/query-planner`)

Compiles `QueryRequest` to one parameterised SQL statement. Uses a tiny builder to keep parameters positional.

```ts
// packages/query-planner/src/sql-builder.ts
export class SqlBuilder {
  private params: unknown[] = [];
  p(v: unknown): string { this.params.push(v); return `$${this.params.length}`; }
  get values(): unknown[] { return this.params; }
}
```

### 6.1 Compiling predicates

```ts
// packages/query-planner/src/compile-filter.ts
import { FilterGroupT, Predicate, isPredicate } from '@budget/domain';
import { SqlBuilder } from './sql-builder';

/** Returns a SQL boolean expression over alias `e` (envelope) and `m` (per-envelope measures CTE). */
export function compileFilter(g: FilterGroupT, b: SqlBuilder, ctx: CompileCtx): string {
  if (g.children.length === 0) return 'TRUE';
  const parts = g.children.map(c => (isPredicate(c) ? compilePredicate(c, b, ctx) : compileFilter(c, b, ctx)));
  const joined = parts.map(p => `(${p})`).join(g.logic === 'and' ? ' AND ' : ' OR ');
  return g.not ? `NOT (${joined})` : joined;
}

export interface CompileCtx { workspaceId: string; periodStart: string; periodEnd: string; today: string }

function compilePredicate(p: Predicate, b: SqlBuilder, ctx: CompileCtx): string {
  switch (p.field.kind) {
    case 'dimension': return compileDimension(p.field.key, p, b, ctx);
    case 'measure':   return compileScalar(`m.${p.field.key}`, p, b);
    case 'target':    return compileTarget(p, b);
    case 'attr':      return compileAttr(p, b, ctx);
  }
}

function compileDimension(key: string, p: Predicate, b: SqlBuilder, ctx: CompileCtx): string {
  const dimSub = `SELECT d.id FROM dimension d WHERE d.key = ${b.p(key)} AND (d.workspace_id = ${b.p(ctx.workspaceId)}::uuid OR d.workspace_id IS NULL) ORDER BY d.workspace_id NULLS LAST LIMIT 1`;
  const base = `EXISTS (SELECT 1 FROM envelope_dimension ed JOIN dimension_value dv ON dv.id = ed.value_id WHERE ed.envelope_id = e.id AND ed.dimension_id = (${dimSub})`;
  switch (p.op) {
    case 'eq':        return `${base} AND dv.code = ${b.p(p.value)})`;
    case 'neq':       return `NOT (${base} AND dv.code = ${b.p(p.value)}))`;
    case 'in':        return `${base} AND dv.code = ANY(${b.p(p.value)}::text[]))`;
    case 'nin':       return `NOT (${base} AND dv.code = ANY(${b.p(p.value)}::text[])))`;
    case 'contains':  return `${base} AND dv.label ILIKE ${b.p('%' + String(p.value) + '%')})`;
    case 'starts_with': return `${base} AND dv.label ILIKE ${b.p(String(p.value) + '%')})`;
    case 'is_empty':  return `NOT (${base})`;
    case 'not_empty': return `${base})`;
    case 'descends_from':
      // ancestor code → all values whose ltree path is under it
      return `${base} AND dv.path <@ (SELECT path FROM dimension_value x WHERE x.dimension_id = dv.dimension_id AND x.code = ${b.p(p.value)}))`;
    default: throw new Error(`op ${p.op} not valid for dimension`);
  }
}

function compileScalar(col: string, p: Predicate, b: SqlBuilder): string {
  switch (p.op) {
    case 'eq': return `${col} = ${b.p(p.value)}`;
    case 'neq': return `${col} <> ${b.p(p.value)}`;
    case 'gt': return `${col} > ${b.p(p.value)}`;
    case 'gte': return `${col} >= ${b.p(p.value)}`;
    case 'lt': return `${col} < ${b.p(p.value)}`;
    case 'lte': return `${col} <= ${b.p(p.value)}`;
    case 'between': { const [lo, hi] = p.value as [number, number]; return `${col} BETWEEN ${b.p(lo)} AND ${b.p(hi)}`; }
    case 'is_empty': return `${col} IS NULL`;
    case 'not_empty': return `${col} IS NOT NULL`;
    case 'in': return `${col} = ANY(${b.p(p.value)})`;
    default: throw new Error(`op ${p.op} not valid for scalar`);
  }
}

function compileTarget(p: Predicate, b: SqlBuilder): string {
  if (p.field.kind !== 'target') throw new Error('unreachable');
  const t = `(SELECT tv.value FROM target t JOIN target_version tv ON tv.id = t.current_version_id
              WHERE t.envelope_id = e.id AND t.metric_key = ${b.p(p.field.metric)} LIMIT 1)`;
  switch (p.field.field) {
    case 'exists': return p.op === 'is_empty' ? `${t} IS NULL` : `${t} IS NOT NULL`;
    case 'value': return compileScalar(t, p, b);
    case 'actual': return compileScalar(`m.kpi_${sanitize(p.field.metric)}`, p, b);
    case 'vs_target_pct': return compileScalar(`(m.kpi_${sanitize(p.field.metric)} / NULLIF(${t},0))`, p, b);
  }
}

function compileAttr(p: Predicate, b: SqlBuilder, ctx: CompileCtx): string {
  if (p.field.kind !== 'attr') throw new Error('unreachable');
  switch (p.field.key) {
    case 'status': return compileScalar(`e.status::text`, p, b);
    case 'owner_id': return p.value === '@me' ? `e.owner_id = app_user_id()` : compileScalar(`e.owner_id::text`, p, b);
    case 'currency': return compileScalar(`e.currency`, p, b);
    case 'name': return p.op === 'contains' ? `e.name ILIKE ${b.p('%' + String(p.value) + '%')}` : compileScalar('e.name', p, b);
    case 'tag':
      return `EXISTS (SELECT 1 FROM taggable tg JOIN tag t ON t.id = tg.tag_id WHERE tg.entity_type='envelope' AND tg.entity_id = e.id AND t.name ${p.op === 'in' ? `= ANY(${b.p(p.value)}::text[])` : `= ${b.p(p.value)}`})`;
    case 'has_open_thread':
      return `${p.value === false ? 'NOT ' : ''}EXISTS (SELECT 1 FROM thread th WHERE th.anchor_type='envelope' AND th.anchor_id = e.id AND th.status='open')`;
    case 'mentions_user':
      return `EXISTS (SELECT 1 FROM thread th JOIN comment c ON c.thread_id = th.id WHERE th.anchor_type='envelope' AND th.anchor_id = e.id AND c.mentions @> ${b.p(JSON.stringify([{ type: 'user', id: p.value === '@me' ? '__ME__' : p.value }]))}::jsonb)`
        .replace('"__ME__"', `' || app_user_id()::text || '`); // resolved at runtime via app_user_id()
    case 'approver_id':
      return `EXISTS (SELECT 1 FROM approval_request r WHERE r.entity_type='envelope_version' AND r.status='PENDING'
                AND r.entity_id IN (SELECT id FROM envelope_version WHERE envelope_id = e.id)
                AND eligible_approver(r.id, ${p.value === '@me' ? 'app_user_id()' : b.p(p.value) + '::uuid'}))`;
    case 'alert_severity':
      return `EXISTS (SELECT 1 FROM alert a WHERE a.envelope_id = e.id AND a.status IN ('OPEN','ACKNOWLEDGED') AND a.severity = ${b.p(p.value)})`;
    case 'created_at': case 'updated_at': case 'start_date': case 'end_date':
      return compileDate(`e.${p.field.key}`, p, b, ctx);
    default: throw new Error(`attr ${p.field.key} not supported`);
  }
}

function compileDate(col: string, p: Predicate, b: SqlBuilder, ctx: CompileCtx): string {
  if (p.op === 'within') {
    const r = p.value as { unit: string; amount: number; anchor: string };
    const anchor = r.anchor === 'period_start' ? b.p(ctx.periodStart) : r.anchor === 'period_end' ? b.p(ctx.periodEnd) : b.p(ctx.today);
    const lo = r.amount < 0 ? `${anchor}::date + (${b.p(r.amount)} || ' ${r.unit}')::interval` : `${anchor}::date`;
    const hi = r.amount < 0 ? `${anchor}::date` : `${anchor}::date + (${b.p(r.amount)} || ' ${r.unit}')::interval`;
    return `${col} BETWEEN ${lo} AND ${hi}`;
  }
  return compileScalar(col, p, b);
}

export const sanitize = (s: string) => s.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
```

`eligible_approver(request_id, user_id)` is a SQL function created in migration `0003_functions` that checks the current step's role against `role_assignment` (+ group membership) and the policy snapshot's `blockSelfApproval`. Implement it in SQL so the same logic serves the inbox query and the filter.

### 6.2 Compiling the whole query

```ts
// packages/query-planner/src/compile-query.ts
import { QueryRequest } from '@budget/domain';
import { SqlBuilder } from './sql-builder';
import { compileFilter, CompileCtx, sanitize } from './compile-filter';

export interface CompiledQuery { sql: string; values: unknown[]; }

export function compileQuery(q: QueryRequest, period: { start: string; end: string }, today: string): CompiledQuery {
  const b = new SqlBuilder();
  const ctx: CompileCtx = { workspaceId: q.workspaceId, periodStart: period.start, periodEnd: period.end, today };
  const asOf = q.asOf ? b.p(q.asOf) : 'now()';
  const ws = b.p(q.workspaceId);
  const pStart = b.p(period.start), pEnd = b.p(period.end);
  const elapsedFrac = `LEAST(1, GREATEST(0, (${b.p(today)}::date - ${pStart}::date + 1)::numeric / NULLIF((${pEnd}::date - ${pStart}::date + 1),0)))`;

  // KPI columns requested via targets[] → kpi_<metric> per envelope (derived metrics computed from spend & kpi facts)
  const kpiCols = q.targets.map(mk => `, (${derivedMetricSql(mk, b, pStart, pEnd)}) AS kpi_${sanitize(mk)}`).join('');

  const measuresCte = `
    m AS (
      SELECT e.id AS envelope_id,
        (SELECT v.amount_reporting FROM envelope_version v WHERE v.envelope_id = e.id AND v.status='APPROVED' AND v.approved_at <= ${asOf}
           ORDER BY v.approved_at DESC LIMIT 1) AS budget,
        (SELECT coalesce(sum(sf.amount_reporting),0) FROM spend_fact sf WHERE sf.envelope_id = e.id AND sf.period_date BETWEEN ${pStart} AND ${pEnd}) AS actual,
        (SELECT coalesce(sum(pf.value_reporting),0) FROM projection_fact pf WHERE pf.envelope_id = e.id AND pf.metric='spend'
           AND pf.period_date BETWEEN ${pStart} AND ${pEnd}
           AND pf.source_run_id = (SELECT source_run_id FROM projection_fact x WHERE x.envelope_id = e.id ORDER BY loaded_at DESC LIMIT 1)) AS projected
        ${kpiCols}
      FROM envelope e WHERE e.workspace_id = ${ws}::uuid
        AND e.start_date <= ${pEnd} AND e.end_date >= ${pStart}
    ),
    m2 AS (
      SELECT *, (budget - actual) AS remaining,
        (projected - budget) AS variance_abs,
        CASE WHEN budget > 0 THEN (projected - budget) / budget ELSE NULL END AS variance_pct,
        CASE WHEN budget > 0 THEN actual / budget ELSE NULL END AS spend_to_date_pct,
        CASE WHEN budget > 0 AND ${elapsedFrac} > 0 THEN (actual / budget) / ${elapsedFrac} ELSE NULL END AS pace_index,
        CASE WHEN budget > 0 THEN projected / budget ELSE NULL END AS projected_close_pct
      FROM m
    )`;

  const where = compileFilter(q.filter ?? { logic: 'and', children: [] }, b, ctx);

  // group-by dimension codes as lateral joins
  const dimJoins = q.groupBy.map((k, i) => `
    LEFT JOIN LATERAL (
      SELECT dv.code, dv.label FROM envelope_dimension ed JOIN dimension_value dv ON dv.id = ed.value_id JOIN dimension d ON d.id = ed.dimension_id
      WHERE ed.envelope_id = e.id AND d.key = ${b.p(k)} LIMIT 1) g${i} ON TRUE`).join('');
  const dimSelect = q.groupBy.map((k, i) => `g${i}.code AS dim_${sanitize(k)}, g${i}.label AS lbl_${sanitize(k)}`).join(', ');
  const measureAgg = q.measures.map(mk => {
    if (mk === 'pace_index' || mk === 'variance_pct' || mk === 'projected_close_pct' || mk === 'spend_to_date_pct') {
      // ratio measures are recomputed from sums, never averaged
      return `CASE WHEN sum(m.budget) > 0 THEN ${ratioExpr(mk, elapsedFrac)} ELSE NULL END AS ${mk}`;
    }
    return `sum(m.${mk}) AS ${mk}`;
  }).join(', ');

  const groupSql = q.groupBy.length
    ? `SELECT ${dimSelect}, ${measureAgg}, count(*) AS leaf_count,
         sum(CASE WHEN e.status='PENDING' THEN 1 ELSE 0 END) AS pending_count
       FROM envelope e JOIN m2 m ON m.envelope_id = e.id ${dimJoins}
       WHERE ${where}
       GROUP BY ${q.groupBy.map((_, i) => `g${i}.code, g${i}.label`).join(', ')}`
    : `SELECT e.id AS envelope_id, e.name, e.status::text AS status, e.parent_id, e.dimension_values, ${q.measures.map(mk => `m.${mk}`).join(', ')}
         ${q.targets.map(mk => `, m.kpi_${sanitize(mk)}`).join('')},
         (SELECT count(*) FROM alert a WHERE a.envelope_id = e.id AND a.status IN ('OPEN','ACKNOWLEDGED')) AS open_alerts,
         (SELECT count(*) FROM thread t WHERE t.anchor_type='envelope' AND t.anchor_id = e.id AND t.status='open') AS open_threads
       FROM envelope e JOIN m2 m ON m.envelope_id = e.id
       WHERE ${where}`;

  const order = q.sort.length ? `ORDER BY ${q.sort.map(s => `${sanitizeSortKey(s.key)} ${s.dir.toUpperCase()} NULLS LAST`).join(', ')}` : q.groupBy.length ? '' : 'ORDER BY e.name';
  const offset = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString()) : 0;
  const sql = `WITH ${measuresCte} ${groupSql} ${order} LIMIT ${b.p(q.limit + 1)} OFFSET ${b.p(offset)}`;
  return { sql, values: b.values };
}

function ratioExpr(mk: string, elapsedFrac: string): string {
  switch (mk) {
    case 'pace_index': return `(sum(m.actual)/sum(m.budget)) / NULLIF(${elapsedFrac},0)`;
    case 'variance_pct': return `(sum(m.projected)-sum(m.budget))/sum(m.budget)`;
    case 'projected_close_pct': return `sum(m.projected)/sum(m.budget)`;
    case 'spend_to_date_pct': return `sum(m.actual)/sum(m.budget)`;
    default: throw new Error(mk);
  }
}

/** Derived metric over facts for one envelope alias e. Reads metric_definition at planning time (cached). */
export function derivedMetricSql(metricKey: string, b: SqlBuilder, pStart: string, pEnd: string): string {
  const def = metricRegistry.get(metricKey); // loaded by the planner service from metric_definition
  if (!def) throw new Error(`unknown metric ${metricKey}`);
  const src = (ref: string) => ref === 'spend'
    ? `(SELECT coalesce(sum(amount_reporting),0) FROM spend_fact WHERE envelope_id = e.id AND period_date BETWEEN ${pStart} AND ${pEnd})`
    : `(SELECT coalesce(sum(value),0) FROM kpi_fact WHERE envelope_id = e.id AND metric = ${b.p(ref.replace('kpi:', ''))} AND period_date BETWEEN ${pStart} AND ${pEnd})`;
  return def.denominator ? `${src(def.numerator)} / NULLIF(${src(def.denominator)},0)` : src(def.numerator);
}

export const metricRegistry = new Map<string, { numerator: string; denominator: string | null }>();
const sanitizeSortKey = (k: string) => k.replace(/[^a-z0-9_.]/gi, '');
```

**Routing rule:** `QueryPlannerService.run(ctx, q)` estimates rows (`EXPLAIN (FORMAT JSON)`), and if `period` spans > 13 months or estimate > 200k rows, executes the same SQL shape against BigQuery via `@google-cloud/bigquery` using the Datastream replica (`budget_os_<env>.envelope`, `spend_fact`…); BigQuery SQL differences (`ANY` → `IN UNNEST`, `ltree` → path string `STARTS_WITH`) are handled in `compile-query.bq.ts`. Results cached in Redis: key `q:${workspaceId}:${dataVersion}:${sha256(JSON.stringify(q))}:${userScopeHash}`, TTL 5 min.

### 6.3 Planner tests (must exist before any UI work)

`packages/query-planner/src/planner.test.ts` covers, against the golden dataset: every `Comparator` on every `FieldRef.kind`; `descends_from` on nested values; `within` relative dates for each anchor; `asOf` returning the approved amount at three timestamps; ratio measures equal recomputed sums (property-based with fast-check: sum of leaves == group total for `budget`, `actual`, `projected`); pagination cursor stability under concurrent inserts.

---

## 7. Envelope commands (§4.3, §9.3)

All commands live in `apps/api/src/modules/envelopes/commands/`. Each: validates with zod, runs in `withTenant`, checks `can()` + scope, mutates, writes `audit` + `outbox`, bumps `dataVersion`.

### 7.1 Create draft version (inline edit)

```ts
// apps/api/src/modules/envelopes/commands/create-draft-version.ts
import { z } from 'zod';
import Decimal from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { DomainError, can } from '@budget/domain';
import { withTenant, audit, outbox, bumpDataVersion, type TenantContext } from '@budget/db';
import type { PrismaClient } from '@prisma/client';

export const CreateDraftVersionInput = z.object({
  envelopeId: z.string().uuid(),
  amount: z.string().regex(/^-?\d+(\.\d{1,2})?$/),      // decimal string in envelope currency
  rationale: z.string().max(4000).optional(),
  phasing: z.array(z.object({ month: z.string().date(), amount: z.string() })).optional(),
  basedOnVersionId: z.string().uuid().nullable(),        // optimistic concurrency: the version the client saw
  attachments: z.array(z.object({ gcsUri: z.string(), name: z.string(), sha256: z.string() })).default([]),
});
export type CreateDraftVersionInput = z.infer<typeof CreateDraftVersionInput>;

export async function createDraftVersion(prisma: PrismaClient, ctx: TenantContext, roles: Role[], raw: unknown) {
  const input = CreateDraftVersionInput.parse(raw);
  if (!can(roles, 'envelope.edit_draft')) throw new DomainError('FORBIDDEN', 'Cannot edit drafts');

  return withTenant(prisma, ctx, async (tx) => {
    // Lock the envelope row for the duration of the edit
    const [env] = await tx.$queryRaw<Array<{ id: string; status: string; currency: string; draft_version_id: string | null; current_version_id: string | null; workspace_id: string; dimension_values: Record<string,string> }>>`
      SELECT id, status::text, currency, draft_version_id, current_version_id, workspace_id, dimension_values FROM envelope WHERE id = ${input.envelopeId}::uuid FOR UPDATE`;
    if (!env) throw new DomainError('NOT_FOUND', 'Envelope not found');
    if (env.status === 'LOCKED') throw new DomainError('LOCKED', 'Period is closed; restate via closure');

    // Conflict: someone changed what the client based its edit on
    const head = env.draft_version_id ?? env.current_version_id;
    if ((input.basedOnVersionId ?? null) !== head) {
      throw new DomainError('CONFLICT', 'Envelope changed since you loaded it', { currentVersionId: head });
    }

    const lastNo = await tx.envelopeVersion.aggregate({ where: { envelopeId: env.id }, _max: { versionNo: true } });
    const versionNo = (lastNo._max.versionNo ?? 0) + 1;
    const fx = await resolveFx(tx, env.currency, ctx.workspaceId!);  // returns { id, rate } — 1.0 if same currency
    const amount = new Decimal(input.amount);
    const amountReporting = amount.mul(fx.rate).toDecimalPlaces(2);

    // Phasing must sum to amount when provided
    if (input.phasing) {
      const sum = input.phasing.reduce((s, p) => s.plus(p.amount), new Decimal(0));
      if (!sum.equals(amount)) throw new DomainError('VALIDATION', 'Phasing must sum to amount', { sum: sum.toString() });
    }

    const version = await tx.envelopeVersion.create({
      data: {
        id: uuidv7(), envelopeId: env.id, versionNo, amount: amount.toString(), amountReporting: amountReporting.toString(),
        fxRateId: fx.id, status: 'DRAFT', basedOnVersionId: env.current_version_id, rationale: input.rationale, attachments: input.attachments,
        createdBy: ctx.userId!,
        phasing: input.phasing ? { create: input.phasing.map(p => ({ month: new Date(p.month), amount: p.amount })) } : undefined,
      },
    });

    // Supersede previous open draft (never delete)
    if (env.draft_version_id) {
      await tx.envelopeVersion.update({ where: { id: env.draft_version_id }, data: { status: 'SUPERSEDED', supersededAt: new Date() } });
    }
    await tx.envelope.update({ where: { id: env.id }, data: { draftVersionId: version.id, status: env.status === 'APPROVED' ? 'APPROVED' : 'DRAFT', rowVersion: { increment: 1 } } });

    await audit(tx, { workspaceId: env.workspace_id, actorId: ctx.userId, actorType: ctx.actorType, action: 'envelope.version.created', entityType: 'envelope', entityId: env.id,
      before: { versionId: env.draft_version_id }, after: { versionId: version.id, amount: amount.toString(), versionNo }, reason: input.rationale, requestId: ctx.requestId });
    await outbox(tx, { workspaceId: env.workspace_id, topic: 'budget.changed', payload: { envelopeId: env.id, versionId: version.id, kind: 'draft' } });
    await bumpDataVersion(tx, env.workspace_id);
    return version;
  });
}
```

### 7.2 Submit for approval

```ts
// apps/api/src/modules/envelopes/commands/submit-version.ts
export async function submitVersion(prisma: PrismaClient, ctx: TenantContext, roles: Role[], input: { versionId: string }) {
  if (!can(roles, 'envelope.submit')) throw new DomainError('FORBIDDEN', 'Cannot submit');
  return withTenant(prisma, ctx, async (tx) => {
    const v = await tx.envelopeVersion.findUniqueOrThrow({ where: { id: input.versionId }, include: { envelope: true } });
    if (v.status !== 'DRAFT') throw new DomainError('CONFLICT', `Version is ${v.status}`);

    // Block a second concurrent request on the same envelope
    const open = await tx.approvalRequest.count({ where: { entityType: 'envelope_version', status: { in: ['PENDING', 'ESCALATED', 'CHANGES_REQUESTED'] },
      entityId: { in: (await tx.envelopeVersion.findMany({ where: { envelopeId: v.envelopeId }, select: { id: true } })).map(x => x.id) } } });
    if (open > 0) throw new DomainError('CONFLICT', 'An approval request is already open for this envelope');

    // Unresolved blocking threads on the envelope block submission (§8.6)
    const blocking = await tx.thread.count({ where: { anchorType: 'envelope', anchorId: v.envelopeId, status: 'open', isBlocking: true } });
    if (blocking > 0) throw new DomainError('CONFLICT', 'Resolve blocking threads before submitting');

    const diff = await computeDiff(tx, v);                 // { amountBefore, amountAfter, deltaAbs, deltaPct, isOverAllocation, level, dimensionValues, daysRemaining }
    const policy = await matchPolicy(tx, v.envelope.workspaceId, { entityType: 'envelope_version', ...diff });
    if (!policy) throw new DomainError('POLICY_NOT_FOUND', 'No approval policy matched');

    if (policy.chain.length === 0) {
      // auto-approve
      await approveVersion(tx, ctx, v, null, 'auto-approved by policy ' + policy.name);
      return { autoApproved: true };
    }

    const summary = await summarizeDiff(diff, v.rationale);   // packages/ai (OpenAI), falls back to template string on error
    const request = await tx.approvalRequest.create({ data: {
      id: uuidv7(), workspaceId: v.envelope.workspaceId, entityType: 'envelope_version', entityId: v.id,
      policyId: policy.id, policyVersion: policy.version, policySnapshot: { conditions: policy.conditions, chain: policy.chain, blockSelfApproval: policy.blockSelfApproval, allowExternalEvidence: policy.allowExternalEvidence },
      currentStep: 0, status: 'PENDING', summary, requestedBy: ctx.userId!,
      dueAt: addHours(new Date(), (policy.chain[0] as ChainStep).timeoutHours ?? 48),
    }});
    await tx.envelopeVersion.update({ where: { id: v.id }, data: { status: 'PENDING' } });
    await tx.envelope.update({ where: { id: v.envelopeId }, data: { status: 'PENDING' } });

    await audit(tx, { workspaceId: v.envelope.workspaceId, actorId: ctx.userId, actorType: ctx.actorType, action: 'approval.requested', entityType: 'approval_request', entityId: request.id, after: { versionId: v.id, policy: policy.name, policyVersion: policy.version }, requestId: ctx.requestId });
    await outbox(tx, { workspaceId: v.envelope.workspaceId, topic: 'approval.changed', payload: { requestId: request.id, status: 'PENDING', step: 0 } });
    return { autoApproved: false, requestId: request.id };
  });
}
```

### 7.3 Approve (called by the approval engine on the last step, or by auto-approve)

```ts
// apps/api/src/modules/approvals/commands/approve-version.ts
export async function approveVersion(tx: Tx, ctx: TenantContext, v: EnvelopeVersion & { envelope: Envelope }, requestId: string | null, reason: string) {
  // Cap check with parent lock (the DB trigger is the backstop)
  if (v.envelope.parentId) {
    const [parent] = await tx.$queryRaw<Array<{ allow: boolean; amount: string | null }>>`
      SELECT p.allow_over_allocation AS allow, pv.amount_reporting::text AS amount
      FROM envelope p LEFT JOIN envelope_version pv ON pv.id = p.current_version_id WHERE p.id = ${v.envelope.parentId}::uuid FOR UPDATE OF p`;
    if (parent && !parent.allow && parent.amount !== null) {
      const [sib] = await tx.$queryRaw<Array<{ s: string }>>`
        SELECT coalesce(sum(cv.amount_reporting),0)::text AS s FROM envelope c JOIN envelope_version cv ON cv.id = c.current_version_id
        WHERE c.parent_id = ${v.envelope.parentId}::uuid AND c.id <> ${v.envelopeId}::uuid`;
      const total = new Decimal(sib!.s).plus(v.amountReporting.toString());
      if (total.gt(parent.amount)) throw new DomainError('CAP_EXCEEDED', 'Children exceed parent budget', { parent: parent.amount, children: total.toString() });
    }
  }
  const now = new Date();
  if (v.envelope.currentVersionId) {
    await tx.envelopeVersion.update({ where: { id: v.envelope.currentVersionId }, data: { status: 'SUPERSEDED', supersededAt: now } });
  }
  await tx.envelopeVersion.update({ where: { id: v.id }, data: { status: 'APPROVED', approvedAt: now } });
  await tx.envelope.update({ where: { id: v.envelopeId }, data: { currentVersionId: v.id, draftVersionId: null, status: 'APPROVED' } });
  await audit(tx, { workspaceId: v.envelope.workspaceId, actorId: ctx.userId, actorType: ctx.actorType, action: 'envelope.version.approved', entityType: 'envelope', entityId: v.envelopeId,
    before: { versionId: v.envelope.currentVersionId }, after: { versionId: v.id, amount: v.amount.toString(), requestId }, reason, requestId: ctx.requestId });
  await outbox(tx, { workspaceId: v.envelope.workspaceId, topic: 'budget.changed', payload: { envelopeId: v.envelopeId, versionId: v.id, kind: 'approved' } });
  await bumpDataVersion(tx, v.envelope.workspaceId);
}
```

### 7.4 Bulk edit (§9.3)

Two-step: `POST /envelopes/bulk` returns a **preview** (stored in Redis 30 min, key `bulk:<previewId>`), `POST /envelopes/bulk/{previewId}/commit` applies it.

```ts
// packages/domain/src/envelopes.ts
export const BulkOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), amount: z.string() }),
  z.object({ op: z.literal('add'), amount: z.string() }),                       // negative allowed
  z.object({ op: z.literal('pct'), pct: z.number() }),                          // +15 => ×1.15
  z.object({ op: z.literal('redistribute'), parentId: z.string().uuid(), method: z.enum(['proportional', 'even', 'by_last_actuals', 'by_weights']), weights: z.record(z.string(), z.number()).optional(), total: z.string().optional() }),
  z.object({ op: z.literal('copy_previous_period'), factor: z.number().default(1) }),
  z.object({ op: z.literal('scale_to_total'), total: z.string() }),
  z.object({ op: z.literal('paste'), rows: z.array(z.object({ envelopeId: z.string().uuid(), amount: z.string() })) }),
]);
export const BulkRequest = z.object({
  workspaceId: z.string().uuid(),
  selection: z.union([z.object({ envelopeIds: z.array(z.string().uuid()).max(10_000) }), z.object({ filter: FilterGroup })]),
  operation: BulkOperation,
  rationale: z.string().min(3),
});
export const BulkPreview = z.object({
  previewId: z.string().uuid(), rows: z.array(z.object({ envelopeId: z.string().uuid(), path: z.array(z.string()), before: z.string().nullable(), after: z.string(), delta: z.string() })),
  totalsBefore: z.string(), totalsAfter: z.string(), capViolations: z.array(z.object({ parentId: z.string().uuid(), parentAmount: z.string(), childrenAfter: z.string() })),
  policyPreview: z.object({ name: z.string(), chain: z.array(z.string()) }).nullable(), expiresAt: z.string().datetime(),
});
```

`commitBulk` creates one draft version per row **in one transaction** (chunks of 500 via `createMany` for versions, then individual `envelope` updates), a single `approval_request` with `entityType='bulk_change'` whose `entityId` is a `bulk_change` row listing all version ids, one `audit_event` per envelope plus one summary event, and one `outbox` row `budget.changed` with `{ bulk: true, versionIds }`. If `rows.length > 10_000` → `DomainError('VALIDATION', 'Use CSV import for >10k rows')`.

### 7.5 Move / split / merge

`move`: update `parent_id`, write `envelope_lineage(kind='move')`, re-run cap check on the new parent for the current approved amount (fail with `CAP_EXCEEDED` unless `allow_over_allocation`), re-evaluate open approval requests' policy (if the matched policy changes, mark request `CHANGES_REQUESTED` with system comment). `split`: create N children under the same parent with drafts summing to the source's approved amount, archive source after approval, lineage `split`. `merge`: inverse. All three are `envelope.move` permission.

---

## 8. Registry commands (§4.2)

`apps/api/src/modules/registry/`:

- `createDimension(ctx, { key, label, dataType, icon, color, allowedParents, isRequiredForLeaf, workspaceId | null })` — key must match `/^[a-z][a-z0-9_]{1,40}$/`; icon `lucide:<name>` validated against the bundled Lucide name list, or `asset:<gcsObject>` after `POST /assets` (SVG only, ≤ 50 KB, sanitized with `svgo` + `dompurify`). Emits `registry.changed`.
- `addValues(ctx, dimensionId, values[])` — upsert by `code`; `parentCode` resolves to `parent_value_id`; trigger sets `path`.
- `mergeValues(ctx, dimensionId, { fromCode, intoCode })` — sets `merged_into_id`, appends `fromCode` to `aliases` of target, **rewrites `envelope_dimension.value_id`** for all envelopes in one statement, writes one audit event per affected envelope (batched insert), emits `registry.changed`, and re-indexes.
- `saveHierarchyTemplate(ctx, { name, path[], isDefault })` — every key must exist and each adjacent pair must satisfy `allowedParents` (child lists parent) or be free (empty `allowedParents`).
- `validateTuple(tx, workspaceId, dimensionValues)` — used by every envelope create: every key exists and is active; every code exists; required-for-leaf satisfied when the envelope has no children; `value_constraint` satisfied. Returns `{ ok: true, valueIds: Record<key, valueId> }` used to fill `envelope_dimension`.

Icon rendering contract for the frontend: `icon` string → `<DimensionIcon icon="lucide:globe" />` renders the Lucide component by name via `lucide-react`'s `icons` map; `asset:` renders `<img src={signedUrl}>`.

---

## 9. Approval engine (§8.1–8.3)

### 9.1 Policy conditions JSON

```ts
// packages/domain/src/approvals.ts
export const PolicyConditions = z.object({
  entityType: z.enum(['envelope_version', 'target_version', 'bulk_change']).optional(),
  amountAbs: z.object({ gte: z.number().optional(), lt: z.number().optional() }).optional(),        // in reporting currency
  deltaAbs: z.object({ gte: z.number().optional(), lt: z.number().optional() }).optional(),
  deltaPct: z.object({ gte: z.number().optional(), lt: z.number().optional() }).optional(),         // 0.15 = 15%
  isOverAllocation: z.boolean().optional(),
  level: z.object({ gte: z.number().int().optional(), lte: z.number().int().optional() }).optional(),
  dimension: z.record(z.string(), z.array(z.string())).optional(),                                  // { region: ['LATAM'], platform: ['meta'] }
  daysRemaining: z.object({ lt: z.number().int().optional() }).optional(),
  metricKey: z.array(z.string()).optional(),                                                        // for target_version
  any: z.array(z.lazy(() => PolicyConditions)).optional(),
});
export const ChainStep = z.object({
  role: z.enum(['PLANNER', 'BUDGET_OWNER', 'APPROVER', 'FINANCE', 'WORKSPACE_ADMIN']),
  groupId: z.string().uuid().optional(),           // restrict to a group
  minApprovals: z.number().int().min(1).default(1),
  timeoutHours: z.number().int().default(48),
  escalateTo: z.enum(['FINANCE', 'WORKSPACE_ADMIN']).optional(),
});
export type ChainStep = z.infer<typeof ChainStep>;
```

### 9.2 Matching

```ts
// apps/api/src/modules/approvals/policy-matcher.ts
export interface DiffFacts { entityType: string; amountAbs: number; deltaAbs: number; deltaPct: number; isOverAllocation: boolean; level: number; dimensionValues: Record<string, string>; daysRemaining: number; metricKey?: string }

export function conditionsMatch(c: PolicyConditions, f: DiffFacts): boolean {
  if (c.any) return c.any.some(x => conditionsMatch(x, f));
  if (c.entityType && c.entityType !== f.entityType) return false;
  const range = (r: { gte?: number; lt?: number; lte?: number } | undefined, v: number) => !r || ((r.gte === undefined || v >= r.gte) && (r.lt === undefined || v < r.lt) && (r.lte === undefined || v <= r.lte));
  if (!range(c.amountAbs, Math.abs(f.amountAbs))) return false;
  if (!range(c.deltaAbs, Math.abs(f.deltaAbs))) return false;
  if (!range(c.deltaPct, Math.abs(f.deltaPct))) return false;
  if (c.isOverAllocation !== undefined && c.isOverAllocation !== f.isOverAllocation) return false;
  if (!range(c.level, f.level)) return false;
  if (c.daysRemaining?.lt !== undefined && !(f.daysRemaining < c.daysRemaining.lt)) return false;
  if (c.metricKey && (!f.metricKey || !c.metricKey.includes(f.metricKey))) return false;
  if (c.dimension) for (const [k, allowed] of Object.entries(c.dimension)) { if (!allowed.includes(f.dimensionValues[k] ?? '')) return false; }
  return true;
}

export async function matchPolicy(tx: Tx, workspaceId: string, f: DiffFacts) {
  const policies = await tx.approvalPolicy.findMany({ where: { workspaceId, isActive: true }, orderBy: { priority: 'asc' } });
  for (const p of policies) if (conditionsMatch(PolicyConditions.parse(p.conditions), f)) return { ...p, chain: z.array(ChainStep).parse(p.chain) };
  return null;
}
```

Seed (`packages/db/seed/defaults.policies.ts`) creates the three templates from plan §8.1 plus a `Default` catch-all (`priority: 999`, chain `[BUDGET_OWNER]`), and `Auto-approve minor` (`priority: 1`, `deltaPct.lt: 0.02`, `deltaAbs.lt: 1000`, chain `[]`).

### 9.3 Deciding and advancing

```ts
// apps/api/src/modules/approvals/commands/decide.ts
export const DecideInput = z.object({ requestId: z.string().uuid(), decision: z.enum(['approve', 'reject', 'request_changes']), comment: z.string().max(4000).optional(), channel: z.enum(['app', 'slack', 'email']).default('app') });

export async function decide(prisma: PrismaClient, ctx: TenantContext, roles: Role[], raw: unknown) {
  const input = DecideInput.parse(raw);
  if (!can(roles, 'approval.decide')) throw new DomainError('FORBIDDEN', 'Cannot decide approvals');
  if (input.decision !== 'approve' && !input.comment) throw new DomainError('VALIDATION', 'Comment required to reject or request changes');

  return withTenant(prisma, ctx, async (tx) => {
    const [r] = await tx.$queryRaw<Array<ApprovalRequestRow>>`SELECT * FROM approval_request WHERE id = ${input.requestId}::uuid FOR UPDATE`;
    if (!r) throw new DomainError('NOT_FOUND', 'Request not found');
    if (!['PENDING', 'ESCALATED'].includes(r.status)) throw new DomainError('CONFLICT', `Request is ${r.status}`);

    const eligible = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT eligible_approver(${r.id}::uuid, ${ctx.userId}::uuid) AS ok`;
    if (!eligible[0]?.ok) throw new DomainError('FORBIDDEN', 'You are not an eligible approver for this step');
    const already = await tx.approvalDecision.count({ where: { requestId: r.id, stepIndex: r.current_step, decidedBy: ctx.userId! } });
    if (already) throw new DomainError('CONFLICT', 'You already decided this step');

    await tx.approvalDecision.create({ data: { id: uuidv7(), requestId: r.id, stepIndex: r.current_step, decidedBy: ctx.userId!, decision: input.decision, comment: input.comment, channel: input.channel } });
    const snapshot = r.policy_snapshot as { chain: ChainStep[] };
    const step = snapshot.chain[r.current_step]!;

    if (input.decision === 'reject') {
      await finalize(tx, ctx, r, 'REJECTED');
    } else if (input.decision === 'request_changes') {
      await tx.approvalRequest.update({ where: { id: r.id }, data: { status: 'CHANGES_REQUESTED' } });
      await openBlockingThread(tx, ctx, r, input.comment!);          // §8.6 integration
    } else {
      const approvals = await tx.approvalDecision.count({ where: { requestId: r.id, stepIndex: r.current_step, decision: 'approve' } });
      if (approvals >= step.minApprovals) {
        const next = r.current_step + 1;
        if (next >= snapshot.chain.length) {
          await finalize(tx, ctx, r, 'APPROVED');                         // → approveVersion / approveTarget / approveBulk
        } else {
          await tx.approvalRequest.update({ where: { id: r.id }, data: { currentStep: next, dueAt: addHours(new Date(), snapshot.chain[next]!.timeoutHours), status: 'PENDING' } });
        }
      }
    }
    await audit(tx, { workspaceId: r.workspace_id, actorId: ctx.userId, actorType: ctx.actorType, action: `approval.${input.decision}`, entityType: 'approval_request', entityId: r.id, after: { step: r.current_step, comment: input.comment }, requestId: ctx.requestId });
    await outbox(tx, { workspaceId: r.workspace_id, topic: 'approval.changed', payload: { requestId: r.id } });
  });
}
```

`escalateOverdue()` runs from the pacing job every 15 min: requests with `due_at < now()` and a step `escalateTo` → append a synthetic step `{ role: escalateTo, minApprovals: 1, timeoutHours: 72 }` to the snapshot chain, set `status='ESCALATED'`, audit `approval.escalated`, outbox.

External evidence: `POST /approvals/{id}/external-evidence` (`envelope.submit` permission) stores `{ gcsUri, sha256, approverName, approvedOn }` as a decision with `decision='external_evidence'`, `channel='external_upload'`; it counts toward `minApprovals` only if `policySnapshot.allowExternalEvidence`.

### 9.4 Decision timeline query

`GET /envelopes/{id}/timeline` = `UNION ALL` of: `audit_event` for the envelope and its versions/requests; `comment` rows (via threads anchored to envelope, versions, requests, cells); `alert` open/resolve; `ingest_run` completions that touched the envelope (via `spend_fact.source_run_id`); `period_closure`. Ordered by time desc, cursor-paginated, each row `{ at, kind, actor, title, detail, refs }`. Point-in-time: `GET /envelopes/{id}?as_of=` uses the same subquery as the planner's `budget` measure.

---

## 10. Targets (§4.8)

`apps/api/src/modules/targets/`: mirrors envelopes — `createDraftTargetVersion`, `submitTargetVersion` (policy match with `entityType='target_version'`, `metricKey`, `deltaPct`), `approveTargetVersion`. Resolution of the effective target for an envelope:

```sql
-- functions in 0003_functions/migration.sql
CREATE OR REPLACE FUNCTION effective_target(p_envelope uuid, p_metric text) RETURNS TABLE(target_id uuid, value numeric, comparator text, inherited_from uuid) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain AS (
    SELECT e.id, e.parent_id, 0 AS depth FROM envelope e WHERE e.id = p_envelope
    UNION ALL SELECT p.id, p.parent_id, c.depth + 1 FROM envelope p JOIN chain c ON p.id = c.parent_id
  )
  SELECT t.id, tv.value, tv.comparator, CASE WHEN c.depth = 0 THEN NULL ELSE c.id END
  FROM chain c JOIN target t ON t.envelope_id = c.id AND t.metric_key = p_metric AND t.scope_type = 'envelope'
  JOIN target_version tv ON tv.id = t.current_version_id
  ORDER BY c.depth LIMIT 1
$$;
```

Filter-scoped targets (`scope_type='filter'`) are resolved by the planner: for each requested metric, targets whose `scope_filter` matches the row's dimensions (evaluated with `matchesScope`) apply when no envelope-scoped target exists. Implied volume for budget+CPA: `budget / cpa_target`, computed in the API response builder, never stored.

---

## 11. Pacing evaluator (§8.4)

Cloud Run Job `apps/workers/src/pacing/main.ts`, Cloud Scheduler `*/15 * * * *`. Runs as system (`actorType: 'system'`, `isOrgAdmin: true`, iterating workspaces).

```ts
export async function evaluateWorkspace(prisma: PrismaClient, workspaceId: string, today: string) {
  const ctx: TenantContext = { workspaceId, userId: null, isOrgAdmin: false, actorType: 'system', requestId: `pacing-${today}-${workspaceId}` };
  await withTenant(prisma, ctx, async (tx) => {
    const rules = await tx.pacingRule.findMany({ where: { workspaceId, isActive: true } });
    for (const rule of rules) {
      // 1. envelopes in scope, with the metric value, via the planner (one SQL per rule)
      const q = QueryRequest.parse({ workspaceId, filter: rule.scope, groupBy: [], measures: ['budget', 'actual', 'projected', 'pace_index', 'projected_close_pct'],
        targets: rule.metric === 'kpi_vs_target_pct' ? [(rule.metricArgs as any).metricKey] : [], period: { kind: 'relative', preset: 'current_quarter' }, limit: 1000 });
      for await (const row of planner.iterate(tx, q)) {
        const value = metricValue(rule, row);                       // Decimal | null
        if (value === null) continue;
        const breached = compare(rule.comparator, value, rule.threshold);
        const state = await tx.ruleState.findUnique({ where: { ruleId_envelopeId: { ruleId: rule.id, envelopeId: row.envelopeId! } } });
        const consecutive = breached ? (state && state.lastEvalDate.toISOString().slice(0, 10) === yesterday(today) ? state.consecutiveDays + 1 : 1) : 0;
        await tx.ruleState.upsert({ where: { ruleId_envelopeId: { ruleId: rule.id, envelopeId: row.envelopeId! } },
          create: { ruleId: rule.id, envelopeId: row.envelopeId!, consecutiveDays: consecutive, lastEvalDate: new Date(today), lastValue: value.toString() },
          update: { consecutiveDays: consecutive, lastEvalDate: new Date(today), lastValue: value.toString() } });

        const open = await tx.alert.findFirst({ where: { ruleId: rule.id, envelopeId: row.envelopeId!, status: { in: ['OPEN', 'ACKNOWLEDGED', 'SNOOZED'] } } });
        if (breached && consecutive >= rule.consecutiveDays && !open) {
          const alert = await tx.alert.create({ data: { id: uuidv7(), workspaceId, ruleId: rule.id, envelopeId: row.envelopeId!, severity: rule.severity, metricValue: value.toString(), threshold: rule.threshold,
            context: { budget: row.measures.budget, actual: row.measures.actual, projected: row.measures.projected, targets: row.targets, dataAsOf: new Date().toISOString() }, ownerId: await envelopeOwner(tx, row.envelopeId!) } });
          await audit(tx, { workspaceId, actorId: null, actorType: 'system', action: 'alert.opened', entityType: 'alert', entityId: alert.id, after: { rule: rule.name, value: value.toString() } });
          await outbox(tx, { workspaceId, topic: 'alert.triggered', payload: { alertId: alert.id, delivery: rule.delivery } });
        } else if (!breached && open && open.status !== 'SNOOZED') {
          await tx.alert.update({ where: { id: open.id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
          await audit(tx, { workspaceId, actorId: null, actorType: 'system', action: 'alert.resolved', entityType: 'alert', entityId: open.id, after: { value: value.toString() } });
        }
      }
    }
    await tx.$executeRaw`SELECT ensure_fact_partitions(current_date, 3)`;
  });
}

function metricValue(rule: PacingRule, row: QueryRow): Decimal | null {
  const m = row.measures; const args = rule.metricArgs as { metricKey?: string };
  const d = (s: string | null | undefined) => (s == null ? null : new Decimal(s));
  switch (rule.metric) {
    case 'pace_index': return d(m.pace_index);
    case 'projected_close_pct': return d(m.projected_close_pct);
    case 'spend_to_date_pct': return d(m.spend_to_date_pct);
    case 'projected_variance_abs': return d(m.variance_abs);
    case 'kpi_vs_target_pct': { const t = row.targets[args.metricKey!]; return t?.vsTargetPct ? new Decimal(t.vsTargetPct) : null; }
    case 'implied_volume_gap': { const cpa = row.targets['cpa']; const b = d(m.budget); if (!cpa?.target || !b || !cpa.actual) return null;
      const implied = b.div(cpa.target); const projectedConv = d(m.projected)!.div(cpa.actual); return projectedConv.minus(implied).div(implied); }
    case 'efficiency_adjusted_pace': { const cpa = row.targets['cpa']; const p = d(m.pace_index); if (!p || !cpa?.actual || !cpa.target) return null; return p.mul(new Decimal(cpa.actual).div(cpa.target)); }
    case 'unmatched_spend_pct': return null; // computed by a separate workspace-level query in evaluateUnmatched()
    default: return null;
  }
}
```

Alert lifecycle API: `PATCH /alerts/{id}` with `{ status: 'ACKNOWLEDGED' | 'SNOOZED' | 'RESOLVED', snoozedUntil?, ownerId? }`. Snoozed alerts re-open automatically when `snoozedUntil` passes and the rule is still breached.

---

## 12. Search (§11.3)

### 12.1 Indexer

`apps/workers/src/search-indexer/main.ts` (Cloud Run service, Pub/Sub push from the outbox publisher). Handles topics `budget.changed`, `target.changed`, `approval.changed`, `alert.triggered`, `thread.changed`, `tag.changed`, `registry.changed`. For each, calls the matching `buildDocument*` and upserts:

```ts
export async function upsertDocument(tx: Tx, d: SearchDoc) {
  await tx.$executeRaw`
    INSERT INTO search_document (workspace_id, entity_type, entity_id, title, path, body, tags, dimension_values, numeric_facets, owner_id, status, period_key, updated_at)
    VALUES (${d.workspaceId}::uuid, ${d.entityType}, ${d.entityId}::uuid, ${d.title}, ${d.path}, ${d.body}, ${d.tags}::text[], ${JSON.stringify(d.dimensionValues)}::jsonb, ${JSON.stringify(d.numericFacets)}::jsonb, ${d.ownerId}::uuid, ${d.status}, ${d.periodKey}, now())
    ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET title=EXCLUDED.title, path=EXCLUDED.path, body=EXCLUDED.body, tags=EXCLUDED.tags,
      dimension_values=EXCLUDED.dimension_values, numeric_facets=EXCLUDED.numeric_facets, owner_id=EXCLUDED.owner_id, status=EXCLUDED.status, period_key=EXCLUDED.period_key, updated_at=now()`;
}

export async function buildEnvelopeDocument(tx: Tx, envelopeId: string): Promise<SearchDoc> {
  const e = await tx.envelope.findUniqueOrThrow({ where: { id: envelopeId } });
  const path = await envelopePathLabels(tx, envelopeId);                 // ['LATAM','Brazil','Meta','Conversions']
  const [m] = await planner.run(tx, QueryRequest.parse({ workspaceId: e.workspaceId, filter: { logic: 'and', children: [{ field: { kind: 'attr', key: 'name' }, op: 'eq', value: e.name }] }, groupBy: [], period: { kind: 'relative', preset: 'current_quarter' }, targets: ['cpa'], limit: 1 }));
  const tags = await tx.$queryRaw<{ name: string }[]>`SELECT t.name FROM taggable tg JOIN tag t ON t.id = tg.tag_id WHERE tg.entity_type='envelope' AND tg.entity_id=${envelopeId}::uuid`;
  const rationales = await tx.envelopeVersion.findMany({ where: { envelopeId, rationale: { not: null } }, select: { rationale: true }, take: 5, orderBy: { createdAt: 'desc' } });
  const externalIds = Object.values(e.dimensionValues as Record<string,string>).join(' ');
  return {
    workspaceId: e.workspaceId, entityType: 'envelope', entityId: e.id, title: e.name, path: path.join(' › '),
    body: [...rationales.map(r => r.rationale!), externalIds].join('\n'),
    tags: tags.map(t => t.name), dimensionValues: e.dimensionValues as Record<string, string>,
    numericFacets: { budget: m?.measures.budget, actual: m?.measures.actual, pace_index: m?.measures.pace_index, cpa: m?.targets['cpa']?.actual },
    ownerId: e.ownerId, status: e.status, periodKey: await periodKeyFor(tx, e),
  };
}
```

Full re-index: `pnpm --filter @budget/workers reindex --workspace <id>` iterates all entities in batches of 1,000.

### 12.2 Qualifier parser

```ts
// packages/domain/src/search.ts
export interface ParsedSearch { text: string; qualifiers: Array<{ key: string; op: 'eq' | 'gt' | 'lt' | 'neq'; value: string }>; types: string[] }
const QUAL = /(?:^|\s)(-)?([a-z_]+):((?:>|<)?[^\s"]+|"[^"]*")/gi;

export function parseSearch(input: string): ParsedSearch {
  const qualifiers: ParsedSearch['qualifiers'] = []; const types: string[] = [];
  const text = input.replace(QUAL, (_, neg: string | undefined, key: string, raw: string) => {
    let value = raw.replace(/^"|"$/g, ''); let op: ParsedSearch['qualifiers'][number]['op'] = neg ? 'neq' : 'eq';
    if (value.startsWith('>')) { op = 'gt'; value = value.slice(1); } else if (value.startsWith('<')) { op = 'lt'; value = value.slice(1); }
    if (key.toLowerCase() === 'type') types.push(value.toLowerCase()); else qualifiers.push({ key: key.toLowerCase(), op, value });
    return ' ';
  }).trim().replace(/\s+/g, ' ');
  return { text, qualifiers, types };
}
```

### 12.3 Search query

```ts
// apps/api/src/modules/search/queries/search.ts
export async function search(tx: Tx, workspaceId: string, userId: string, parsed: ParsedSearch, limitPerType = 5) {
  const b = new SqlBuilder();
  const conds: string[] = [`workspace_id = ${b.p(workspaceId)}::uuid`];
  if (parsed.types.length) conds.push(`entity_type = ANY(${b.p(parsed.types)}::text[])`);
  for (const q of parsed.qualifiers) {
    switch (q.key) {
      case 'tag': conds.push(`${q.op === 'neq' ? 'NOT ' : ''}(${b.p(q.value)} = ANY(tags))`); break;
      case 'status': conds.push(`status ${q.op === 'neq' ? '<>' : '='} ${b.p(q.value.toUpperCase())}`); break;
      case 'owner': conds.push(`owner_id = ${q.value === '@me' ? `${b.p(userId)}::uuid` : `(SELECT id FROM app_user WHERE email ILIKE ${b.p(q.value + '%')} LIMIT 1)`}`); break;
      case 'period': conds.push(`period_key = ${b.p(q.value)}`); break;
      case 'budget': case 'actual': case 'cpa': case 'pace':
        conds.push(`(numeric_facets->>${b.p(q.key === 'pace' ? 'pace_index' : q.key)})::numeric ${q.op === 'gt' ? '>' : q.op === 'lt' ? '<' : '='} ${b.p(Number(q.value))}`); break;
      case 'has': if (q.value === 'open-thread') conds.push(`entity_id IN (SELECT anchor_id FROM thread WHERE status='open')`); break;
      case 'mentions': conds.push(`entity_type='comment' AND entity_id IN (SELECT id FROM comment WHERE mentions @> ${b.p(JSON.stringify([{ type: 'user', id: userId }]))}::jsonb)`); break;
      case 'updated': conds.push(`updated_at > now() - ${b.p(parseRelative(q.value))}::interval`); break;   // '<7d' → '7 days'
      default: // any registry dimension key → dimension_values ->> key
        conds.push(`dimension_values->>${b.p(q.key)} ${q.op === 'neq' ? '<>' : '='} ${b.p(q.value)}`);
    }
  }
  const hasText = parsed.text.length > 0;
  const tsq = hasText ? `websearch_to_tsquery('simple', ${b.p(parsed.text)})` : null;
  const trg = hasText ? b.p(parsed.text.toLowerCase()) : null;
  if (hasText) conds.push(`(tsv @@ ${tsq} OR trigram % ${trg} OR trigram LIKE ${b.p('%' + parsed.text.toLowerCase() + '%')})`);
  const rank = hasText ? `(ts_rank_cd(tsv, ${tsq}) * 2 + similarity(trigram, ${trg}))` : `extract(epoch from updated_at) / 1e12`;
  const sql = `
    SELECT * FROM (
      SELECT entity_type, entity_id, title, path, status, numeric_facets, updated_at, ${rank} AS rank,
             row_number() OVER (PARTITION BY entity_type ORDER BY ${rank} DESC, updated_at DESC) AS rn,
             count(*) OVER (PARTITION BY entity_type) AS type_count
      FROM search_document WHERE ${conds.join(' AND ')}
    ) x WHERE rn <= ${b.p(limitPerType)} ORDER BY entity_type, rank DESC`;
  return tx.$queryRawUnsafe<SearchHitRow[]>(sql, ...b.values);
}
```

`GET /search?q=&types=&limit=` → `{ groups: [{ type, count, hits: [{ id, title, path, status, facets, deepLink }] }], parsed }`. `deepLink` is built server-side: envelope → `/w/{ws}/budgets?filter=<encoded>&select=<id>`; approval → `/w/{ws}/approvals/{id}`; etc. Also `GET /search/suggest?prefix=` returns qualifier keys (registry dimension keys + fixed set) and values (top 10 `dimension_value.label ILIKE prefix%`) for autocompletion.

---

## 13. Threads, comments, tags (§8.6)

`apps/api/src/modules/threads/`:

```ts
export const CreateThreadInput = z.object({
  anchorType: z.enum(['envelope', 'envelope_version', 'target', 'approval_request', 'alert', 'closure', 'dimension_value', 'cell', 'diff_field']),
  anchorId: z.string().uuid(),
  anchorMeta: z.object({ month: z.string().date().optional(), field: z.string().optional() }).default({}),
  title: z.string().max(200).optional(),
  isBlocking: z.boolean().default(false),
  firstComment: CommentInput,
});
export const CommentInput = z.object({
  bodyMd: z.string().min(1).max(20_000),
  parentCommentId: z.string().uuid().optional(),
  attachments: z.array(z.object({ gcsUri: z.string(), name: z.string(), sha256: z.string() })).default([]),
});
```

Server extracts `mentions` and `references` from `bodyMd` with two regexes: `@\[(user|group):([0-9a-f-]{36})\]` and `#\[(envelope|target|alert|request):([0-9a-f-]{36})\]` (the TipTap mention extension writes this canonical form; display names are resolved on read). Every create/edit/resolve: `audit` (`thread.created`, `comment.added`, `comment.edited`, `thread.resolved`) + `outbox('thread.changed', { threadId, mentions })`. `notify-worker` fans out mentions and subscriptions (`subscription(user_id, entity_type, entity_id)` table added in `0003_functions` migration).

Permission: `thread.comment` requires read on the anchor (RLS + scope); `thread.resolve` requires author, anchor owner, or eligible approver on an open request for the anchor.

Tags: `POST /tags` (`tag.create`), `POST /tags/apply` `{ tagId, entities: [{ type, id }] }` (`tag.apply`, up to 10k entities → single `createMany` with `skipDuplicates`), `DELETE /tags/apply` same body. `PATCH /tags/{id}` rename/merge (`{ mergeIntoId }` rewrites `taggable.tag_id`). All emit `tag.changed` so the indexer refreshes affected documents.

---

## 14. Ingestion (§6.1)

`apps/workers/src/ingest/` — one connector per `DataSource.kind`, all implementing:

```ts
export interface Connector {
  kind: 'snowflake' | 'sheets' | 'bigquery' | 'csv' | 'manual';   // 'manual' rows come from an approved ManualEntryBatch (§26), never from a stream
  /** Stream normalized rows. Never buffers the whole source. */
  read(source: DataSource, secret: Record<string, string>, since?: Date): AsyncIterable<RawRow>;
}
export interface RawRow { [column: string]: string | number | null }
export interface NormalizedFact {
  kind: 'spend' | 'kpi' | 'projection' | 'target';
  dimensionValues: Record<string, string>; periodDate: string; currency?: string; amount?: string;
  metric?: string; value?: string; attributionModel?: string; formulaVersion?: string; horizonEnd?: string; rowHash: string;
}
```

**Mapping** (`DataSource.mapping`):

```json
{
  "columns": {
    "COUNTRY_CODE": { "dimension": "country" },
    "PLATFORM": { "dimension": "platform", "transform": "lower" },
    "OBJECTIVE": { "dimension": "objective", "valueMap": { "Brand": "brand", "Non-Brand": "non_brand", "Competitor": "competitor" } },
    "DATE": { "role": "period_date", "format": "yyyy-MM-dd" },
    "SPEND_EUR": { "role": "amount", "currency": "EUR" },
    "CONVERSIONS": { "role": "kpi", "metric": "conversions", "attributionModel": "7d_click" },
    "REVENUE": { "role": "kpi", "metric": "revenue" },
    "FORMULA_VERSION": { "role": "formula_version" }
  },
  "kind": "spend+kpi"
}
```

`POST /sources/{id}/suggest-mapping` sends the header row + 20 sample rows to `packages/ai` `mapColumns()` (OpenAI, JSON mode, schema-validated); the user confirms in the UI; nothing is auto-applied.

**Pipeline** (`runIngest(sourceId)`):

1. Create `ingest_run`. 2. Stream rows → `normalize(row, mapping)` → validate against registry (`dimension_value.code` or `aliases` or `external_ids` match; unknown → rejected with reason). 3. `rowHash = sha256(sourceId + JSON.stringify(sortedRow))`. 4. Batch `INSERT ... ON CONFLICT (workspace_id, source_row_hash, period_date) DO UPDATE SET amount=EXCLUDED.amount, loaded_at=now()` in chunks of 5,000 using `COPY` via `pg-copy-streams` when > 50k rows. 5. **Match** (one statement per run):

```sql
UPDATE spend_fact sf SET envelope_id = m.envelope_id
FROM (
  SELECT sf2.id, sf2.period_date, e.id AS envelope_id,
         row_number() OVER (PARTITION BY sf2.id ORDER BY jsonb_array_length(jsonb_path_query_array(e.dimension_values, '$.*')) DESC) AS rn
  FROM spend_fact sf2 JOIN envelope e
    ON e.workspace_id = sf2.workspace_id
   AND sf2.period_date BETWEEN e.start_date AND e.end_date
   AND e.dimension_values <@ sf2.dimension_values           -- envelope tuple is a subset of the fact's tuple (most specific wins)
   AND e.status <> 'ARCHIVED'
  WHERE sf2.source_run_id = $1 AND sf2.envelope_id IS NULL
) m WHERE sf.id = m.id AND sf.period_date = m.period_date AND m.rn = 1;
```

6. Write rejected rows to GCS as CSV (`error_report_uri`). 7. Finish run, `outbox('facts.loaded', { runId, sourceId, envelopeIds })`, bump `dataVersion`. Unmatched: `GET /unmatched-spend` groups `spend_fact WHERE envelope_id IS NULL` by `dimension_values`; `POST /unmatched-spend/map` `{ dimensionValues, envelopeId | createEnvelope, addExternalId? }` re-runs step 5 for those rows.

Connectors: Snowflake uses `snowflake-sdk` with key-pair auth (`privateKey` from Secret Manager), `SELECT * FROM <view> WHERE UPDATED_AT > :since`; Sheets uses `googleapis` `spreadsheets.values.get` with the service account added as viewer; BigQuery uses `@google-cloud/bigquery` `createQueryStream`; CSV reads from the GCS upload URI with `csv-parse`.

---

## 15. Closures (§4.5)

`POST /closures` `{ periodId }` (`closure.close`): in one transaction, lock envelopes overlapping the period (`status='LOCKED'`, versions untouched), snapshot registry versions, run the planner for every hierarchy template at `grain='month'` and write rows to BigQuery table `closures.budget_vs_actual_<workspace>_<period>` via streaming insert (or GCS → load job when > 100k rows), store `variance_summary`, audit `closure.created`, outbox `period.closed`. `POST /closures/{id}/restate` (`closure.restate`) requires `reason`, sets `status='restated'`, unlocks, and audits `closure.restated`; the BigQuery table is versioned by suffix `_r<N>`, never overwritten. Fact loads for a closed period are rejected at ingestion unless the run is flagged `restatementOf=<closureId>`.

---

## 16. Read-only MCP server (§6.4)

`apps/mcp/src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { QueryRequest, FilterGroup, parseSearch } from '@budget/domain';
import { withTenant } from '@budget/db';
import * as q from '@budget/api-queries';   // path alias to apps/api/src/modules/**/queries — READ ONLY

export function buildServer(deps: { prisma: PrismaClient; planner: QueryPlannerService }) {
  const server = new McpServer({ name: 'budget-os', version: '1.0.0' });
  const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

  server.registerTool('list_workspaces', { description: 'Workspaces the caller can access', inputSchema: {} },
    async (_, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, null), tx => q.listWorkspaces(tx))));

  server.registerTool('describe_dimensions', { description: 'Dimension registry with values and hierarchy templates. Call before building filters.',
    inputSchema: { workspaceId: z.string().uuid() } },
    async ({ workspaceId }, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, workspaceId), tx => q.describeDimensions(tx, workspaceId))));

  server.registerTool('query_budgets', { description: 'Budget vs actual vs projected at any grouping. Uses the FilterGroup AST from describe_dimensions keys.',
    inputSchema: QueryRequest.shape },
    async (input, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, input.workspaceId), tx => deps.planner.run(tx, QueryRequest.parse(input)))));

  server.registerTool('get_budget', { description: 'One envelope: approved version, draft, targets, pacing, open threads/alerts.',
    inputSchema: { workspaceId: z.string().uuid(), envelopeId: z.string().uuid(), asOf: z.string().datetime().optional() } },
    async (i, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, i.workspaceId), tx => q.getEnvelope(tx, i.envelopeId, i.asOf))));

  server.registerTool('get_pacing', { description: 'Pacing metrics and alert state for a filter.',
    inputSchema: { workspaceId: z.string().uuid(), filter: FilterGroup.optional(), period: QueryRequest.shape.period } },
    async (i, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, i.workspaceId), tx => q.getPacing(tx, i))));

  server.registerTool('query_targets', { description: 'Budget and KPI targets with inheritance resolved.',
    inputSchema: { workspaceId: z.string().uuid(), filter: FilterGroup.optional(), metricKey: z.string().optional(), period: QueryRequest.shape.period } },
    async (i, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, i.workspaceId), tx => q.queryTargets(tx, i))));

  server.registerTool('search', { description: 'Global search with qualifiers, e.g. "brazil meta country:BR status:pending"',
    inputSchema: { workspaceId: z.string().uuid(), query: z.string(), types: z.array(z.string()).optional(), limit: z.number().int().max(50).default(10) } },
    async (i, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, i.workspaceId), tx => q.search(tx, i.workspaceId, extra.authInfo!.clientId, { ...parseSearch(i.query), types: i.types ?? [] }, i.limit))));

  server.registerTool('list_approvals', { description: 'Approval requests and decisions', inputSchema: { workspaceId: z.string().uuid(), status: z.array(z.string()).optional(), assignee: z.literal('@me').optional(), limit: z.number().int().max(200).default(50), cursor: z.string().optional() } },
    async (i, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, i.workspaceId), tx => q.listApprovals(tx, i))));

  server.registerTool('get_decision_timeline', { description: 'Full lineage of an envelope: versions, approvals, comments, alerts, ingestion, closures', inputSchema: { workspaceId: z.string().uuid(), envelopeId: z.string().uuid(), limit: z.number().int().max(500).default(100), cursor: z.string().optional() } },
    async (i, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, i.workspaceId), tx => q.timeline(tx, i.envelopeId, i.limit, i.cursor))));

  server.registerTool('list_alerts', { description: 'Alerts', inputSchema: { workspaceId: z.string().uuid(), filter: FilterGroup.optional(), status: z.array(z.string()).optional(), limit: z.number().int().max(500).default(100) } },
    async (i, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, i.workspaceId), tx => q.listAlerts(tx, i))));

  server.registerTool('list_threads', { description: 'Threads and comments on an entity', inputSchema: { workspaceId: z.string().uuid(), anchorType: z.string(), anchorId: z.string().uuid() } },
    async (i, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, i.workspaceId), tx => q.listThreads(tx, i))));

  server.registerTool('list_tags', { description: 'Tag vocabulary', inputSchema: { workspaceId: z.string().uuid() } },
    async (i, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, i.workspaceId), tx => q.listTags(tx, i.workspaceId))));

  server.registerTool('get_closure', { description: 'Locked closure snapshot', inputSchema: { workspaceId: z.string().uuid(), periodKey: z.string() } },
    async (i, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, i.workspaceId), tx => q.getClosure(tx, i))));

  server.registerTool('export_csv', { description: 'Run a query and return a signed URL to a CSV (expires in 1h)', inputSchema: QueryRequest.shape },
    async (i, extra) => text(await withTenant(deps.prisma, ctxFrom(extra, i.workspaceId), tx => q.exportCsv(tx, QueryRequest.parse(i)))));

  server.registerResource('registry', new ResourceTemplate('budget://workspace/{workspaceId}/registry', { list: undefined }), { description: 'Dimension registry' },
    async (uri, { workspaceId }, extra) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await withTenant(deps.prisma, ctxFrom(extra, String(workspaceId)), tx => q.describeDimensions(tx, String(workspaceId)))) }] }));

  return server;
}

/** Per-user context from the bearer token validated by auth.ts (Identity Platform JWT behind IAP). */
function ctxFrom(extra: { authInfo?: { clientId: string; extra?: Record<string, unknown> } }, workspaceId: string | null): TenantContext {
  const userId = extra.authInfo?.clientId; if (!userId) throw new Error('unauthenticated');
  return { workspaceId, userId, isOrgAdmin: false, actorType: 'mcp', requestId: `mcp-${crypto.randomUUID()}` };
}
```

Each tool result includes `dataAsOf` and `dataVersion` (the planner adds them). Every call also writes `audit_event(actor_type='mcp', action='mcp.<tool>')` in `withTenant` via an `onTool` hook in `main.ts`. Rate limit: 120 calls/min per user (Redis token bucket). **CI guard** (`apps/mcp/test/readonly.test.ts`): fails if any file under `apps/mcp/src` imports a path containing `/commands/`, and runs each tool against the golden DB inside a transaction that is rolled back, asserting `pg_stat_user_tables.n_tup_ins/upd/del` deltas are zero except `audit_event`.

`main.ts`: Fastify server, `POST /mcp` → `StreamableHTTPServerTransport` (stateless mode, one transport per request), `GET /healthz`. Deployed as Cloud Run service `mcp-readonly` with its own service account that has `SELECT`-only grants (`budget_mcp` role) — a second line of defence.

---

## 17. HTTP API (NestJS) — controller map

All routes prefixed `/api/v1`, JSON, zod-validated with `nestjs-zod` (`createZodDto`). OpenAPI generated to `apps/api/openapi.json` on build; the web app's client is generated from it with `openapi-typescript` + `openapi-fetch` into `apps/web/src/lib/api.ts`.

| Module | Routes | Command / Query |
|---|---|---|
| `registry` | `GET /workspaces/:ws/dimensions` · `POST /workspaces/:ws/dimensions` · `PATCH /dimensions/:id` · `POST /dimensions/:id/values` · `PATCH /values/:id` · `POST /values/:id/merge` · `GET/POST /workspaces/:ws/hierarchy-templates` · `GET/POST /workspaces/:ws/metrics` · `POST /assets` (SVG icon) | §8 |
| `query` | `POST /workspaces/:ws/query` (body `QueryRequest`) · `GET /workspaces/:ws/query/export` (async → job) | §6 |
| `envelopes` | `POST /workspaces/:ws/envelopes` · `GET /envelopes/:id?as_of=` · `PATCH /envelopes/:id` (metadata, `rowVersion` required) · `PATCH /envelopes/:id/draft` · `PATCH /envelopes/:id/phasing` · `POST /envelopes/:id/submit` · `POST /envelopes/:id/withdraw` · `POST /envelopes/:id/restore/:versionId` · `POST /envelopes/:id/move` · `POST /envelopes/:id/split` · `POST /envelopes/merge` · `GET /envelopes/:id/versions` · `GET /envelopes/:id/timeline` · `POST /envelopes/bulk` · `POST /envelopes/bulk/:previewId/commit` | §7 |
| `targets` | `GET /workspaces/:ws/targets?filter&metric` · `POST /workspaces/:ws/targets` · `PATCH /targets/:id/draft` · `POST /targets/:id/submit` · `GET /targets/:id/versions` · `POST /workspaces/:ws/targets/import` (Sheet range or CSV) | §10 |
| `approvals` | `GET /approvals?status&assignee=me&cursor` · `GET /approvals/:id` (with diff + context) · `POST /approvals/:id/decisions` · `POST /approvals/:id/external-evidence` · `POST /approvals/:id/withdraw` · `GET/POST /workspaces/:ws/policies` · `PATCH /policies/:id` | §9 |
| `pacing` | `GET /workspaces/:ws/pacing?filter&period` · `GET/POST /workspaces/:ws/rules` · `PATCH /rules/:id` · `GET /alerts?filter&status` · `PATCH /alerts/:id` | §11 |
| `search` | `GET /workspaces/:ws/search?q&types&limit` · `GET /workspaces/:ws/search/suggest?prefix` | §12 |
| `threads` | `GET /threads?anchorType&anchorId` · `POST /threads` · `POST /threads/:id/comments` · `PATCH /comments/:id` · `DELETE /comments/:id` · `POST /threads/:id/resolve` · `POST /threads/:id/reopen` · `POST /subscriptions` | §13 |
| `tags` | `GET/POST /workspaces/:ws/tags` · `PATCH /tags/:id` · `POST /tags/apply` · `DELETE /tags/apply` | §13 |
| `views` | `GET/POST /workspaces/:ws/saved-views` · `PATCH/DELETE /saved-views/:id` | |
| `sources` | `GET/POST /workspaces/:ws/sources` · `PATCH /sources/:id` · `POST /sources/:id/suggest-mapping` · `POST /sources/:id/run` · `GET /sources/:id/runs` · `GET /workspaces/:ws/unmatched-spend` · `POST /workspaces/:ws/unmatched-spend/map` · `POST /uploads` (CSV → GCS signed URL) | §14 |
| `closures` | `GET/POST /workspaces/:ws/closures` · `POST /closures/:id/restate` · `GET /closures/:id/report` | §15 |
| `exports` | `POST /exports` `{ kind: 'csv'|'xlsx'|'sheets', query }` → `{ jobId }` · `GET /exports/:jobId` | |
| `timeline` | `GET /workspaces/:ws/timeline?filter&groupBy&templateId&from&to&asOf&zoom&cursor&limit` | §23 |
| `naming` | `GET/POST /workspaces/:ws/naming-templates` · `PATCH /naming-templates/:id` · `POST /naming-templates/preview` | §24 |
| `experiments` | `GET/POST /workspaces/:ws/experiments` · `GET/PATCH /experiments/:id` · `POST /experiments/:id/link` · `POST /experiments/:id/{start,evaluate,abandon,conclude}` | §25 |
| `manual-entry` | `POST /workspaces/:ws/manual-entries` · `GET/PATCH /manual-entries/:id` · `POST /manual-entries/:id/submit` · `GET /workspaces/:ws/manual-entries?status` | §26 |
| `home` | `GET /me/home` · `GET /tours?role` · `POST /tours/:id/complete` · `POST /workspaces` `{ templateId, withDemoData }` · `POST /workspaces/:ws/demo-data/purge` | §27 |
| `admin` | `GET/POST /workspaces/:ws/roles` · `DELETE /roles/:id` · `POST /workspaces/:ws/groups/sync` · `GET /workspaces/:ws/audit?entityType&entityId&cursor` | |
| `auth` | `GET /me` (user, roles per workspace, permissions) | |

Every list endpoint: `?cursor=&limit=` (opaque base64url cursor), `X-Data-Version` and `X-Data-As-Of` response headers. Every mutating endpoint accepts `Idempotency-Key` (stored in Redis 24h; replay returns the original response).

---

## 18. Frontend (`apps/web`)

### 18.1 Routes (TanStack Router, file-based)

```
src/routes/
├─ __root.tsx                     # shell: nav, workspace switcher, <GlobalSearch/>, toasts
├─ w.$ws.tsx                      # loads /me + registry into context
├─ w.$ws.index.tsx                # Overview
├─ w.$ws.budgets.tsx              # Explorer (search params below)
├─ w.$ws.approvals.tsx / w.$ws.approvals.$id.tsx
├─ w.$ws.targets.tsx
├─ w.$ws.experiments.tsx / w.$ws.experiments.$id.tsx   # §25
├─ w.$ws.sources.manual.tsx        # manual result entry grid (§26)
├─ w.$ws.alerts.tsx
├─ w.$ws.search.tsx               # full results page
├─ w.$ws.closures.tsx
├─ w.$ws.sources.tsx
└─ w.$ws.admin.{registry,policies,rules,roles,tags,sources,naming,templates,tours}.tsx
```

Explorer search params are the source of truth for filter/granularity state:

```ts
// src/routes/w.$ws.budgets.tsx
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { FilterGroup, PeriodSpec, Grain } from '@budget/domain';

const ExplorerSearch = z.object({
  filter: FilterGroup.default({ logic: 'and', children: [] }),   // serialized with lz-string in the URL (see lib/filters.ts)
  groupBy: z.array(z.string()).default([]),
  templateId: z.string().uuid().optional(),
  measures: z.array(z.string()).default(['budget', 'actual', 'projected', 'pace_index']),
  targets: z.array(z.string()).default([]),
  period: PeriodSpec.default({ kind: 'relative', preset: 'current_quarter' }),
  grain: Grain.default('total'),
  asOf: z.string().datetime().optional(),
  view: z.enum(['tree', 'pivot', 'timeline']).default('tree'),   // timeline renders <TimelineView/> (§23) with the same search params
  zoom: z.enum(['week', 'month', 'quarter', 'fy']).default('month'),  // timeline only
  select: z.string().uuid().optional(),                         // opens the drawer
  savedViewId: z.string().uuid().optional(),
});
export const Route = createFileRoute('/w/$ws/budgets')({ validateSearch: ExplorerSearch, component: ExplorerPage });
```

### 18.2 Explorer grid (`@budget/grid` on Glide Data Grid)

`packages/grid` wraps `@glideapps/glide-data-grid` (`DataEditor`). Glide draws cells on canvas and asks us for a cell by `[col, row]`; it has editing overlays, selection, copy/paste and custom renderers built in. We provide the **row model**, the **tree/pivot shaping**, **budget cell renderers**, **editors** and **paste → bulk preview**. Nothing in `packages/grid` knows about HTTP; it takes a `RowSource` and callbacks.

```ts
// packages/grid/src/types.ts
import type { QueryRow, QueryResponse } from '@budget/domain';

export interface RowSource {
  /** Returns rows for [start, end) of the flattened, expanded tree. Must be stable for the same dataVersion. */
  getRows(range: { start: number; end: number }): Promise<{ rows: QueryRow[]; total: number; dataVersion: string }>;
  /** Expand/collapse a node; the source re-flattens and returns the new total row count. */
  toggle(nodeKey: string): Promise<{ total: number }>;
  subscribe(onInvalidate: () => void): () => void;              // called when dataVersion changes
}
export type ColumnSpec =
  | { kind: 'path'; width?: number }
  | { kind: 'measure'; key: 'budget' | 'actual' | 'projected' | 'variance_abs' | 'variance_pct' | 'remaining' | 'pace_index'; editable?: boolean }
  | { kind: 'target'; metric: string; field: 'target' | 'actual' | 'vsTargetPct'; editable?: boolean }
  | { kind: 'status' } | { kind: 'chips' } | { kind: 'dimension'; key: string }  // pivot column headers use 'dimension'
export interface GridEvents {
  onEdit(e: { row: QueryRow; column: ColumnSpec; value: string }): Promise<void>;     // throws DomainError('CONFLICT') → grid shows current value
  onPaste(e: { anchor: { row: number; col: number }; cells: string[][] }): void;        // caller opens <BulkPreviewDialog/>
  onSelect(row: QueryRow | null): void;
  onExpand?(row: QueryRow): void;
}
```

```tsx
// packages/grid/src/BudgetGrid.tsx  (sketch; keep these names)
import { DataEditor, GridCellKind, type GridCell, type Item, type EditableGridCell, CompactSelection } from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';

export function BudgetGrid({ source, columns, events, density = 'normal', pinnedTotals = 'top' }: BudgetGridProps) {
  const cache = useRowCache(source, { pageSize: 200, prefetch: 2 });         // LRU of pages keyed by start index; refetches visible pages on invalidate
  const rowHeight = density === 'compact' ? 28 : density === 'comfortable' ? 44 : 36;

  const getCellContent = useCallback(([col, row]: Item): GridCell => {
    const r = cache.get(row);                                             // undefined while loading → loading cell
    if (!r) return { kind: GridCellKind.Loading, allowOverlay: false };
    const c = columns[col]!;
    switch (c.kind) {
      case 'path':    return { kind: GridCellKind.Custom, allowOverlay: false, copyData: r.path.at(-1) ?? '', data: { kind: 'path', level: r.level, name: r.name, hasChildren: r.hasChildren, expanded: r.expanded, chips: r.chips } };
      case 'measure': return moneyOrPaceCell(r, c);                        // Custom cell 'money' (tabular, currency) or 'pace' (bar + tick)
      case 'target':  return targetCell(r, c);
      case 'status':  return { kind: GridCellKind.Custom, allowOverlay: false, copyData: r.status, data: { kind: 'status', status: r.status, pending: r.chips.pending } };
      case 'chips':   return { kind: GridCellKind.Custom, allowOverlay: false, copyData: '', data: { kind: 'chips', ...r.chips } };
      case 'dimension': return { kind: GridCellKind.Text, allowOverlay: false, data: r.dims[c.key] ?? '', displayData: r.dims[c.key] ?? '' };
    }
  }, [cache, columns]);

  const onCellEdited = useCallback(async ([col, row]: Item, newValue: EditableGridCell) => {
    const r = cache.get(row); const c = columns[col]!; if (!r || !('editable' in c) || !c.editable) return;
    await events.onEdit({ row: r, column: c, value: String((newValue as any).data) });   // caller does PATCH /envelopes/{id}/draft with basedOnVersionId
  }, [cache, columns, events]);

  return (
    <DataEditor
      columns={columns.map(toGlideColumn)} rows={cache.total}
      getCellContent={getCellContent} onCellEdited={onCellEdited}
      freezeColumns={1} rowHeight={rowHeight} headerHeight={40}
      customRenderers={[pathCellRenderer, moneyCellRenderer, paceCellRenderer, targetCellRenderer, statusCellRenderer, chipsCellRenderer]}
      onPaste={(target, values) => { events.onPaste({ anchor: { row: target[1], col: target[0] }, cells: values }); return false; }}   // never apply paste directly
      getCellsForSelection={true} rangeSelect="multi-rect" columnSelect="none" rowSelect="single"
      onGridSelectionChange={(sel) => events.onSelect(sel.current ? cache.get(sel.current.cell[1]) ?? null : null)}
      onCellClicked={([col, row]) => { const r = cache.get(row); if (col === 0 && r?.hasChildren) source.toggle(r.key).then(({ total }) => cache.setTotal(total)); }}
      keybindings={{ search: false }}                                   // ⌘K is the global search
      smoothScrollX smoothScrollY
      trailingRowOptions={pinnedTotals === 'bottom' ? { sticky: true } : undefined}
    />
  );
}
```

**Rules for `packages/grid`**
- Sorting, filtering and grouping are **server-side**: the grid never sorts arrays. Column header click → `events.onSort` → caller changes search params → new `RowSource`.
- The tree is a flattened, expanded list. `RowSource` (implemented in `apps/web/src/features/explorer/rowSource.ts`) keeps `expandedKeys` in the URL (`expanded=` param, lz-string) and requests `POST /workspaces/{ws}/query` per level with `withGroupPath()` (adds `eq` predicates for the expanded ancestors of a node); each page is 200 rows; `total` = number of flattened rows known so far (+1 while a cursor remains).
- Pivot view: the caller passes `columns` built from `QueryResponse.pivot.columns` (`kind: 'dimension'` headers + one `measure` column per pivot column) and a `RowSource` over `pivot.rows`. Same grid component.
- Pinned totals: `pinnedTotals='top'` renders a `<TotalsRow/>` DOM element above the canvas bound to `QueryResponse.totals`; `'bottom'` uses Glide's trailing row. Totals always come from the API.
- Editors: money (`Intl.NumberFormat` by currency, accepts `1.2M`, `1,200,000`, `1200000`), percent, date, dimension picker (Glide overlay editor with async search against `/dimensions/{id}/values?q=`), tag picker, text. Enter commits, Esc cancels, Tab moves right.
- Every custom cell sets `copyData` so copy produces TSV; paste never mutates directly, it always goes to `onPaste`.
- Accessibility: Glide's built-in keyboard navigation and screen-reader row/cell announcements; custom cells include `accessibilityString` (Glide prop) with path + amount + status.
- Benchmarks (`packages/grid/bench/`): 100k flattened rows × 12 columns, scroll 60 fps (`requestAnimationFrame` sampler asserts ≥ 55 fps p50), `getCellContent` < 0.2 ms p95, first paint < 300 ms with warm cache. Baseline committed in `bench/baseline.json`; CI fails on > 10% regression.

Inline edit → `PATCH /envelopes/{id}/draft` with `basedOnVersionId` from the row; `409 CONFLICT` shows the current value and a "reload row" action. Paste of a range → `POST /envelopes/bulk` with `op: 'paste'` and opens `<BulkPreviewDialog/>`.

### 18.3 Filter bar and serialization

`src/lib/filters.ts`: `encodeFilter(f: FilterGroupT): string` = `lz-string` `compressToEncodedURIComponent(JSON.stringify(f))`; `decodeFilter`. `<FilterBar/>` renders chips from `filter.children` (one chip per top-level predicate or group), an "Add filter" popover listing registry dimensions (with their icons) + fixed families from §11.2, operator pickers by field type, and an "Advanced" toggle showing the nested AST editor (`<FilterTree/>`). Date predicates use `<PeriodPicker/>` with tabs Fiscal / Range / Relative / As-of. Saved views: `POST /saved-views` with the current search params; loading one replaces the search params.

### 18.4 Global search

```tsx
// src/features/search/GlobalSearch.tsx  (cmdk)
export function GlobalSearch() {
  const [q, setQ] = useState(''); const parsed = useMemo(() => parseSearch(q), [q]);
  const { data } = useQuery({ queryKey: ['search', ws, q], queryFn: () => api.GET('/workspaces/{ws}/search', { params: { path: { ws }, query: { q, limit: 5 } } }), enabled: q.length >= 2, staleTime: 5_000 });
  const { data: suggest } = useQuery({ queryKey: ['suggest', ws, lastToken(q)], queryFn: () => api.GET('/workspaces/{ws}/search/suggest', { params: { path: { ws }, query: { prefix: lastToken(q) } } }), enabled: /[a-z_]+:[^\s]*$/i.test(q) });
  useHotkey(['meta+k', '/'], open);
  return (
    <Command.Dialog open={open} onOpenChange={setOpen} shouldFilter={false}>
      <Command.Input value={q} onValueChange={setQ} placeholder="Search envelopes, approvals, alerts… try country:BR status:pending" />
      <QualifierChips parsed={parsed} />
      <Command.List>
        {suggest?.data?.values.map(v => <Command.Item key={v} onSelect={() => setQ(replaceLastToken(q, v))}>{v}</Command.Item>)}
        {q.length < 2 && <Recents />}
        {data?.data?.groups.map(g => (
          <Command.Group key={g.type} heading={`${label(g.type)} · ${g.count}`}>
            {g.hits.map(h => <Command.Item key={h.id} onSelect={() => navigate({ to: h.deepLink })}><ResultRow hit={h} /></Command.Item>)}
            {g.count > g.hits.length && <Command.Item onSelect={() => navigate({ to: '/w/$ws/search', search: { q, type: g.type } })}>See all {g.count} in {label(g.type)} →</Command.Item>}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
```

### 18.5 Other features (each a folder under `src/features/`)

`approvals/` (Inbox list + `RequestDetail` with `DiffTable`, `ContextCards`, `DecisionTimeline`, `DecisionBar`), `targets/`, `alerts/` (table + `RuleEditor` reusing `<FilterBar/>` for scope), `threads/` (`ThreadPanel`, `CommentEditor` with TipTap mention/reference extensions posting canonical `@[user:id]` / `#[envelope:id]`), `registry/` (`DimensionList`, `DimensionForm` with `IconPicker` (Lucide grid + SVG upload), `ValueTree` (nested values, drag to re-parent), `HierarchyBuilder` (dnd-kit sortable path), `MetricLibrary`), `closures/`, `sources/` (`MappingWizard` with AI suggestions), `overview/`.

---

## 19. Workers, outbox publisher, notifications

`apps/workers/src/outbox-publisher.ts` (Cloud Run service, 1 instance min, loop every 500 ms): `SELECT id, topic, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED` → publish to Pub/Sub topic `budget-os.<topic>` with ordering key `workspace_id` → `UPDATE outbox SET published_at = now()`. Subscribers (push, Cloud Run): `rollup-worker` (`budget.changed`, `facts.loaded`, `registry.changed`), `search-indexer` (all), `notify-worker` (`alert.triggered`, `approval.changed`, `thread.changed`), BigQuery sink via Datastream (no code). All handlers idempotent on `outbox.id` (dedupe table `processed_event(consumer, outbox_id)`).

`rollup-worker`: for each affected envelope → ancestors per active template → recompute `measures` for those nodes with the planner (`groupBy` = template path up to the node's depth, filter = eq predicates for the node's path) → upsert `rollup_cache` with the current `data_version`. Full rebuild on `registry.changed` for a template.

`notify-worker`: Slack via `@slack/web-api` `chat.postMessage` with Block Kit (`blocks/alert.ts`, `blocks/approval.ts`, `blocks/mention.ts`), in-app via `notification(user_id, kind, payload, read_at)` table (added in `0003_functions`), email via Gmail API (Phase 2). Slack channel per workspace from `workspace.settings.slack.defaultChannel`, overridable per rule (`delivery.slackChannel`). All deep links `https://<host>/w/<ws>/...`.

---

## 20. Infrastructure

`infra/modules/cloudrun_service/main.tf` (used for `web`, `budget-api`, `mcp-readonly`, `search-indexer`, `rollup-worker`, `notify-worker`, `outbox-publisher`, `ingest-worker`):

```hcl
resource "google_cloud_run_v2_service" "svc" {
  name = var.name; location = var.region; ingress = var.internal ? "INGRESS_TRAFFIC_INTERNAL_ONLY" : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"  # workers: internal only; web/api/mcp: behind the IAP load balancer
  template {
    service_account = google_service_account.sa.email
    scaling { min_instance_count = var.min_instances; max_instance_count = var.max_instances }
    vpc_access { network_interfaces { network = var.network; subnetwork = var.subnet } egress = "PRIVATE_RANGES_ONLY" }
    containers {
      image = var.image
      resources { limits = { cpu = var.cpu, memory = var.memory } }
      dynamic "env" { for_each = var.env; content { name = env.key; value = env.value } }
      dynamic "env" { for_each = var.secret_env; content { name = env.key; value_source { secret_key_ref { secret = env.value; version = "latest" } } } }
      startup_probe { http_get { path = "/healthz" } }
    }
  }
}
resource "google_service_account" "sa" { account_id = "${var.name}-sa" }
```

`infra/modules/cloudsql`: `google_sql_database_instance` (POSTGRES_16, private IP only, `database_flags`: `cloudsql.iam_authentication=on`, `max_connections=400`, `shared_preload_libraries=pg_stat_statements`), PITR 7 days, 1 read replica in `prod`; users `budget_owner`, `budget_app`, `budget_mcp` with passwords in Secret Manager. `infra/modules/iap`: external HTTPS LB → IAP → Cloud Run `web` and `budget-api`; Identity Platform with Google Workspace as the only provider; `mcp-readonly` also behind IAP with OAuth client for MCP clients. `infra/modules/pubsub`: topics per outbox topic + push subscriptions with OIDC auth to the worker URLs, dead-letter topics. `infra/modules/bigquery`: dataset `budget_os_<env>`, Datastream from Cloud SQL (all Prisma tables + facts + audit), and the curated views from plan §6.2 as `google_bigquery_table` view definitions. Cloud Scheduler: `pacing-evaluator` job every 15 min, `ingest` per source cron, `groups-sync` every 15 min.

`Dockerfile` (multi-stage, shared by all Node apps via `--build-arg APP=api`):

```dockerfile
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
ARG APP
RUN pnpm turbo run build --filter=@budget/${APP}...
FROM node:22-alpine AS runtime
ARG APP
WORKDIR /repo
COPY --from=base /repo/apps/${APP}/dist ./dist
COPY --from=base /repo/apps/${APP}/package.json ./
COPY --from=base /repo/node_modules ./node_modules
ENV NODE_ENV=production PORT=8080
CMD ["node", "dist/main.js"]
```

`.github/workflows/ci.yml`: jobs `lint-typecheck`, `unit`, `integration` (services: postgres:16, redis:7; runs `pnpm db:migrate && pnpm db:seed && pnpm test`), `acceptance` (on `main` and `release/*`), `build-images` (Cloud Build via `google-github-actions/auth` WIF, tags `sha` + `env`), `deploy-dev` (auto), `deploy-staging` (auto after acceptance), `deploy-prod` (manual approval environment), `migrate` (Cloud Run Job `prisma migrate deploy`, runs before traffic shift; rollback = redeploy previous revision, migrations are forward-only and additive).

---

## 21. Testing and the golden dataset

`packages/db/seed/golden.ts` builds workspace `golden` deterministically (seeded PRNG): org defaults registry + 3 custom dimensions (`retailer`, `promo_wave`, `market_tier` with `asset:` icon), 2 hierarchy templates, 2 regions × 4 countries × 4 platforms × 3 objectives × 2 audiences leaves (= 192 leaves + parents), FY2026 periods, 3 approved versions per leaf across the year with realistic amounts, phasing, daily `spend_fact` and `kpi_fact` (conversions, revenue) for 270 days, projections from a simple linear formula (`formula_version='golden_v1'`), CPA targets on 50% of leaves and one filter-scoped ROAS target, 40 threads/120 comments, 8 tags, 12 pacing rules, 2 closed quarters, 300 audit events from real command execution (the seed calls the commands, never inserts versions directly). `golden.assertions.ts` exports the expected totals (per region/country/platform, per quarter, as-of three dates) used by planner, MCP and closure tests. `scripts/load-test.ts` scales the same generator ×500 (≈100k leaves) for the CI `load` job (nightly).

Acceptance tests (Vitest, `apps/api/test/acceptance/`), one file per epic `/goal`, named `epic-<id>.test.ts`; each test title quotes the `/goal` sentence it verifies. Playwright `apps/web/e2e/` covers: inline edit → conflict → reload; bulk paste → preview → commit → single request; filter chip → URL → reload → same rows; `⌘K` qualifier autocomplete → deep link; comment with mention → notification → timeline entry; registry: add dimension with SVG icon → appears in filter bar and search suggest within 10 s.

---

## 23. Timeline view and `@budget/timeline` (plan §4.11, §11.9)

### 23.1 Endpoint

`GET /workspaces/:ws/timeline?filter=&groupBy=&templateId=&from=&to=&asOf=&zoom=&cursor=&limit=` → `TimelineResponse` (in `@budget/domain/timeline.ts`). Same `FilterGroup` as `/query` (lz-string in the query string), same RLS, same `X-Data-Version` header. Implemented in `apps/api/src/modules/query/queries/timeline.query.ts` on top of the planner: it runs `compileQuery` at `grain='total'` for the group path to get the tree, then joins `envelope.start_date/end_date`, `envelope_phasing`, `target` + `target_version` (effective per date via `effective_target`), `experiment`, and markers from `audit_event`, `alert`, `period_closure`, `thread` within `[from, to]`.

```ts
// packages/domain/src/timeline.ts
export const TimelineBar = z.object({
  key: z.string(), parentKey: z.string().nullable(), level: z.number().int(),
  kind: z.enum(['group', 'envelope', 'target', 'experiment']),
  name: z.string(), path: z.array(z.string()),
  start: z.string().date(), end: z.string().date(),
  envelopeId: z.string().uuid().optional(), targetId: z.string().uuid().optional(), experimentId: z.string().uuid().optional(),
  metric: z.string().optional(),                                   // targets: 'budget' | 'cpa' | ...
  budget: z.string().optional(), actual: z.string().optional(), projected: z.string().optional(),   // Decimal strings, reporting currency
  spendPct: z.number().min(0).max(2).optional(), projectedPct: z.number().optional(), paceIndex: z.number().optional(),
  paceState: z.enum(['under', 'on', 'over', 'critical', 'none']).default('none'),
  status: z.string().optional(), hasChildren: z.boolean().default(false), expanded: z.boolean().default(false),
  lane: z.number().int().default(0),                               // stacked lane index for overlapping targets under one envelope
  markers: z.array(z.object({ kind: z.enum(['approval', 'alert', 'closure', 'comment', 'version']), at: z.string().date(), id: z.string(), severity: z.string().optional() })).default([]),
});
export const TimelineResponse = z.object({
  bars: z.array(TimelineBar), nextCursor: z.string().nullable(),
  calendar: z.object({ fiscalYearStartMonth: z.number().int().min(1).max(12), periods: z.array(z.object({ id: z.string(), kind: z.enum(['fy', 'quarter', 'month', 'week']), start: z.string().date(), end: z.string().date(), label: z.string() })), keyDates: z.array(z.object({ at: z.string().date(), label: z.string(), kind: z.enum(['holiday', 'client', 'closure']) })) }),
  dataVersion: z.string(), dataAsOf: z.string().datetime(), asOf: z.string().datetime().optional(),
});
```

### 23.2 Package `@budget/timeline`

Wraps `@svar-ui/react-gantt` (MIT core only). SVAR gives: virtualised task list + chart, hierarchical tasks, zoomable scales, progress fill, drag/resize (Phase 2), keyboard. We add: fiscal scales, custom bar templates, a **marker overlay** (markers are PRO in SVAR, so ours), the today line, the as-of scrubber, and a read-only mode.

```tsx
// packages/timeline/src/BudgetTimeline.tsx  (sketch; keep names)
import { Gantt, Willow } from '@svar-ui/react-gantt';                  // Willow = default theme; restyled via CSS vars from @budget/ui tokens
import '@svar-ui/react-gantt/all.css';

export function BudgetTimeline({ data, zoom, asOf, readOnly = true, onOpen, onToggle, onAsOfChange, onDragCommit }: Props) {
  const tasks = useMemo(() => data.bars.map(toSvarTask), [data]);      // { id: key, parent: parentKey ?? 0, text: name, start, end, progress: spendPct, type: kind, open: expanded, lazy: hasChildren && !expanded, data: bar }
  const scales = useMemo(() => fiscalScales(zoom, data.calendar), [zoom, data.calendar]);   // [{unit:'quarter', step:1, format: q => data.calendar label}, {unit:'month'...}, {unit:'week'...}] — quarter/FY labels come from calendar.periods, not the calendar month
  const columns = [{ id: 'text', header: 'Envelope', flexgrow: 1, template: PathCellTemplate }, { id: 'budget', header: 'Budget', align: 'right', template: MoneyTemplate }, { id: 'pace', header: 'Pace', template: PaceTemplate, width: 90 }];
  return (
    <div className="bt-root" data-readonly={readOnly}>
      <Willow>
        <Gantt tasks={tasks} scales={scales} columns={columns} cellWidth={cellWidthFor(zoom)} cellHeight={36}
               readonly={readOnly} taskTemplate={BarTemplate}          // BarTemplate draws fill (spendPct), projected tick (projectedPct), pace colour, hatching for experiments, thin bars for targets by `type`
               onTaskOpen={(id) => onToggle(id)}                       // lazy children → caller fetches next page with parent path and calls setTasks
               onSelectTask={(id) => onOpen(byKey(id))}
               {...(readOnly ? {} : { onUpdateTask: (e) => onDragCommit?.(e) })} />
      </Willow>
      <MarkerOverlay bars={data.bars} scale={useGanttScale()} />       // absolutely-positioned layer; uses the Gantt's exposed `scale.getX(date)` and row index → y; clusters markers < 6 px apart; click → onOpen(marker)
      <TodayLine scale={useGanttScale()} />
      <AsOfScrubber value={asOf} onChange={onAsOfChange} scale={useGanttScale()} />   // draggable handle in the header; commits on release → caller re-queries with asOf and passes new data
    </div>
  );
}
```

Rules: no `@svar/*` PRO import anywhere (CI license-check + an eslint `no-restricted-imports` rule); bars beyond the visible date range are not passed to SVAR (caller slices by `[from, to]`); target rows are always children of their envelope row with `type: 'target'` and are collapsed by default except the `budget` metric; the Timeline shares the Explorer's search params and `RowSource` cache so switching `view=tree` ↔ `view=timeline` does not refetch pages already loaded. Fallback (ADR-003): if the SVAR core cannot be made to render target lanes and our overlay reliably in the spike, implement `BudgetTimeline` on `vis-timeline` (groups = rows, items = bars) with the same props; screens do not change.

Benchmarks (`packages/timeline/bench/`): 5k bars render < 500 ms p95; pan/zoom ≥ 55 fps p50 on the CI runner profile.

### 23.3 Frontend

`apps/web/src/features/timeline/TimelineView.tsx` renders `<BudgetTimeline/>` from `ExplorerSearch` when `view='timeline'`; the filter bar, saved views and drawer are the same components as Explorer. `zoom` in the URL. Drawer opens on `onOpen` with `select=`.

---

## 24. Naming templates and match keys (plan §4.10)

### 24.1 Tables (hand-written migration `0004_naming`)

```sql
CREATE TABLE naming_template (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('display','match_key')),
  chips jsonb NOT NULL,              -- [{"type":"dimension","key":"country"},{"type":"separator","value":"_"},{"type":"text","value":"Q"},{"type":"period","format":"yyyy-QQ"}]
  casing text NOT NULL DEFAULT 'original' CHECK (casing IN ('original','lower','upper')),
  whitespace text NOT NULL DEFAULT 'keep' CHECK (whitespace IN ('keep','underscore','dash','remove')),
  strip_accents boolean NOT NULL DEFAULT false, version int NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE naming_template ENABLE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON naming_template USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
ALTER TABLE envelope ADD COLUMN display_name text, ADD COLUMN match_key text;
CREATE INDEX envelope_match_key_idx ON envelope (workspace_id, match_key);
ALTER TABLE spend_fact ADD COLUMN match_method text CHECK (match_method IN ('external_id','match_key','tuple','manual'));
ALTER TABLE kpi_fact  ADD COLUMN match_method text CHECK (match_method IN ('external_id','match_key','tuple','manual'));
ALTER TABLE data_source ADD COLUMN parse_pattern text;   -- optional regex with named groups (?<country>..)_(?<platform>..) applied to a source's campaign-name column
```

### 24.2 Rendering (`@budget/domain/naming.ts`)

```ts
export function renderTemplate(t: NamingTemplateT, ctx: { dims: Record<string, { code: string; label: string }>; period?: { start: string; end: string; fiscalLabel: string } }): string {
  const parts = t.chips.map(ch => ch.type === 'dimension' ? (t.kind === 'display' ? ctx.dims[ch.key]?.label : ctx.dims[ch.key]?.code) ?? ''
                              : ch.type === 'separator' || ch.type === 'text' ? ch.value
                              : ch.type === 'period' ? formatPeriod(ctx.period, ch.format) : '');
  let out = parts.join('');
  if (t.strip_accents) out = out.normalize('NFD').replace(/\p{M}/gu, '');
  out = t.casing === 'lower' ? out.toLowerCase() : t.casing === 'upper' ? out.toUpperCase() : out;
  out = t.whitespace === 'underscore' ? out.replace(/\s+/g, '_') : t.whitespace === 'dash' ? out.replace(/\s+/g, '-') : t.whitespace === 'remove' ? out.replace(/\s+/g, '') : out;
  return out;
}
```

`envelope.display_name` and `envelope.match_key` are recomputed by a `registry.changed` / `naming.changed` handler in `rollup-worker` (batch `UPDATE ... FROM` per workspace) and on envelope create/move. Display name is what the grid, search and Slack show; the dimension tuple stays the identity.

### 24.3 Matching order (replaces step 5 in §14 pipeline)

1. `external_id`: fact carries an ID mapped in `dimension_value.external_ids` → resolve tuple → match by tuple.
2. `match_key`: if the source has `parse_pattern`, extract dims from the name column; else if the fact row has a `match_key` column mapped, compare against `envelope.match_key` (case-insensitive).
3. `tuple`: the existing most-specific-subset SQL from §14.
4. Otherwise unmatched → queue; `POST /unmatched-spend/map` sets `match_method='manual'`.

Every matched fact stores `match_method`. Match coverage KPI = matched spend / total spend per run, exposed on `ingest_run.summary` and the Sources UI.

### 24.4 API and UI

`GET/POST /workspaces/:ws/naming-templates` · `PATCH /naming-templates/:id` (creates new `version`) · `POST /naming-templates/preview` `{ template, sampleEnvelopeIds[] }` → `{ previews: [{envelopeId, rendered}] }`. UI: `features/registry/NamingTemplateBuilder.tsx` — dnd-kit sortable chips (palette: dimensions with icons, separators `_ - : ·`, free text, period formats), casing/whitespace toggles, live preview of 5 sample envelopes.

---

## 25. Experiments (plan §4.12)

### 25.1 Tables (`0005_experiments`, Prisma-owned)

```prisma
model Experiment {
  id            String   @id @db.Uuid
  workspaceId   String   @map("workspace_id") @db.Uuid
  name          String
  hypothesis    String
  kind          ExperimentKind
  testFilter    Json     @map("test_scope_filter")      // FilterGroup
  controlFilter Json?    @map("control_scope_filter")   // FilterGroup | null
  primaryMetric String   @map("primary_metric_key")
  criterion     Json     @map("success_criterion")      // { comparator: 'lte'|'gte', value?: string, vs: 'control'|'absolute', minDays?: number }
  startDate     DateTime @map("start_date") @db.Date
  endDate       DateTime @map("end_date") @db.Date
  status        ExperimentStatus @default(PLANNED)
  ownerId       String   @map("owner_id") @db.Uuid
  decision      String?
  decidedBy     String?  @map("decided_by") @db.Uuid
  decidedAt     DateTime? @map("decided_at")
  createdAt     DateTime @default(now()) @map("created_at")
  envelopes     ExperimentEnvelope[]
  @@index([workspaceId, status]) @@map("experiment")
}
model ExperimentEnvelope { experimentId String @map("experiment_id") @db.Uuid; envelopeId String @map("envelope_id") @db.Uuid; role ExperimentRole; @@id([experimentId, envelopeId]) @@map("experiment_envelope") }
enum ExperimentKind { PLATFORM_TEST OBJECTIVE_TEST AUDIENCE_TEST CREATIVE_TEST GEO_HOLDOUT CUSTOM }
enum ExperimentStatus { PLANNED RUNNING EVALUATING CONCLUDED ABANDONED }
enum ExperimentRole { TEST CONTROL }
```
RLS policy as for every workspace table. Test envelopes get the system tag `experiment` on link.

### 25.2 Read-out

`GET /experiments/:id` returns `{ experiment, readout: { test: MetricSet, control: MetricSet | null, delta: { abs, pct } | null, criterionMet: boolean | null, daysRunning } }` where `MetricSet` = planner `compileQuery` at `grain='total'` over the filter with measures `budget, actual` and target metric derived from `spend_fact`/`kpi_fact` (CPA = spend / conversions, weighted). `criterionMet` is `null` until `minDays` elapsed.

### 25.3 Commands and rules

`POST /workspaces/:ws/experiments` · `PATCH /experiments/:id` · `POST /experiments/:id/link` `{ envelopeId, role }` · `POST /experiments/:id/start|evaluate|abandon` · `POST /experiments/:id/conclude` `{ decision }` — `decision` required (min 20 chars), creates a comment in a thread anchored to every linked envelope and audits `experiment.concluded`. Experiments appear as `kind:'experiment'` bars on the timeline (§23) and as the search qualifier `experiment:<status>` (§12 parser: add `experiment` to the qualifier table; entity type `experiment` indexed with name + hypothesis).

UI `features/experiments/`: list with status filter; detail with `ReadoutCards` (test vs control side by side), `CriterionBadge`, linked envelopes grid (reuses `<BudgetGrid/>` with a fixed filter), `ConcludeDialog`.

---

## 26. Manual result entry (plan §6.1)

### 26.1 Tables (`0006_manual_entry`, Prisma-owned)

```prisma
model ManualEntryBatch {
  id String @id @db.Uuid; workspaceId String @map("workspace_id") @db.Uuid
  channel String                       // dimension_value.code of `channel` (tv, ooh, dooh, print, radio, sponsorship, other)
  periodStart DateTime @map("period_start") @db.Date; periodEnd DateTime @map("period_end") @db.Date
  status ManualEntryStatus @default(DRAFT)      // DRAFT | SUBMITTED | APPROVED | REJECTED
  rows Json                             // [{ rowNo, dimensionValues, periodDate, currency, amount, kpis: {conversions?: string, ...}, note? }]
  totals Json                           // computed on save: { amount, byCurrency }
  approvalRequestId String? @map("approval_request_id") @db.Uuid
  createdBy String @map("created_by") @db.Uuid; createdAt DateTime @default(now()) @map("created_at"); submittedAt DateTime? @map("submitted_at")
  @@index([workspaceId, status]) @@map("manual_entry_batch")
}
enum ManualEntryStatus { DRAFT SUBMITTED APPROVED REJECTED }
```

### 26.2 Flow

`POST /workspaces/:ws/manual-entries` (draft) · `PATCH /manual-entries/:id` (rows; validated against registry like ingestion, invalid rows returned with reasons, batch cannot submit with invalid rows) · `POST /manual-entries/:id/submit` → creates an `approval_request` with `entity_type='manual_entry'` evaluated against policies whose `conditions.entity_type = 'manual_entry'` (add this to §9.1 conditions; default policy: 1 approval by role `finance` or `budget_owner` in scope). On approval, `manual_entry.approve` handler writes `spend_fact`/`kpi_fact` rows with `source_system='manual'`, `source_run_id = batch.id`, `match_method` per §24.3, lineage `{ enteredBy, approvedBy }` in a `manual_entry_fact` link table, then outbox `facts.loaded`. Rejection reopens the batch as DRAFT with the decision comment.

UI `features/manual-entry/`: `<BudgetGrid/>` in "entry" mode (editable text/money cells over a local `RowSource`), channel tabs (colours from `dimension_value` of `channel`), pinned totals, paste from clipboard, "Send for approval" button that is disabled with a visible `reason` ("2 rows have unknown market codes") — never silently disabled.

---

## 27. Home, tours and workspace templates (plan §11.7)

- **Home** (`features/home/`): `GET /me/home` → `{ waitingOnMe: { approvals[], mentions[], alerts[], unmatched: count }, scopes: [{ label, filter, budget, actual, projected, paceIndex }], recents[], pinnedViews[] }`. Scopes = top-level envelopes the user owns or has a role scope on. Renders in this order; each block links to its screen with filters preset.
- **Tours** (`lib/tours.ts`, driver.js): tour definitions are rows in `tour(id, workspace_id null|uuid, role, steps jsonb, version)`; steps `{ element: '[data-tour="filter-bar"]', title, description }`. Every tour target element carries a `data-tour` attribute. `tour_completion(user_id, tour_id, version, completed_at)` — `GET /tours?role=` returns tours not completed at current version; `POST /tours/:id/complete`. Org admins edit tours in `admin.tours`. Defaults seeded per role: planner, approver, finance, data_admin.
- **Workspace templates**: `POST /workspaces` `{ name, templateId, withDemoData: boolean }`. `workspace_template(id, name, registry jsonb, hierarchyTemplates jsonb, policies jsonb, rules jsonb, savedViews jsonb, tours jsonb)`; the `default_agency` template is seeded from `seed/defaults.*.ts`. `withDemoData` runs the small golden generator into the new workspace with `demo=true` on every row; `POST /workspaces/:ws/demo-data/purge` deletes them in one transaction.
- **Disabled-with-reason rule**: `@budget/ui` `<Button disabled reason="…">` renders a tooltip; eslint rule `budget/no-bare-disabled` fails on `disabled` without `reason`.

---

## 22. Task list (execute in order; one PR each)

| ID | Epic | Task | Files / commands | Done when |
|---|---|---|---|---|
| T-001 | 0.3 | Monorepo scaffold | root configs, `packages/*` skeletons, `docker-compose.yml`, CI `lint-typecheck` | `pnpm install && pnpm typecheck` green on empty packages |
| T-002 | 0.3 | Prisma schema + `0001_roles`, `0002_platform`, `0003_functions` migrations | §3.2, §3.3, `eligible_approver`, `effective_target`, `subscription`, `notification`, `processed_event`, `bulk_change` tables | `pnpm db:migrate` on fresh DB; RLS test: `budget_app` cannot read another workspace's envelope |
| T-003 | 0.3 | `@budget/domain`: errors, filter AST, query, permissions, approvals, search parser | §5, §9.1, §12.2 | 100% of zod schemas have round-trip tests; `parseSearch` table test (20 cases) |
| T-004 | 0.3 | `@budget/db`: `withTenant`, `audit`, `outbox`, `bumpDataVersion`, facts types | §3.4, §4 | Integration test proves `SET LOCAL` isolation across two concurrent transactions |
| T-005 | 0.4 | Registry module + defaults seed + icon upload | §8, `seed/defaults.registry.ts` | Epic 0.4 `/goal` acceptance test |
| T-006 | 0.3 | Golden dataset generator + assertions | §21 | `pnpm db:seed` < 60 s; assertions file committed |
| T-007 | 0.6 | Query planner (Postgres path) + tests | §6 | Planner test suite green incl. property tests |
| T-008 | 0.2 | Terraform `dev` + CI deploy of `budget-api` hello | §20 | `/healthz` reachable behind IAP in dev |
| T-009 | 1.2 | Auth (Identity Platform JWT), tenant interceptor, roles, scope guard, groups sync | §4, §5.4 | Permission matrix test: every role × action |
| T-010 | 1.1 | Envelope commands: create, draft version, phasing, restore, metadata edit w/ rowVersion | §7.1 | Conflict test returns 409 with `currentVersionId` |
| T-011 | 1.3 | Approval policies, matcher, submit, decide, escalate, external evidence | §7.2, §7.3, §9 | Epic 1.3 acceptance; cap trigger test |
| T-012 | 1.4 | Timeline + point-in-time endpoint | §9.4 | Replay test over golden history matches assertions |
| T-013 | 1.1b | Bulk preview/commit, paste, CSV round-trip | §7.4 | 10k rows < 10 s |
| T-014 | 1.1 | Move/split/merge with lineage | §7.5 | Cap re-validation test |
| T-015 | 1.1c | Targets module, metric library, `effective_target`, planner `targets[]` | §10, §6.2 | CPA roll-up equals spend/conversions at every level |
| T-016 | 1.5 | Outbox publisher + Pub/Sub + `processed_event` | §19 | Exactly-once test with duplicate delivery |
| T-017 | 1.5 | Ingestion pipeline + Snowflake/Sheets/BigQuery/CSV connectors + matching + unmatched API | §14 | ≥ 99% match on golden; rejected-rows report in GCS emulator |
| T-018 | 1.6 | Pacing evaluator job + alerts API + default rules seed | §11 | Consecutive-days test; no duplicate open alerts |
| T-019 | 1.7c | Threads, comments, mentions, tags, subscriptions | §13 | Blocking thread blocks submit; mention notifies |
| T-020 | 1.7b | Search indexer + search/suggest API | §12 | p95 < 150 ms at 1M docs (load job); index lag < 5 s |
| T-021 | 1.6 | notify-worker (Slack Block Kit + in-app) | §19 | Slack message snapshot tests |
| T-022 | 1.7 | rollup-worker + `rollup_cache` read path in planner (tree view) | §19, §6 | Tree totals == pivot totals on golden |
| T-023 | 1.8 | Exports (CSV/XLSX/Sheets), BigQuery curated views (Terraform) | §17 exports, §20 | Export respects filter; views queryable |
| T-024 | 1.9 | Closures + BigQuery closure tables + restate | §15 | Locked envelope rejects draft with 423 |
| T-025 | 1.10 | MCP server + read-only CI guard | §16 | All tools return golden numbers; guard test green |
| T-026 | 0.5 | Web shell, router, api client generation, design tokens hookup | §18.1 | Navigates all routes with auth |
| T-026a | 0.7 | **Spike:** `@budget/grid` on Glide Data Grid vs TanStack-only against large golden; write ADR-002 | `packages/grid/bench/`, `docs/adr/0002-grid-core.md` | Bench numbers recorded; ADR merged; decision reflected in `packages/grid/README.md` |
| T-026b | 0.8 | **Spike:** `@budget/timeline` on SVAR core vs vis-timeline vs custom canvas; write ADR-003 | `packages/timeline/bench/`, `docs/adr/0003-timeline-core.md` | 5k-bar bench recorded; target-lane + marker overlay proven; ADR merged |
| T-026c | 0.7 | `@budget/grid`: `RowSource`, page cache, path/money/pace/status/chips renderers, editors, paste → `onPaste`, pinned totals, bench + baseline | §18.2 | Bench ≥ 55 fps p50 at 100k rows; storybook for every cell kind; `license-check` green |
| T-027 | 1.7 | Explorer grid + filter bar + saved views + drawer (wire `@budget/grid` to `/query`) | §18.2, §18.3 | Playwright: filter → URL → reload; inline edit conflict flow; pivot totals == tree totals |
| T-028 | 1.7b | Global search UI + results page | §18.4 | Playwright qualifier autocomplete |
| T-029 | 1.3 | Approvals inbox + request detail + decision timeline UI | §18.5 | Playwright decide flow |
| T-030 | 1.1c / 1.7c | Targets UI, thread panel, comment editor, tag chips | §18.5 | Playwright mention flow |
| T-031 | 0.4 | Registry admin UI: dimension form, icon picker, value tree, hierarchy builder, metric library | §18.5 | Playwright add-dimension flow (< 10 s to appear in filters/search) |
| T-032 | 1.6 / 1.9 / 1.5 | Alerts UI + rule editor; Closures UI; Sources UI + mapping wizard | §18.5 | Each screen's acceptance test |
| T-033 | 1.11 | Overview dashboard | §18.5 | Renders < 1.5 s on golden |
| T-034 | 1.13 | Load suite (nightly) + Appendix C assertions | §21 | All NFR targets green at 100k leaves |
| T-036 | 1.7f | Naming templates + match keys: migration `0004_naming`, `renderTemplate`, recompute handler, matching order in ingest, API + builder UI | §24 | Preview endpoint renders 5 samples; `match_method` set on 100% of matched golden facts; coverage KPI on run summary |
| T-037 | 1.7d | `GET /timeline` query + `TimelineResponse`; `@budget/timeline` adapter (fiscal scales, bar templates, marker overlay, today line, as-of scrubber, read-only); `view=timeline` in Explorer | §23 | 5k bars < 500 ms p95; targets appear as lanes with correct effective target per date; as-of redraw matches `/query?asOf`; no `@svar/*` PRO import (eslint + license-check) |
| T-038 | 1.7g | Experiments: migration `0005`, commands, read-out query, timeline lane, search qualifier, UI | §25 | Weighted CPA test vs control equals planner numbers; conclude requires decision and posts thread comment |
| T-039 | 1.7e | Manual result entry: migration `0006`, batch commands, policy `entity_type='manual_entry'`, approve → facts, UI with channel tabs and reason-bearing disabled submit | §26 | Approved batch appears in `/query` actuals with `source_system='manual'` and lineage; rejected batch reopens as draft |
| T-040 | 1.7h | Home (`/me/home`), tours (driver.js, per-role defaults, completion), workspace templates + demo data purge, `no-bare-disabled` eslint rule | §27 | New workspace from template usable in < 60 s; each role's tour runs end-to-end in Playwright; eslint rule fails a bare `disabled` |
| T-041 | 1.7b | Settings search: index admin pages/options into `search_document` (`entity_type='setting'`) | §12, §27 | Typing a setting name in ⌘K opens the right admin page |
| T-035 | 1.12 | Pilot hardening: runbooks, alerts on SLOs, pen-test fixes, staging→prod promotion | `docs/runbooks/*.md` | Phase 1 exit criteria met |

Order of execution: T-001 → T-008, then T-026a/T-026b (spikes, week 1–2 of Phase 0), T-026c, T-009 → T-025, T-026, T-027 → T-034, T-036 → T-041, T-035. Phase 2 tasks (scenarios, formula envelopes, Slack thread bridge, digests, semantic search, timeline drag-edit and scenario overlays, webhooks, i18n) are specified in follow-up ADRs once Phase 1 exit criteria are met.

### 22.1 Task template (copy for any new task)

```
| T-0xx | <epic> | <imperative title> | <spec §, exact files or migration name> | <observable, automated check> |
```
A task is well-formed only if: it touches ≤ 12 files, names its migration (if any), cites one spec section, and its "Done when" can be asserted by a test that exists in the PR.
