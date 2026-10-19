# CLAUDE.md: msaving-backend

FastAPI API, background jobs and the Supabase database for Project MSaving. Workspace-wide rules are in `~/projects/msaving/CLAUDE.md`.

**msaving-docs is the source of truth** for decisions and how everything works (`~/projects/msaving/msaving-docs`, run `npm run dev` there). A schema or decision change is two PRs: the code (migrations + tests) here, and a paired msaving-docs PR (the decision, the pages it changes, a row in Reference → Requirements and tests). Link them; don't merge this one with the docs PR open.

## Layout

```
supabase/
  config.toml            local stack settings (Postgres 17, Data API off, confirmed email, TOTP)
  migrations/            plain SQL, timestamped
  seed.sql               development only (placeholder privacy policy)
app/
  core/                  settings.py (env), auth.py (Supabase token check), db.py (per-request session)
  api/                   main.py (FastAPI app, CORS), deps.py, routes/v1/
  domain/                transactions, dashboard, export, book_setup, ai_keys
  jobs/                  fx_update, account_deletion, backup (run as python -m app.jobs.<name>)
tests/                   conftest.py (throwaway database), test_schema.py, test_api.py, test_backup.py, test_unconfirmed_signups.py
scripts/local_logins.sh  one login per role on the LOCAL stack only (schema work)
Dockerfile               one image for the API and every job
infra/terraform/         Google Cloud for one environment (envs/dev|prod.tfvars); infra/firebase/ the API's Hosting site
compose.yaml             the API in a container (against development)
.github/workflows/       ci.yml (tests + image build), deploy.yml (merge to staging/main: tests, supabase db push, Cloud Run, API site)
```

## Run the API

Developers use the **development** environment's database and sign-in; nobody runs the infrastructure
except for schema work (msaving-docs, Environments).

```bash
source ~/projects/msaving/.venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env           # untracked; fill DATABASE_URL (dev api_login, Transaction pooler, from the project owner)
uvicorn app.api.main:app --reload --port 8000 --env-file .env    # or: docker compose up --build
curl http://127.0.0.1:8000/v1/health
```

Everything you create lands in development's database, shared with the team: made-up data only. Jobs
(rates, purge, backup) run only in the cloud.

## Schema work: local Supabase

Only whoever is writing a migration. An unmerged migration must never touch the shared database.

```bash
supabase start                 # Postgres 17 + Auth + Mailpit (emails at http://127.0.0.1:54324)
# in .env: switch to the "Schema work only" lines at the bottom of .env.example
scripts/local_logins.sh        # api_login etc. with a local-only password
python scripts/local_rates.py  # made-up exchange rates, or the real job if OXR_APP_ID is set
uvicorn app.api.main:app --reload --port 8000 --env-file .env    # not compose: 127.0.0.1 in a container is the container
supabase db reset              # rebuild from migrations + seed.sql, then rerun local_logins.sh
```

Point the web app's `.env.local` at local Supabase too while you do this. Switch back when the PR is merged.

## Tests

```bash
# Postgres 17 superuser, local only
docker run -d --name pgtest -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:5499:5432 postgres:17
export TEST_ADMIN_URL="postgresql+psycopg://postgres@localhost:5499/postgres"
export PGSSLMODE=disable     # the container has no TLS; backup.py asks for TLS unless told otherwise
PATH=/usr/lib/postgresql/17/bin:$PATH python -m pytest -q -p no:cacheprovider tests/
```

67 tests are expected to pass. The backup tests need `pg_dump`, `pg_restore` and `psql` of the server's major version on `PATH` (`sudo apt install postgresql-client-17`).

**Never point the tests at a hosted Supabase project**, development included. They create and drop passwordless logins on whatever server they hit.

## Migrations

1. `supabase migration new <name>`, write the SQL.
2. `supabase db reset`, run the tests.
3. PR into `dev`; CI applies it to development on merge to `staging`, production on merge to `main`.

Rules:
- Never edit a migration that has reached dev or prod; write a new one. Until the first push to dev, the baseline is still edited directly.
- A new table gets RLS, policies and grants in the same file.
- Function EXECUTE is revoked from PUBLIC: grant every new function to the logins that call it.
- Every function that reads tables (security definer or trigger) sets `search_path = pg_catalog, public, pg_temp`.
- Breaking changes go in two steps (add and use the new thing, remove the old in a later migration), because migrations deploy before the API.
- Migrations create roles, not logins. Logins are created by hand per environment.

## Security rules (enforced and tested)

- RLS on every table with user data; with no `app.user_id` set, queries return nothing.
- Per request: verify the Supabase token (signature, expiry, audience), then one transaction with `set_config('app.user_id', <user>, true)` (see `app/core/db.py`).
- One login per role, no `BYPASSRLS`: `app_user` (API), `ai_reader`, `fx_updater`, `account_purger`, `billing_webhook`. The schema owner is used only by CI migrations. `postgres` only for the backup job.
- The app can't write `created_by`, `modified_by`, `invited_by`, plan holder or AI payer; the database sets them. Plans change only through the payment webhook.
- Supabase's browser roles (`anon`, `authenticated`) have no access to any table or function. Supabase Data API off.
- Random UUIDs for every exposed id; internal sequential ids never returned.
- Only last 4 digits of card/account numbers; no bank credentials ever.
- AI keys: AES-256-GCM in the backend, encryption key in Secret Manager, never in the database.
- CORS allows only `APP_URL`, plus `EXTRA_ALLOWED_ORIGINS` (localhost origins only, enforced in `settings.py`; development only, enforced in Terraform). Rate limits on sign-in, sign-up and confirmation resend are Supabase Auth settings; the API has no rate limiting yet, and username lookup needs one before the hobbyist test (issue #32).

## API conventions

- Routes under `/v1`, additive changes only within a version; a minimum supported app version for mobile later.
- Optimistic concurrency: clients send the `version` they loaded; mismatch returns 409.
- Routes that write call `db.commit()` themselves before returning: a commit in the dependency's cleanup runs after the response is sent.
- Never `INSERT ... RETURNING` or `ON CONFLICT` on `books`: both apply the read policy before the creator is a member.
- Transactions are idempotent on a client-generated id; saving the same id twice does nothing.
- Money in integer minor units; never float.
- Database errors start with a code (`plan_limit`, `consent_required`, `currency_locked`, `txn_shape`, `owner_required`, `budget_expense_only`, `no_rate`, `consent_outdated`, `category_kind`); the API maps it to a message in the user's language (`users.language`, `vi` default).
- No URLs in code: read `SITE_URL`, `APP_URL`, `API_URL`.
- Creating a book calls `book_setup.add_starter_categories()` in the same transaction unless the user unticked it.
- Deleting a category that has transactions fails on its foreign key: archive it instead and say so in the response.

## Jobs

Cloud Run jobs via Cloud Scheduler (`infra/terraform/run.tf`), `asia-southeast1`, all from the one image: `fx_update.py` (Open Exchange Rates, daily), account purge and unconfirmed sign-ups (`account_deletion.py`, needs `PURGE_LOG`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), nightly `backup.py` (runs after purge; bucket lifecycle 6 days, versioning and soft delete off). 

## Branches and CI

feature (from `dev`) -> `dev` (deploys nowhere) -> `staging` (development) -> `main` (production). Tests on every PR. On merge to `staging`/`main`: tests, then `supabase db push` (development with `--include-seed`; prod never gets seed.sql), then Cloud Run deploy. If a step fails, nothing after it runs.

## Not built yet

See msaving-docs Product → Status (and Operations → Cloud setup for the manual steps).

## Don't

- Don't commit `.env` or any secret. Per-environment secrets: login URLs, `BACKUP_DATABASE_URL`, `AI_KEY_ENCRYPTION_KEY`, `OXR_APP_ID`, `SUPABASE_SERVICE_ROLE_KEY`.
- Don't run `supabase db push` from a laptop or against production.
- Don't store balances; they are sums of entries.
- Don't send raw transactions, notes, account names or people to an AI model.
