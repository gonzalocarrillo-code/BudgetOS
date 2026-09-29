output "stream_id" {
  value = google_datastream_stream.replica.stream_id
}

output "excluded_tables" {
  value = local.excluded_tables
}
