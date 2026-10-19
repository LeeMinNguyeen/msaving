# CLAUDE.md: msaving (monorepo)

MSaving, a spending tracker people run themselves (self-hosted only): `backend/` (FastAPI API, daily jobs,
migrations, tests) and `web/` (React web app), built into one Docker image and run with `docker-compose.yml`.
`mobile/` (Expo) comes later. Public repo, AGPL-3.0.

The project's decisions and team docs are in **msaving-docs** (private; `~/projects/msaving/msaving-docs` for
the team). Workspace-wide rules: `~/projects/msaving/CLAUDE.md`. Repo-part rules: `backend/CLAUDE.md`,
`web/CLAUDE.md`. The README (English) and README.vi.md (Vietnamese) are the public setup guide for
operators: keep both true when setup, settings, backups or commands change.

## Layout

```
Dockerfile           one image: builds web/, then the API serving it, the jobs, the migrations
docker-compose.yml   what operators run: secrets (first start), db (Postgres 17), msaving, caddy (profile https)
docker-compose.dev.yml  development only: publishes the database for backend/scripts/dev.sh
.env.example         every optional setting
backend/             see backend/CLAUDE.md
web/                 see web/CLAUDE.md
.github/workflows/   ci.yml (backend tests, web lint/test/build, image build), release.yml (v* tag on main: amd64+arm64 to GHCR)
```

## Commands

```bash
docker compose up -d --build            # the whole stack from this checkout, http://localhost:8080
docker compose logs msaving             # the setup code on a fresh database
docker compose down -v                  # stop and DELETE the local database, secrets and backups
```

Faster loops: `backend/CLAUDE.md` (pytest, uvicorn --reload) and `web/CLAUDE.md` (Vite, proxied to the API).

## Rules

- **Operators run this, not us.** Anything that needs a manual step, an account somewhere, or reading our docs
  is a bug in the setup. `docker compose up -d` must stay the whole install.
- **One image, one compose file.** New services need a strong reason. Settings are optional with safe defaults,
  listed in `.env.example` and both READMEs.
- **The API only adds within `/v1`.** Mobile apps in the stores will talk to servers several versions apart;
  `/v1/instance` reports `api_version` and `server_version`.
- **No URL in code.** A server is whatever address it's reached at; clients use their own origin or the address
  the user gave.
- **Security is a hard requirement:** least-privilege database logins (the API never gets the owner's password),
  RLS, hashed passwords and tokens, rate limits, strict CSP, no third-party scripts, no tracking.

## Branches and releases

Feature branches from `dev`; `dev` and `main` are protected (PR with passing CI). A `vX.Y.Z` tag on `main`
publishes the images. Never push tags or images from a laptop.
