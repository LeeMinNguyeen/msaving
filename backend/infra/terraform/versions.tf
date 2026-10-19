# Google Cloud for one environment (development or production). Each has its
# own project and its own state; see msaving-docs Cloud setup for the order of steps.
terraform {
  required_version = ">= 1.9"
  required_providers {
    google      = { source = "hashicorp/google", version = "~> 8.6" }
    google-beta = { source = "hashicorp/google-beta", version = "~> 8.6" }
  }
  # bucket and prefix come from envs/<env>.backend.hcl (terraform init -backend-config=...)
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}
