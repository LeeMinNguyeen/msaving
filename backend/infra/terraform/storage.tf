# Nightly dumps. They must be gone within 7 days of a purge (privacy policy):
# the job deletes dumps older than 5 days 12 hours, this lifecycle rule is the
# backstop at 6 days, and versioning and soft delete stay off because either
# would keep deleted dumps (app/jobs/backup.py).
resource "google_storage_bucket" "backups" {
  name                        = "${var.project_id}-backups"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = false }
  soft_delete_policy { retention_duration_seconds = 0 }
  lifecycle_rule {
    action { type = "Delete" }
    condition { age = 6 }
  }
  force_destroy = false
}

resource "google_storage_bucket_iam_member" "backup_writes" {
  bucket = google_storage_bucket.backups.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.runtime["backup"].email}"
}

# PURGE_LOG: ids of purged accounts, kept outside the database so a backup
# restore can't roll it back. Versioned, so an overwrite or deletion can be
# undone; kept at least as long as the backups.
resource "google_storage_bucket" "purge_log" {
  name                        = "${var.project_id}-purge-log"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = true }
  lifecycle_rule {
    action { type = "Delete" }
    condition {
      num_newer_versions = 30
      with_state         = "ARCHIVED"
    }
  }
  force_destroy = false
}

resource "google_storage_bucket_iam_member" "purge_writes" {
  bucket = google_storage_bucket.purge_log.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.runtime["purge"].email}"
}
