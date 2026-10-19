# One service account per workload, each able to do only its own job
# (msaving-docs, Database roles). They never get keys: Cloud Run runs as them, and
# GitHub Actions impersonates the deployer through Workload Identity Federation.
locals {
  runtime = {
    api     = "The API"
    fx      = "Daily exchange rates job"
    purge   = "Daily account purge job"
    backup  = "Nightly backup job"
    trigger = "Cloud Scheduler: starts the jobs"
  }
}

resource "google_service_account" "runtime" {
  for_each     = local.runtime
  account_id   = "${each.key}-runner"
  display_name = each.value
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "deployer" {
  account_id   = "github-deployer"
  display_name = "GitHub Actions: deploys the API, jobs and Firebase Hosting"
}

# GitHub Actions' tokens, accepted only from this owner's backend and web repos,
# and only for the branch that deploys to this environment.
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  attribute_condition = <<-EOT
    assertion.repository in ["${var.github_owner}/msaving-backend", "${var.github_owner}/msaving-web", "${var.github_owner}/msaving-landing"]
    && assertion.ref == "refs/heads/${var.deploy_branch}"
  EOT
}

resource "google_service_account_iam_member" "deployer_from_github" {
  for_each           = toset(["msaving-backend", "msaving-web", "msaving-landing"])
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_owner}/${each.value}"
}

resource "google_project_iam_member" "deployer" {
  for_each = toset([
    "roles/run.developer",         # new revisions of the API, new job images
    "roles/firebasehosting.admin", # web app and API sites
    "roles/serviceusage.serviceUsageConsumer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_artifact_registry_repository_iam_member" "deployer_push" {
  repository = google_artifact_registry_repository.images.name
  location   = var.region
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

# Deploying a revision or job "as" a runtime account needs actAs on it.
resource "google_service_account_iam_member" "deployer_act_as" {
  for_each           = { for k, v in google_service_account.runtime : k => v if k != "trigger" }
  service_account_id = each.value.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
