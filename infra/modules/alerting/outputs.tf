output "notification_channel_email_id" {
  description = "Resource name of the email notification channel, for adding it to a Slack or other channel's alert policy list later."
  value       = google_monitoring_notification_channel.email.id
}

output "alert_policy_ids" {
  description = "Resource names of the six alert policies, keyed by what they cover."
  value = {
    worker_consumer_failures = google_monitoring_alert_policy.worker_consumer_failures.id
    outbox_dead_letters      = google_monitoring_alert_policy.outbox_dead_letters.id
    api_5xx                  = google_monitoring_alert_policy.api_5xx.id
    migrate_job_failures     = google_monitoring_alert_policy.migrate_job_failures.id
    cloudsql_backup_failures = google_monitoring_alert_policy.cloudsql_backup_failures.id
    worker_zero_instances    = google_monitoring_alert_policy.worker_zero_instances.id
  }
}

output "log_based_metric_names" {
  description = "Names of the log-based metrics backing the five log-driven policies (everything but worker_zero_instances, which reads the built-in Cloud Run instance-count metric)."
  value = {
    worker_consumer_failures = google_logging_metric.worker_consumer_failures.name
    outbox_dead_letters      = google_logging_metric.outbox_dead_letters.name
    api_5xx                  = google_logging_metric.api_5xx.name
    migrate_job_failures     = google_logging_metric.migrate_job_failures.name
    cloudsql_backup_failures = google_logging_metric.cloudsql_backup_failures.name
  }
}
