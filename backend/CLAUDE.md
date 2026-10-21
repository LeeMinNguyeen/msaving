# CLAUDE.md: backend

The FastAPI API, its own sign-in, the daily jobs and the PostgreSQL schema for MSaving, self-hosted only.
Monorepo rules: `../CLAUDE.md`. Workspace rules: `~/projects/msaving/CLAUDE.md`. How it all works: the public
docs (https://msaving.leminhnguyen.com/docs/, source `msaving-landing/src/content/docs/`); a change to documented
behaviour comes with a docs PR there. Decisions: the private msaving-docs.

## Layout

```
migrations/              plain SQL, applied in order by app/jobs/migrate.py on every start (msaving.migrations)
app/
  launch.py              the container's entry: secrets, wait for the db, backup + migrate, setup code, API + jobs
  admin.py               operator commands: reset-password, make-admin, repurge
  core/                  settings.py (env), sign_in.py (argon2id, TOTP, codes, tokens, rate limits),
                         auth.py (session token -> user), db.py (per-request session, app.user_id)
  api/                   main.py (app, web app files, CSP, /v1/instance), deps.py, errors.py, routes/v1/
                         (sign_in: setup, join, sign-in, 2FA, reset; admin; me; books, accounts, ...)
  domain/                transactions, dashboard, export, book_setup
  jobs/                  migrate, scheduler (daily), account_deletion, backup, fx_update
tests/                   conftest.py (throwaway database), test_schema, test_api, test_sign_in, test_backup
scripts/dev.sh           the API from source with --reload, against the compose stack's database
```

## Run and test

```bash
source ~/projects/msaving/.venv/bin/activate
pip install -r requirements-dev.txt
scripts/dev.sh                       # http://127.0.0.1:8000, reloads on change; web: npm run dev in ../web

# Tests: a throwaway Postgres 17, local only
docker run -d --name pgtest -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:5499:5432 postgres:17
export TEST_ADMIN_URL="postgresql+psycopg://postgres@localhost:5499/postgres"
PATH=/usr/lib/postgresql/17/bin:$PATH python -m pytest -q -p no:cacheprovider tests/
```

82 tests are expected to pass. The backup tests need `pg_dump`, `pg_restore` and `psql` 17 on `PATH`
(`sudo apt install postgresql-client-17`). `scripts/dev.sh` uses the same database as `docker compose up`;
`docker compose down -v` resets everything.

## Migrations

1. A new file `migrations/<UTC timestamp>_<name>.sql`, plain SQL.
2. `docker compose down -v && docker compose up -d --build`, or just run the tests (they apply every file).
3. PR into `dev`. Servers apply it on their next start, after a backup.

Rules:
- Never edit a migration that's in a release; write a new one. Until the first release the baseline is edited directly.
- A new table gets RLS, policies and grants in the same file.
- Function EXECUTE is revoked from PUBLIC by default: grant every new function to the roles that call it.
- Every function that reads tables (security definer or trigger) sets `search_path = pg_catalog, public, pg_temp`.
- Breaking changes in two steps (add and use the new thing, remove the old one a release later): an operator may
  skip versions, and old mobile apps keep calling the API.
- Migrations create roles (`app_user`, `account_purger`, `fx_updater`), never logins. `migrate.py` makes the
  logins (`api_login`, `purge_login`, `fx_login`) with passwords from the secrets volume.

## Security rules (enforced and tested)

- RLS on every table with user data; with no `app.user_id` set, queries return nothing.
- Per request: the bearer token's SHA-256 is looked up with `session_user_id()`, then one transaction with
  `set_config('app.user_id', <user>, true)` (`app/core/db.py`).
- Logins never superuser or BYPASSRLS. The API gets only `api_login`; the owner's URL goes only to the backup
  and migrations (`app/launch.py` strips it from the API's environment).
- Sign-in data (`local_credentials`, `recovery_codes`, `sessions`, `invites`, `password_resets`,
  `instance_settings`) is reached only through security definer functions or own-row policies. Nobody can set
  `is_admin` from the app; admin tools check `am_admin()` in the database.
- Passwords argon2id; session and reset tokens random, stored as SHA-256; invite, setup and recovery codes
  stored as SHA-256 of their normal form. Never log a token or code (the setup code is the one exception: it's
  printed for the operator, and only while there's no admin).
- Rate limits (`app/core/sign_in.py`) on sign-in, sign-up, setup, reset, invite checks and code entry.
- Random UUIDs for every exposed id; only the last 4 digits of card or account numbers.
- No CORS: the web app is same-origin, in development too (Vite's proxy).

## API conventions

- Routes under `/v1`, additive changes only. `GET /v1/instance` is public and stable: clients check it first.
- Optimistic concurrency: clients send the `version` they loaded; mismatch returns 409.
- Routes that write call `db.commit()` themselves before returning (a commit in the dependency's cleanup runs
  after the response is sent).
- Never `INSERT ... RETURNING` or `ON CONFLICT` on `books`: both apply the read policy before the creator is a member.
- Transactions are idempotent on a client-generated id.
- Money in integer minor units; never float.
- Database errors start with a code (`owner_required`, `invite_invalid`, ...); `app/api/errors.py` maps each to
  an HTTP status, and the clients translate it. A new code needs both string files in `web/`.

## Jobs

`app/jobs/scheduler.py`, inside the `msaving` container, each job once a day at the time set on Server admin
(`JOBS_HOUR`, UTC, until then; `app/core/jobs.py` says when one is due). On Cloud Run the server has
`RUN_JOBS=off` and a scheduled Cloud Run job runs `python -m app.launch jobs` (one look) every hour.
`account_deletion` (purge after 30 days, expired sessions; ids to `PURGE_LOG` in the backups volume), `backup`
(pg_dump into `/backups`, about 6 days kept, owner-only files), `fx_update` (open.er-api.com, no key; Open
Exchange Rates with `OXR_APP_ID`).

## Don't

- Don't commit `.env`, `.dev/` or any secret.
- Don't store balances; they are sums of entries.
- Don't add a setting an operator must fill in; give it a safe default.
- Don't send raw transactions, notes, account names or people to an AI model (when AI is built).
