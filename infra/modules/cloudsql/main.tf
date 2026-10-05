# Budget OS production Cloud SQL + uploads bucket (docs/STACK_AUDIT_2026-10-04.md B-1, B-4; ADR-065,
# ADR-017). Both were created once by hand (docs/runbooks/deploy.md "One-time setup") and never put
# under Terraform. This module adopts them via the `import` blocks below instead of recreating them,
# and layers the hardening the audit asked for: point-in-time recovery, more retained backups,
# deletion protection, and a versioned/lifecycle-managed uploads bucket. See README.md for the
# import procedure, what stays unchanged (ZONAL, db-g1-small, public IP) and why.

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

resource "google_sql_database_instance" "budgetos_db" {
  project             = var.project_id
  name                = var.instance_name
  region              = var.region
  database_version    = var.database_version
  deletion_protection = var.deletion_protection

  settings {
    tier                        = var.tier
    edition                     = var.edition
    availability_type           = var.availability_type
    disk_type                   = var.disk_type
    disk_size                   = var.disk_size_gb
    disk_autoresize             = var.disk_autoresize
    deletion_protection_enabled = var.deletion_protection
    user_labels                 = var.labels

    location_preference {
      zone = var.zone
    }

    ip_configuration {
      ipv4_enabled = var.ipv4_enabled
      # No private_network: the instance is public-IP only today. See README "Private IP" note —
      # out of scope for this change, tracked for a later item.
    }

    backup_configuration {
      enabled                        = true
      start_time                     = var.backup_start_time
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = var.transaction_log_retention_days

      backup_retention_settings {
        retained_backups = var.retained_backups
        retention_unit   = "COUNT"
      }
    }
  }

  lifecycle {
    # The instance was hand-created; nothing here should force a replacement. If a future plan
    # wants to change database_version or region, that is a deliberate migration, not an accident.
    prevent_destroy = true
  }
}

resource "google_sql_database" "budget" {
  project  = var.project_id
  instance = google_sql_database_instance.budgetos_db.name
  name     = var.database_name
}

# NOTE: `import` blocks for these two resources live in the ROOT module
# (infra/envs/dmus-gonzalo/main.tf), not here — Terraform refuses an `import` block inside a child
# module ("Import blocks are only allowed in the root module"). This module stays importable from
# any root; infra/envs/dmus-gonzalo is the one root that actually does it for dmus-gonzalo.

# ---------------------------------------------------------------------------------------------
# Uploads bucket (B-4): manual entry attachments and exports (ADR-017). Hand-created with uniform
# access, enforced public-access prevention and a 7-day soft-delete policy; it had no versioning
# and no lifecycle rules until now.
# ---------------------------------------------------------------------------------------------

resource "google_storage_bucket" "uploads" {
  project                     = var.project_id
  name                        = var.uploads_bucket_name
  location                    = var.uploads_bucket_location
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  soft_delete_policy {
    retention_duration_seconds = var.uploads_bucket_soft_delete_retention_seconds
  }

  versioning {
    enabled = true
  }

  # ADR-017: exports/ objects (CSV/XLSX generated for download) are disposable; delete after a week
  # regardless of version state.
  lifecycle_rule {
    condition {
      age            = var.exports_prefix_lifecycle_days
      matches_prefix = ["exports/"]
    }
    action {
      type = "Delete"
    }
  }

  # New: with versioning on, a replaced/deleted object's old version would otherwise be kept
  # forever. Purge non-current versions after 30 days.
  lifecycle_rule {
    condition {
      age        = var.noncurrent_version_lifecycle_days
      with_state = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

# See the note above google_sql_database "budget": this resource's `import` block is in the root
# module too.
