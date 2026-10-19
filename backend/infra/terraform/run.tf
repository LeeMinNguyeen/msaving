# The API (a Cloud Run service) and the three daily jobs (Cloud Run jobs), all
# from the one image. Terraform creates them with a placeholder image; CI
# deploys the real one on every merge, so Terraform ignores the image after.
locals {
  placeholder_image = "us-docker.pkg.dev/cloudrun/container/hello"
  supabase_ref      = trimsuffix(trimprefix(var.supabase_url, "https://"), ".supabase.co")
}

# Cloud Run refuses a secret with no value, so all of this waits for
# run_services = true, set after the secret values are in (msaving-docs Cloud setup).
resource "google_cloud_run_v2_service" "api" {
  count               = var.run_services ? 1 : 0
  name                = "api"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL" # reached through Firebase Hosting (api site), which calls the public URL
  deletion_protection = var.env == "prod"

  template {
    service_account                  = google_service_account.runtime["api"].email
    max_instance_request_concurrency = 40
    scaling {
      min_instance_count = 0
      max_instance_count = var.api_max_instances
    }
    containers {
      image = local.placeholder_image
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = true
      }
      env {
        name  = "SUPABASE_URL"
        value = var.supabase_url
      }
      env {
        name  = "APP_URL"
        value = var.app_url
      }
      env {
        name  = "SITE_URL"
        value = var.site_url
      }
      env {
        name  = "EXTRA_ALLOWED_ORIGINS"
        value = var.extra_allowed_origins
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.s["DATABASE_URL"].secret_id
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
    precondition {
      condition     = var.env == "dev" || var.extra_allowed_origins == ""
      error_message = "extra_allowed_origins is for development only."
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.access]
}

moved {
  from = google_cloud_run_v2_service.api
  to   = google_cloud_run_v2_service.api[0]
}

# Anyone may call it: every route checks the Supabase token itself, and
# Firebase Hosting needs to reach it.
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  count    = var.run_services ? 1 : 0
  name     = google_cloud_run_v2_service.api[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

locals {
  jobs = {
    fx = {
      module  = "app.jobs.fx_update"
      memory  = "512Mi"
      timeout = "300s"
      env     = {}
      secrets = ["FX_DATABASE_URL", "OXR_APP_ID"]
      mount   = null
    }
    purge = {
      module  = "app.jobs.account_deletion"
      memory  = "512Mi"
      timeout = "900s"
      env     = { SUPABASE_URL = var.supabase_url, PURGE_LOG = "/mnt/purge-log/purge-log.jsonl" }
      secrets = ["PURGE_DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
      mount   = { bucket = google_storage_bucket.purge_log.name, path = "/mnt/purge-log" }
    }
    backup = {
      module  = "app.jobs.backup"
      memory  = "2Gi" # Cloud Run's disk is memory: twice the dump
      timeout = "1800s"
      env     = { BACKUP_DIR = "/mnt/backups" }
      secrets = ["BACKUP_DATABASE_URL"]
      mount   = { bucket = google_storage_bucket.backups.name, path = "/mnt/backups" }
    }
  }
}

resource "google_cloud_run_v2_job" "job" {
  for_each            = { for k, v in local.jobs : k => v if var.run_services }
  name                = each.key
  location            = var.region
  deletion_protection = var.env == "prod"

  template {
    task_count = 1
    template {
      service_account       = google_service_account.runtime[each.key].email
      timeout               = each.value.timeout
      max_retries           = 1
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2" # needed for the Cloud Storage volume
      containers {
        image   = local.placeholder_image
        command = ["python"]
        args    = ["-m", each.value.module]
        resources {
          limits = { cpu = "1", memory = each.value.memory }
        }
        dynamic "env" {
          for_each = each.value.env
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = toset(each.value.secrets)
          content {
            name = env.value
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.s[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
        dynamic "volume_mounts" {
          for_each = each.value.mount == null ? [] : [each.value.mount]
          content {
            name       = "bucket"
            mount_path = volume_mounts.value.path
          }
        }
      }
      dynamic "volumes" {
        for_each = each.value.mount == null ? [] : [each.value.mount]
        content {
          name = "bucket"
          gcs {
            bucket    = volumes.value.bucket
            read_only = false
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }
  depends_on = [google_secret_manager_secret_iam_member.access]
}

# Cloud Scheduler starts the jobs, as the trigger account (allowed to run them,
# nothing else). Times are Vietnam time: purge, then backup, then rates.
locals {
  schedules = {
    purge  = "0 2 * * *"
    backup = "30 2 * * *"
    fx     = "0 7 * * *"
  }
}

resource "google_cloud_run_v2_job_iam_member" "trigger" {
  for_each = google_cloud_run_v2_job.job
  name     = each.value.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.runtime["trigger"].email}"
}

resource "google_cloud_scheduler_job" "run" {
  for_each  = { for k, v in local.schedules : k => v if var.run_services }
  name      = "run-${each.key}"
  region    = var.region
  schedule  = each.value
  time_zone = "Asia/Ho_Chi_Minh"
  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/${google_cloud_run_v2_job.job[each.key].id}:run"
    oauth_token {
      service_account_email = google_service_account.runtime["trigger"].email
    }
  }
  retry_config { retry_count = 1 }
  depends_on = [google_cloud_run_v2_job_iam_member.trigger]
}
