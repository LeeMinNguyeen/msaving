output "wif_provider" {
  description = "GitHub environment variable GCP_WIF_PROVIDER"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_email" {
  description = "GitHub environment variable GCP_DEPLOYER_SA"
  value       = google_service_account.deployer.email
}

output "image_repository" {
  description = "Where CI pushes the API/jobs image"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}/api"
}

output "api_cloud_run_url" {
  value = one(google_cloud_run_v2_service.api[*].uri)
}

output "firebase_sites" {
  description = "Hosting site ids: landing (default), app, api"
  value       = { landing = var.project_id, app = google_firebase_hosting_site.site["app"].site_id, api = google_firebase_hosting_site.site["api"].site_id }
}

output "dns_records" {
  description = "Records to create in Cloudflare (DNS only, proxy off), per hostname"
  value       = { for k, d in google_firebase_hosting_custom_domain.domain : d.custom_domain => d.required_dns_updates }
}
