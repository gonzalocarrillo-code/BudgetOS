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
  description = "Google groups (email) that read the whole replica, every tenant: the platform's own data team only. Clients read through workspace_readers."
  type        = list(string)
  default     = []
}

variable "workspace_readers" {
  description = "Per-workspace readers (D-014): key = a short slug for the dataset name (budget_os_<env>_ws_<key>), workspace_id = the workspace's uuid, groups = Google groups that read only that workspace's rows."
  type = map(object({
    workspace_id = string
    groups       = list(string)
  }))
  default = {}
  validation {
    condition     = alltrue([for k, w in var.workspace_readers : can(regex("^[a-z0-9_]{1,40}$", k)) && can(regex("^[0-9a-f-]{36}$", w.workspace_id))])
    error_message = "Keys are lower_snake_case slugs; workspace_id is a uuid."
  }
}
