variable "project_id" {
  description = "GCP project that holds the dataset."
  type        = string
}

variable "env" {
  description = "Environment name (dev, staging, prod); the dataset is budget_os_<env>."
  type        = string
}

variable "location" {
  description = "BigQuery location of the dataset."
  type        = string
  default     = "US"
}

variable "reader_groups" {
  description = "Google groups (email) that read the curated views: analysts, Looker."
  type        = list(string)
  default     = []
}
