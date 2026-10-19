# Firebase Hosting in this project: the landing page on the default site, plus
# a site for the web app and one for the API (which forwards everything to the
# Cloud Run service: TLS, CDN and a custom domain without a load balancer).
resource "google_firebase_project" "this" {
  provider   = google-beta
  project    = var.project_id
  depends_on = [google_project_service.apis]
}

resource "google_firebase_hosting_site" "site" {
  provider   = google-beta
  for_each   = toset(["app", "api"])
  project    = var.project_id
  site_id    = "${var.project_id}-${each.key}"
  depends_on = [google_firebase_project.this]
}

# Custom domains. Firebase lists the DNS records to create in Cloudflare
# (output dns_records); certificates follow once they resolve.
locals {
  domains = {
    landing = { site = var.project_id, host = trimprefix(var.site_url, "https://") }
    app     = { site = google_firebase_hosting_site.site["app"].site_id, host = trimprefix(var.app_url, "https://") }
    api     = { site = google_firebase_hosting_site.site["api"].site_id, host = trimprefix(var.api_url, "https://") }
  }
}

resource "google_firebase_hosting_custom_domain" "domain" {
  provider              = google-beta
  for_each              = local.domains
  project               = var.project_id
  site_id               = each.value.site
  custom_domain         = each.value.host
  wait_dns_verification = false
  depends_on            = [google_firebase_project.this]
}
