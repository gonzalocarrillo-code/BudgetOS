output "connection_name" {
  description = "project:region:instance, for --add-cloudsql-instances / --set-cloudsql-instances and the Cloud SQL Auth Proxy."
  value       = google_sql_database_instance.budgetos_db.connection_name
}

output "instance_self_link" {
  value = google_sql_database_instance.budgetos_db.self_link
}

output "public_ip_address" {
  value = google_sql_database_instance.budgetos_db.public_ip_address
}

output "database_name" {
  value = google_sql_database.budget.name
}

output "uploads_bucket_name" {
  value = google_storage_bucket.uploads.name
}

output "uploads_bucket_url" {
  value = google_storage_bucket.uploads.url
}
