# The account event log (app/core/events.py) kept outside the database, longer
# than the backups, so a restore can re-apply closures, restores and consent
# withdrawals made after the dump (msaving-docs, Deleting an account, point 3).
resource "google_logging_project_bucket_config" "account_events" {
  project        = var.project_id
  location       = var.region
  bucket_id      = "account-events"
  retention_days = 90
  description    = "Account closures, restores and consent withdrawals from the API"
  depends_on     = [google_project_service.apis]
}

# A sink into a log bucket of the same project writes with Logging's own
# identity: no writer account, no IAM grant.
resource "google_logging_project_sink" "account_events" {
  name        = "account-events"
  destination = "logging.googleapis.com/${google_logging_project_bucket_config.account_events.id}"
  filter      = "resource.type=\"cloud_run_revision\" AND jsonPayload.account_event:*"
}

# A failed job run is the alert (the backup job's docstring relies on it).
resource "google_monitoring_notification_channel" "email" {
  display_name = "MSaving ${var.env} alerts"
  type         = "email"
  labels       = { email_address = var.alert_email }
  depends_on   = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "job_failed" {
  display_name = "MSaving ${var.env}: a daily job failed"
  combiner     = "OR"
  conditions {
    display_name = "Cloud Run job execution failed"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_job\" AND metric.type = \"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result = \"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.job_name"]
      }
    }
  }
  notification_channels = [google_monitoring_notification_channel.email.id]
  documentation {
    content   = "A daily job (purge, backup or rates) failed. Open Cloud Run → Jobs → the job → executions for the log. A failing backup puts the 7-day deletion promise at risk: fix it within days."
    mime_type = "text/markdown"
  }
}
