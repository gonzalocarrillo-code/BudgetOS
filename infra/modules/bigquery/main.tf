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
