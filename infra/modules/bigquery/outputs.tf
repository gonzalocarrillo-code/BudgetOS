output "dataset_id" {
  description = "The budget_os_<env> dataset."
  value       = google_bigquery_dataset.budget_os.dataset_id
}

output "views" {
  description = "Curated view ids (project.dataset.view)."
  value       = { for k, v in merge(google_bigquery_table.view, google_bigquery_table.derived_view) : k => "${v.project}.${v.dataset_id}.${v.table_id}" }
}
