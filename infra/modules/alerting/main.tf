# Cloud Monitoring alerting for Budget OS on dmus-gonzalo (docs/STACK_AUDIT_2026-10-04.md M-7
# "alerting" half; docs/STACK_HARDENING_PLAN.md W5-8; ADR-0080). Six log-based or metric-based
# alert policies, one email notification channel, auto-close after 7 days. See README.md for the
# exact log lines each policy matches and why, and for what is NOT covered yet (a worker-emitted
# outbox-backlog gauge is a follow-up, tracked separately — see README "Follow-up").

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

# --- Notification channel ------------------------------------------------------------------------

resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "Budget OS owner (email)"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

# Optional Slack channel. Uncomment once a Slack incoming webhook (or the Monitoring-Slack OAuth
# integration) exists for an ops channel; this is independent of the Budget OS app's own Slack
# toolset (ADR-063), which posts notifications to end users, not infra alerts to the team.
#
# 1. In Slack: add the "Google Cloud Monitoring" app to the target channel (Monitoring console ->
#    Alerting -> Edit notification channels -> Slack -> Configure new Slack channel), which hands
#    back an auth token Terraform cannot read back out of the API afterwards.
# 2. Store that token somewhere Terraform can read it at apply time (a Secret Manager secret, or a
#    `TF_VAR_slack_auth_token` kept out of version control) and fill in `auth_token` below.
# 3. Uncomment, set `labels.channel_name` to the channel (e.g. "#budgetos-alerts"), and add this
#    channel's id to every alert policy's `notification_channels` list below.
#
# resource "google_monitoring_notification_channel" "slack" {
#   project      = var.project_id
#   display_name = "Budget OS alerts (Slack)"
#   type         = "slack"
#   labels = {
#     channel_name = "#budgetos-alerts"
#   }
#   sensitive_labels {
#     auth_token = var.slack_auth_token
#   }
# }

locals {
  notification_channels = [google_monitoring_notification_channel.email.id]
  runbook_note          = "Runbook: docs/runbooks/deploy.md \"When something fails\" and docs/runbooks/worker.md. See infra/modules/alerting/README.md for what this policy means and what to do."
}

# --- (a) Worker consumer failures ------------------------------------------------------------------
# The exact pino `msg` strings local-runner.ts's runRow() emits at `log.error` (docs/runbooks/worker.md):
# per-consumer-family failure ("local worker consumer failed") and the row-level summary once any
# family failed ("outbox row failed; ..."). Either means a workspace's ingest/roll-up/search/notify/
# export event did not complete on this pass; it will retry on backoff unless it has already
# dead-lettered (see (b) below).

resource "google_logging_metric" "worker_consumer_failures" {
  project     = var.project_id
  name        = "budgetos_worker_consumer_failures"
  description = "Count of budgetos-worker consumer-family failures (M-7). docs/runbooks/worker.md."
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${var.worker_service_name}"
    severity>=ERROR
    jsonPayload.msg=~"local worker consumer failed|outbox row failed"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "worker_consumer_failures" {
  project      = var.project_id
  display_name = "Budget OS worker: consumer failures"
  combiner     = "OR"

  conditions {
    display_name = "> 0 consumer failures in 10 minutes"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.worker_consumer_failures.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "600s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }

  notification_channels = local.notification_channels
  documentation {
    content   = "An outbox consumer (ingest, roll-up, search, notify-in-app, notify-Slack or export) threw on budgetos-worker. The row stays unpublished and retries with backoff unless it has reached OUTBOX_MAX_ATTEMPTS, in which case the dead-letter alert also fires. ${local.runbook_note}"
    mime_type = "text/markdown"
  }
  alert_strategy {
    auto_close = var.auto_close_duration
  }
}

# --- (b) Outbox dead-letters ------------------------------------------------------------------------
# The worker does not (yet) log a dead-letter event distinctly from an ordinary retry failure — both
# share the "outbox row failed; ..." msg (apps/workers/src/local-runner.ts runRow()); only the
# `attempts` field distinguishes them, set to markLocalFailure's post-increment count
# (packages/db/src/outbox.ts). A row dead-letters (failed_at set) exactly when that count reaches
# OUTBOX_MAX_ATTEMPTS, so this metric matches the same msg with jsonPayload.attempts at or past that
# threshold. See README "Assumptions".

resource "google_logging_metric" "outbox_dead_letters" {
  project     = var.project_id
  name        = "budgetos_outbox_dead_letters"
  description = "Approximates outbox rows that just dead-lettered (failed_at set) on budgetos-worker (M-7, B-2). See README Assumptions."
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${var.worker_service_name}"
    severity>=ERROR
    jsonPayload.msg="outbox row failed; consumers that succeeded are kept (processed_event dedupe), the rest retry with backoff"
    jsonPayload.attempts>=${var.outbox_max_attempts}
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "outbox_dead_letters" {
  project      = var.project_id
  display_name = "Budget OS worker: outbox dead-letters"
  combiner     = "OR"

  conditions {
    display_name = "> 0 dead-lettered outbox rows in 1 hour"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.outbox_dead_letters.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }

  notification_channels = local.notification_channels
  documentation {
    content   = "An outbox row hit OUTBOX_MAX_ATTEMPTS and stopped retrying (failed_at set). List and replay it per docs/runbooks/worker.md \"Listing dead-lettered rows\" / \"Replaying a dead-lettered row\" — check last_error before replaying, a row failing the same way every time needs a data/code fix first. ${local.runbook_note}"
    mime_type = "text/markdown"
  }
  alert_strategy {
    auto_close = var.auto_close_duration
  }
}

# --- (c) API 5xx --------------------------------------------------------------------------------

resource "google_logging_metric" "api_5xx" {
  project     = var.project_id
  name        = "budgetos_api_5xx"
  description = "Count of 5xx responses from budgetos-app (M-7)."
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${var.app_service_name}"
    httpRequest.status>=500
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "api_5xx" {
  project      = var.project_id
  display_name = "Budget OS API: 5xx responses"
  combiner     = "OR"

  conditions {
    display_name = "> 5 5xx responses in 5 minutes"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.api_5xx.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }

  notification_channels = local.notification_channels
  documentation {
    content   = "budgetos-app answered more than 5 requests with a 5xx in 5 minutes. Pull the shared requestId from a sample response's X-Request-Id header or error body and grep Cloud Logging for it (docs/runbooks/deploy.md \"Logs\"). ${local.runbook_note}"
    mime_type = "text/markdown"
  }
  alert_strategy {
    auto_close = var.auto_close_duration
  }
}

# --- (d) Migrate job failure ---------------------------------------------------------------------

resource "google_logging_metric" "migrate_job_failures" {
  project     = var.project_id
  name        = "budgetos_migrate_job_failures"
  description = "Count of ERROR+ log lines from the budgetos-migrate Cloud Run job (M-7)."
  filter      = <<-EOT
    resource.type="cloud_run_job"
    resource.labels.job_name="${var.migrate_job_name}"
    severity>=ERROR
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "migrate_job_failures" {
  project      = var.project_id
  display_name = "Budget OS migrate job: failure"
  combiner     = "OR"

  conditions {
    display_name = "> 0 ERROR+ log lines in 5 minutes"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_job\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.migrate_job_failures.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }

  notification_channels = local.notification_channels
  documentation {
    content   = "budgetos-migrate (prisma migrate deploy + bootstrap.ts) logged an error. A failed migrate blocks that deploy's app/slack/worker rollout. `gcloud run jobs executions list --job ${var.migrate_job_name} --region us-central1 --project ${var.project_id}`, then that execution's logs (docs/runbooks/deploy.md \"When something fails\"); for a partial failure or rollback see docs/runbooks/restore.md (d). ${local.runbook_note}"
    mime_type = "text/markdown"
  }
  alert_strategy {
    auto_close = var.auto_close_duration
  }
}

# --- (e) Cloud SQL backup failure -----------------------------------------------------------------
# No built-in Cloud Monitoring metric reports backup success/failure directly as of this module
# (the closest built-ins, e.g. cloudsql.googleapis.com/database/disk/*, describe disk usage, not
# backup outcomes); the log filter below is the documented way to catch a failed automated backup.

resource "google_logging_metric" "cloudsql_backup_failures" {
  project     = var.project_id
  name        = "budgetos_cloudsql_backup_failures"
  description = "Count of ERROR+ Cloud SQL audit log entries whose method mentions backup, for ${var.cloudsql_instance_id} (B-1)."
  filter      = <<-EOT
    resource.type="cloudsql_database"
    resource.labels.database_id="${var.project_id}:${var.cloudsql_instance_id}"
    protoPayload.methodName=~"backup"
    severity>=ERROR
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "cloudsql_backup_failures" {
  project      = var.project_id
  display_name = "Budget OS Cloud SQL: backup failure"
  combiner     = "OR"

  conditions {
    display_name = "> 0 backup-related errors in 1 hour"
    condition_threshold {
      filter          = "resource.type=\"cloudsql_database\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.cloudsql_backup_failures.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }

  notification_channels = local.notification_channels
  documentation {
    content   = "An automated Cloud SQL backup for ${var.cloudsql_instance_id} logged an error. Check Cloud SQL -> Backups in the console, and take a manual one now (`gcloud sql backups create --instance ${var.cloudsql_instance_id} --project ${var.project_id}`) until the automated one is confirmed healthy; see infra/modules/cloudsql/README.md and docs/runbooks/restore.md. ${local.runbook_note}"
    mime_type = "text/markdown"
  }
  alert_strategy {
    auto_close = var.auto_close_duration
  }
}

# --- (f) Worker instance count 0 ------------------------------------------------------------------
# ADR-0080: budgetos-worker runs --min-instances 1 --max-instances 1, always on. A metric-absence
# condition on its own instance-count series is the standard way to alert "this service has no
# running instances": Cloud Run stops reporting the series for a revision with zero instances,
# rather than reporting an explicit zero, so a threshold condition would never fire — only an
# absence condition does.

resource "google_monitoring_alert_policy" "worker_zero_instances" {
  project      = var.project_id
  display_name = "Budget OS worker: zero instances"
  combiner     = "OR"

  conditions {
    display_name = "No instance-count data for ${var.worker_service_name} for ${var.worker_absent_duration}"
    condition_absent {
      filter   = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.worker_service_name}\" AND metric.type=\"run.googleapis.com/container/instance_count\""
      duration = var.worker_absent_duration
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = local.notification_channels
  documentation {
    content   = "${var.worker_service_name} has reported no running instances for ${var.worker_absent_duration}. It must always run exactly one instance (ADR-0080 Decision D-3) — the outbox stops draining entirely while this is true (I-1 silent loss, dead-letters pile up). Check the service's revision status and recent deploys; redeploy or scale it back up. ${local.runbook_note}"
    mime_type = "text/markdown"
  }
  alert_strategy {
    auto_close = var.auto_close_duration
  }
}
