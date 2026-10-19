# prod environment. No secrets here: those go into Secret Manager by hand.
env           = "prod"
project_id    = "REPLACE-with-the-prod-Google-Cloud-project-id"
deploy_branch = "main"
site_url      = "https://msaving.leminhnguyen.com"
app_url       = "https://msaving-app.leminhnguyen.com"
api_url       = "https://msaving-api.leminhnguyen.com"
supabase_url  = "https://REPLACE-with-the-prod-Supabase-project-ref.supabase.co"
alert_email   = "lm.nguyen448@gmail.com"
run_services  = false # true after step 6 of msaving-docs Cloud setup (every secret has a value)
