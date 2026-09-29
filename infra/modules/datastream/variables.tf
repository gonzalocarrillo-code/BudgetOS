variable "project_id" {
  type = string
}

variable "env" {
  type        = string
  description = "dev | staging | prod"
}

variable "region" {
  type    = string
  default = "europe-west1"
}

variable "vpc_id" {
  type        = string
  description = "The VPC network Cloud SQL's private IP is in (projects/<p>/global/networks/<n>)."
}

variable "peering_cidr" {
  type        = string
  description = "A free /29 for Datastream's peering, e.g. 10.10.0.0/29."
}

variable "postgres_private_ip" {
  type = string
}

variable "database" {
  type    = string
  default = "budget"
}

variable "replication_user" {
  type        = string
  default     = "budget_datastream"
  description = "Created by setup.sql: REPLICATION, SELECT on every table, bypasses RLS (read-only)."
}

variable "replication_password_secret" {
  type        = string
  description = "Secret Manager secret holding the replication user's password."
}

variable "dataset_id" {
  type        = string
  description = "The bigquery module's dataset (budget_os_<env>): output dataset_id."
}

variable "data_freshness" {
  type    = string
  default = "900s"
}
