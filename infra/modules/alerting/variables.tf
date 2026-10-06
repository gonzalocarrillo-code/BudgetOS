variable "project_id" {
  description = "GCP project the alert policies and notification channel live in."
  type        = string
  default     = "dmus-gonzalo"
}

variable "alert_email" {
  description = "Address the email notification channel sends to. Defaults to the owner's address used as SUPERADMIN_EMAIL in .github/workflows/deploy.yml."
  type        = string
  default     = "gonzalo.carrillo@deptagency.com"
}

variable "app_service_name" {
  description = "Cloud Run service name for the API (docs/runbooks/deploy.md, .github/workflows/deploy.yml)."
  type        = string
  default     = "budgetos-app"
}

variable "worker_service_name" {
  description = "Cloud Run service name for the always-on outbox worker (docs/runbooks/worker.md, ADR-0080)."
  type        = string
  default     = "budgetos-worker"
}

variable "migrate_job_name" {
  description = "Cloud Run job name for migrate+bootstrap (.github/workflows/deploy.yml)."
  type        = string
  default     = "budgetos-migrate"
}

variable "cloudsql_instance_id" {
  description = "Cloud SQL instance id, for the backup-failure log filter (infra/modules/cloudsql)."
  type        = string
  default     = "budgetos-db"
}

variable "outbox_max_attempts" {
  description = "Must match OUTBOX_MAX_ATTEMPTS (apps/workers/src/local-runner.ts default 8, unset in deploy.yml today). The dead-letter alert matches the shared 'outbox row failed' log line at this attempt count, since the worker does not yet log a dead-letter event distinctly from an ordinary retry (see module README 'Assumptions')."
  type        = number
  default     = 8
}

variable "worker_absent_duration" {
  description = "How long budgetos-worker's instance-count metric may go unreported before the zero-instance alert fires (ADR-0080: the worker must always run exactly one instance)."
  type        = string
  default     = "900s"
}

variable "auto_close_duration" {
  description = "Cloud Monitoring auto-closes an incident that stops matching after this long (all six policies)."
  type        = string
  default     = "604800s"
}
