# Secret containers only: the values are added by hand (msaving-docs Cloud setup),
# never by Terraform, so they never land in its state or in git.
locals {
  secrets = {
    DATABASE_URL              = ["api"]    # api_login (app_user) via the Session pooler
    FX_DATABASE_URL           = ["fx"]     # fx_login (fx_updater)
    OXR_APP_ID                = ["fx"]     # Open Exchange Rates
    PURGE_DATABASE_URL        = ["purge"]  # purge_login (account_purger)
    SUPABASE_SERVICE_ROLE_KEY = ["purge"]  # deletes Auth logins; never in a browser
    BACKUP_DATABASE_URL       = ["backup"] # Supabase's postgres role: readable by the backup job only
  }
  secret_access = flatten([for s, who in local.secrets : [for w in who : { secret = s, who = w }]])
}

resource "google_secret_manager_secret" "s" {
  for_each  = local.secrets
  secret_id = each.key
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "access" {
  for_each  = { for a in local.secret_access : "${a.secret}-${a.who}" => a }
  secret_id = google_secret_manager_secret.s[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[each.value.who].email}"
}
