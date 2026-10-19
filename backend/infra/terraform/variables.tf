variable "env" {
  description = "dev or prod"
  type        = string
  validation {
    condition     = contains(["dev", "prod"], var.env)
    error_message = "env is dev or prod."
  }
}

variable "project_id" {
  description = "This environment's Google Cloud project id"
  type        = string
}

variable "region" {
  description = "Next to Supabase's Singapore region (msaving-docs, Decisions: Hosting)"
  type        = string
  default     = "asia-southeast1"
}

variable "site_url" {
  description = "SITE_URL: the landing site"
  type        = string
}

variable "app_url" {
  description = "APP_URL: the web app; the API's CORS allows only this origin"
  type        = string
}

variable "extra_allowed_origins" {
  description = "EXTRA_ALLOWED_ORIGINS: localhost origins the dev API's CORS also allows, for frontend developers running only the web app. Never set in prod"
  type        = string
  default     = ""
}

variable "api_url" {
  description = "API_URL: where the API is reached (the Firebase Hosting site in front of Cloud Run)"
  type        = string
}

variable "supabase_url" {
  description = "This environment's Supabase project URL, https://<ref>.supabase.co"
  type        = string
}

variable "alert_email" {
  description = "Where failed job runs are reported"
  type        = string
}

variable "github_owner" {
  description = "GitHub account that owns the repos allowed to deploy here"
  type        = string
  default     = "LeeMinNguyeen"
}

variable "deploy_branch" {
  description = "The branch whose CI may deploy to this environment: staging (dev env) or main (prod)"
  type        = string
}

variable "run_services" {
  description = "Create the API, the jobs and their schedules. false until every secret has a value (msaving-docs Cloud setup step 6)"
  type        = bool
}

variable "api_max_instances" {
  description = "Keeps database connections under the Supabase pooler's limit on Free"
  type        = number
  default     = 3
}
