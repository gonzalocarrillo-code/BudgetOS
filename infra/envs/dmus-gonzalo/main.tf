# Root module for the dmus-gonzalo deployment (ADR-065). Everything here was created once by hand
# (docs/runbooks/deploy.md "One-time setup"); this is the first Terraform that describes any of it.
# A project owner runs `terraform init && terraform plan` and reviews the diff before ever applying
# (docs/STACK_HARDENING_PLAN.md W0-2). See each module's README for what the first apply changes.

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # No state bucket exists yet for this project (everything so far was applied by hand, so there is
  # no prior remote state to protect). Until one is created, state stays local to whoever runs
  # terraform, which is only safe because nobody has applied this root module yet. Create a GCS
  # bucket for state (versioned, uniform access, not the uploads bucket) before the first real
  # apply, then uncomment:
  #
  # backend "gcs" {
  #   bucket = "dmus-gonzalo-terraform-state"
  #   prefix = "budgetos"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" {
  type    = string
  default = "dmus-gonzalo"
}

variable "region" {
  type    = string
  default = "us-central1"
}

# --- Cloud SQL + uploads bucket (B-1, B-4; this change) -----------------------------------------
# Adopts the hand-created instance, database and bucket via the import blocks in the module itself;
# see infra/modules/cloudsql/README.md for the before/after table.
module "cloudsql" {
  source     = "../../modules/cloudsql"
  project_id = var.project_id
  region     = var.region
}

# `import` blocks are only valid in the root module (Terraform refuses them inside a child module),
# so they live here rather than in infra/modules/cloudsql, and reach into the module's resources by
# their module-qualified address. This is what makes the first `terraform plan` an adoption of the
# hand-created instance/database/bucket, not a plan to create duplicates.
import {
  to = module.cloudsql.google_sql_database_instance.budgetos_db
  id = "${var.project_id}/budgetos-db"
}

import {
  to = module.cloudsql.google_sql_database.budget
  id = "${var.project_id}/budgetos-db/budget"
}

import {
  to = module.cloudsql.google_storage_bucket.uploads
  id = "dmus-gonzalo-budgetos-uploads"
}

# --- BigQuery replica dataset and curated views (spec §20, plan §6.2; D-001) --------------------
# NOT instantiated. Not deployed to dmus-gonzalo yet — only the unrelated budgetos_closures dataset
# exists there today (ADR-065, ADR-018) — and the first apply of this root module must be adoption
# of the hand-created Cloud SQL instance/database/bucket plus their hardening, nothing else: mixing
# in a genuine create (budget_os_prod and its views) would make that first plan harder to review and
# risk it being applied by accident alongside the adoption. It has no unmet prerequisite (no VPC, no
# private IP, nothing to fabricate), so uncomment when D-001 is scheduled:
#
# module "bigquery" {
#   source     = "../../modules/bigquery"
#   project_id = var.project_id
#   env        = "prod"
# }

# --- Datastream CDC replica (spec §20; plan §6.2) ------------------------------------------------
# NOT instantiated, for a second, stronger reason than bigquery above: this module cannot be filled
# in with live values at all. It requires a VPC the Cloud SQL instance peers into, a private IP on
# the instance, and a replication role/secret, none of which exist in dmus-gonzalo (the instance is
# public-IP only today — see infra/modules/cloudsql/README.md "Private IP"). Inventing placeholder
# network values here would describe infrastructure that is not real and risk an owner applying it
# by accident. Once the private-IP migration lands (tracked as a follow-up, not part of W0-2),
# uncomment and fill in:
#
# module "datastream" {
#   source                       = "../../modules/datastream"
#   project_id                   = var.project_id
#   env                          = "prod"
#   region                       = var.region
#   vpc_id                       = "projects/${var.project_id}/global/networks/<budgetos-vpc>"
#   peering_cidr                 = "<a free /29>"
#   postgres_private_ip          = module.cloudsql.instance_private_ip  # does not exist yet
#   replication_password_secret  = "budgetos-datastream-password"
#   dataset_id                   = module.bigquery.dataset_id
# }
