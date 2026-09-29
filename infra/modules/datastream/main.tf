# Budget OS → BigQuery replication (docs/DATA_PLAN.md §1, D-001; plan §6.2 "Datastream CDC").
# Postgres (Cloud SQL, private IP) stays the system of record. This stream copies every table the
# publication in setup.sql covers into the dataset the bigquery module owns (budget_os_<env>), so
# the curated views, the ADR-042 warehouse routing and the fact retention job (D-002) read real
# rows. BigQuery is never written by the app: replication is its only writer.

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
  stream_id = "budget-os-${var.env}"
  # Transient or internal tables that never leave Postgres. Everything else replicates.
  excluded_tables = ["outbox", "processed_event", "_prisma_migrations"]
}

# Private connectivity: Datastream peers into the VPC Cloud SQL's private IP lives in.
resource "google_datastream_private_connection" "vpc" {
  project               = var.project_id
  location              = var.region
  private_connection_id = "${local.stream_id}-vpc"
  display_name          = "Budget OS ${var.env} VPC"
  vpc_peering_config {
    vpc    = var.vpc_id
    subnet = var.peering_cidr
  }
}

resource "google_datastream_connection_profile" "postgres" {
  project               = var.project_id
  location              = var.region
  connection_profile_id = "${local.stream_id}-postgres"
  display_name          = "Budget OS ${var.env} Postgres"

  postgresql_profile {
    hostname = var.postgres_private_ip
    port     = 5432
    database = var.database
    username = var.replication_user
    # The replication user's password, from Secret Manager (AGENTS §4: no secrets in code).
    password = data.google_secret_manager_secret_version.replication_password.secret_data
  }

  private_connectivity {
    private_connection = google_datastream_private_connection.vpc.id
  }
}

data "google_secret_manager_secret_version" "replication_password" {
  project = var.project_id
  secret  = var.replication_password_secret
}

resource "google_datastream_connection_profile" "bigquery" {
  project               = var.project_id
  location              = var.region
  connection_profile_id = "${local.stream_id}-bigquery"
  display_name          = "Budget OS ${var.env} BigQuery"
  bigquery_profile {}
}

resource "google_datastream_stream" "replica" {
  project       = var.project_id
  location      = var.region
  stream_id     = local.stream_id
  display_name  = "Budget OS ${var.env} → BigQuery"
  desired_state = "RUNNING"

  source_config {
    source_connection_profile = google_datastream_connection_profile.postgres.id
    postgresql_source_config {
      # Created once by setup.sql; the names must match.
      publication      = "budget_os_datastream"
      replication_slot = "budget_os_datastream"
      include_objects {
        postgresql_schemas {
          schema = "public"
        }
      }
      exclude_objects {
        postgresql_schemas {
          schema = "public"
          dynamic "postgresql_tables" {
            for_each = local.excluded_tables
            content {
              table = postgresql_tables.value
            }
          }
        }
      }
    }
  }

  destination_config {
    destination_connection_profile = google_datastream_connection_profile.bigquery.id
    bigquery_destination_config {
      # Minutes, not seconds: the replica feeds analytics and history, not the live app.
      data_freshness = var.data_freshness
      single_target_dataset {
        dataset_id = "${var.project_id}:${var.dataset_id}"
      }
    }
  }

  # Every existing row first, then changes as they happen.
  backfill_all {}
}
