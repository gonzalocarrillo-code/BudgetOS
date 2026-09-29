# Budget OS BigQuery (spec §20, plan §6.2). The dataset budget_os_<env> is the Datastream target for
# every Prisma table, the facts and the audit log (the Datastream stream is phase 20); this module
# owns the dataset and the curated views analysts and Looker read. The view SQL lives in views/ and
# is checked against the Postgres schema by packages/db/src/bigquery-views.test.ts (ADR-017).

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

locals {
  dataset_id = "budget_os_${var.env}"

  # Views over replica tables only. Views that read another view are in derived_views.
  views = {
    v_budget_current = "Current approved budget per envelope, own and reporting currency, with is_leaf."
    v_approvals      = "Approval requests with their latest decision and decision count."
    v_closures       = "Period closures with their fiscal period and closure table."
    v_snapshots      = "Snapshots saved by hand, one row per budget per snapshot (ADR-053)."
  }

  derived_views = {
    v_budget_vs_actual_daily = "Matched daily spend per envelope with actual to date and remaining budget (reporting currency)."
  }
}

resource "google_bigquery_dataset" "budget_os" {
  project     = var.project_id
  dataset_id  = local.dataset_id
  location    = var.location
  description = "Budget OS replica (Datastream) and curated views."
  labels      = { app = "budget-os", env = var.env }
}

resource "google_bigquery_table" "view" {
  for_each            = local.views
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.budget_os.dataset_id
  table_id            = each.key
  description         = each.value
  deletion_protection = false

  view {
    query          = templatefile("${path.module}/views/${each.key}.sql", { project = var.project_id, dataset = local.dataset_id })
    use_legacy_sql = false
  }
}

resource "google_bigquery_table" "derived_view" {
  for_each            = local.derived_views
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.budget_os.dataset_id
  table_id            = each.key
  description         = each.value
  deletion_protection = false
  depends_on          = [google_bigquery_table.view]

  view {
    query          = templatefile("${path.module}/views/${each.key}.sql", { project = var.project_id, dataset = local.dataset_id })
    use_legacy_sql = false
  }
}

resource "google_bigquery_dataset_iam_member" "readers" {
  for_each   = toset(var.reader_groups)
  project    = var.project_id
  dataset_id = google_bigquery_dataset.budget_os.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "group:${each.value}"
}

# ---------------------------------------------------------------------------------------------
# Per-workspace access (docs/DATA_PLAN.md §8.2, D-014). BigQuery has no row-level security like
# Postgres RLS, and the replica holds every tenant. Nobody outside the app reads the base dataset:
# `reader_groups` is for the platform's own data team only. A client's analysts and Looker read a
# dataset of their own, whose views select one workspace's rows from the curated views and are
# authorized on the base dataset, so they never need (or get) access to it.
# ---------------------------------------------------------------------------------------------

locals {
  curated_views = concat(keys(local.views), keys(local.derived_views))
  workspace_views = {
    for pair in setproduct(keys(var.workspace_readers), local.curated_views) : "${pair[0]}.${pair[1]}" => { workspace = pair[0], view = pair[1] }
  }
  workspace_members = merge([
    for key, w in var.workspace_readers : { for g in w.groups : "${key}.${g}" => { workspace = key, group = g } }
  ]...)
}

resource "google_bigquery_dataset" "workspace" {
  for_each    = var.workspace_readers
  project     = var.project_id
  dataset_id  = "${local.dataset_id}_ws_${each.key}"
  location    = var.location
  description = "Budget OS ${var.env}: workspace ${each.value.workspace_id} only (authorized views)."
  labels      = { app = "budget-os", env = var.env, scope = "workspace" }
}

resource "google_bigquery_table" "workspace_view" {
  for_each            = local.workspace_views
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.workspace[each.value.workspace].dataset_id
  table_id            = each.value.view
  description         = "One workspace's rows of ${each.value.view}."
  deletion_protection = false
  depends_on          = [google_bigquery_table.view, google_bigquery_table.derived_view]

  view {
    query          = "SELECT * FROM `${var.project_id}.${local.dataset_id}.${each.value.view}` WHERE workspace_id = '${var.workspace_readers[each.value.workspace].workspace_id}'"
    use_legacy_sql = false
  }
}

# Each per-workspace view may read the base dataset on its readers' behalf.
resource "google_bigquery_dataset_access" "authorized_view" {
  for_each   = google_bigquery_table.workspace_view
  project    = var.project_id
  dataset_id = google_bigquery_dataset.budget_os.dataset_id
  view {
    project_id = var.project_id
    dataset_id = each.value.dataset_id
    table_id   = each.value.table_id
  }
}

resource "google_bigquery_dataset_iam_member" "workspace_readers" {
  for_each   = local.workspace_members
  project    = var.project_id
  dataset_id = google_bigquery_dataset.workspace[each.value.workspace].dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "group:${each.value.group}"
}
