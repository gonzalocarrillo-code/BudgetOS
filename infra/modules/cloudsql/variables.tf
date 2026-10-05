variable "project_id" {
  description = "GCP project that holds the instance and the uploads bucket."
  type        = string
  default     = "dmus-gonzalo"
}

variable "region" {
  description = "Cloud SQL region."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Primary zone for the ZONAL instance (settings.location_preference.zone)."
  type        = string
  default     = "us-central1-a"
}

variable "instance_name" {
  description = "Cloud SQL instance id."
  type        = string
  default     = "budgetos-db"
}

variable "database_name" {
  description = "The application database inside the instance (spec §2)."
  type        = string
  default     = "budget"
}

variable "database_version" {
  type    = string
  default = "POSTGRES_16"
}

variable "tier" {
  description = "Machine type. Live value as of 2026-10-05; resize needs an ADR (AGENTS §4: pinned versions)."
  type        = string
  default     = "db-g1-small"
}

variable "edition" {
  description = "Postgres 16 defaults to ENTERPRISE_PLUS when unset; pinned explicitly to the live value so this module does not drift the instance on first apply."
  type        = string
  default     = "ENTERPRISE"
}

variable "availability_type" {
  type    = string
  default = "ZONAL"
}

variable "disk_type" {
  type    = string
  default = "PD_SSD"
}

variable "disk_size_gb" {
  type    = number
  default = 10
}

variable "disk_autoresize" {
  type    = bool
  default = true
}

variable "backup_start_time" {
  description = "HH:MM, UTC. Live value."
  type        = string
  default     = "07:00"
}

variable "transaction_log_retention_days" {
  description = "Required for point-in-time recovery; 1-7 days on this edition."
  type        = number
  default     = 7
}

variable "retained_backups" {
  description = "Hardening (B-1): raised from the live value of 7 to 35 daily backups."
  type        = number
  default     = 35
}

variable "deletion_protection" {
  description = "Hardening (B-1): the live instance has this off. Guards both the Terraform resource and the GCP-level flag (settings.deletion_protection_enabled)."
  type        = bool
  default     = true
}

variable "ipv4_enabled" {
  description = "Public IP stays on for now; migrating to private IP + a VPC is out of scope for this change (see README)."
  type        = bool
  default     = true
}

variable "uploads_bucket_name" {
  type    = string
  default = "dmus-gonzalo-budgetos-uploads"
}

variable "uploads_bucket_location" {
  description = "Live location (read with `gcloud storage buckets describe`, 2026-10-05): a single region, not a multi-region."
  type        = string
  default     = "US-CENTRAL1"
}

variable "uploads_bucket_soft_delete_retention_seconds" {
  description = "Live value: 7 days. Kept as-is; versioning + lifecycle below are the new, durable protection (B-4)."
  type        = number
  default     = 604800
}

variable "exports_prefix_lifecycle_days" {
  description = "ADR-017: exports/ objects in the uploads bucket are deleted after this many days."
  type        = number
  default     = 7
}

variable "noncurrent_version_lifecycle_days" {
  description = "Days a non-current (versioned) object is kept after it stops being current."
  type        = number
  default     = 30
}

variable "labels" {
  type    = map(string)
  default = { app = "budget-os" }
}
