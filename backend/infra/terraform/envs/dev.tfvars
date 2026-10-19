# dev environment. No secrets here: those go into Secret Manager by hand.
env           = "dev"
project_id    = "msaving-dev"
deploy_branch = "staging"
site_url      = "https://msaving-dev.leminhnguyen.com"
app_url       = "https://msaving-app-dev.leminhnguyen.com"
api_url       = "https://msaving-api-dev.leminhnguyen.com"
supabase_url  = "https://xvknbvalffzlkemlgmpy.supabase.co"
alert_email   = "lm.nguyen448@gmail.com"
run_services  = true # set after step 6 of msaving-docs Cloud setup (every secret has a value)

# Frontend developers run only the web app locally against this API (msaving-docs, Environments).
extra_allowed_origins = "http://localhost:5173"
