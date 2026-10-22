# CLAUDE.md: waterflow (monorepo)

Waterflow, a spending tracker people run themselves (self-hosted only): `backend/` (FastAPI API, daily jobs,
migrations, tests) and `web/` (React web app), built into one Docker image on the operator's machine and run with `docker-compose.yml`. No
published images: a release is a version tag.
`mobile/` (Expo) comes later. Public repo, AGPL-3.0.

The public documentation (install, operating a server, how it works, the API, contributing) is on the website at
https://waterflow-app.net/docs/, source `waterflow-landing/src/content/docs/`. A change here that alters
documented behaviour (a route, setting, error code, setup step, command) comes with a docs PR there, linked both
ways. The README is a short quickstart pointing to it; don't grow it back into a guide. Documentation is
English only (Vietnamese is for the UI). The
team's decisions are in the private waterflow-docs. Workspace-wide rules: `~/projects/msaving/CLAUDE.md`. Repo-part
rules: `backend/CLAUDE.md`, `web/CLAUDE.md`.

## Layout

```
Dockerfile           one image: builds web/, then the API serving it, the jobs, the migrations
docker-compose.yml   what operators run: secrets (first start), db (Postgres 17), waterflow, caddy (profile https),
                     updater (profile updater: git pull + rebuild)
VERSION              this checkout's version; bumped in the release PR, the release workflow tags it
docker-compose.dev.yml  development only: publishes the database for backend/scripts/dev.sh
scripts/move-to-waterflow.sh  once, on a compose server from before the rename (MSaving): moves the msaving
                     project's volumes to the waterflow ones
.env.example         every optional setting
backend/             see backend/CLAUDE.md
web/                 see web/CLAUDE.md
.github/workflows/   ci.yml (backend tests, web lint/test/build, image build), release.yml (run by hand on main: tag and GitHub release)
```

## Commands

```bash
docker compose up -d --build            # the whole stack from this checkout, http://localhost:8080
docker compose logs waterflow           # the setup code on a fresh database
docker compose down -v                  # stop and DELETE the local database, secrets and backups
```

Faster loops: `backend/CLAUDE.md` (pytest, uvicorn --reload) and `web/CLAUDE.md` (Vite, proxied to the API).

## Rules

- **Operators run this, not us.** Anything that needs a manual step, an account somewhere, or reading our docs
  is a bug in the setup. `git clone` and `docker compose up -d --build` must stay the whole install.
- **One image, one compose file.** New services need a strong reason. Settings are optional with safe defaults,
  listed in `.env.example` and the docs' Settings page.
- **The API only adds within `/v1`.** Mobile apps in the stores will talk to servers several versions apart;
  `/v1/instance` reports `api_version` and `server_version`.
- **No URL in code.** A server is whatever address it's reached at; clients use their own origin or the address
  the user gave.
- **Security is a hard requirement:** least-privilege database logins (the API never gets the owner's password),
  RLS, hashed passwords and tokens, rate limits, strict CSP, no third-party scripts, no tracking.

## Code comments

As few as possible. Claude Code adds far too many by default, in every language, and keeps doing it after being
told to stop: this section overrides that habit.

- **Default to none.** A comment is only for what the code can't say: why something non-obvious is done, a
  constraint from outside (a Postgres or library quirk, a security reason, a source's terms), or a trap.
- **Never restate the code:** what the next line does, a section label (`# ---- profile`), a type, unit or default
  the code already shows.
- **Never narrate history or the conversation:** no "now", "new", "no longer", "fixed", "as asked", "the owner
  decided", review notes, issue or milestone numbers, or your own reasoning. That goes in the commit message and
  the PR.
- **Docstrings** only for a contract the signature can't show (what None means, what it raises, an order), in one
  line where possible.
- **Don't touch comments in code you aren't otherwise changing**, and never edit a released migration for its
  comments.
- **Before you finish, read your diff and delete every comment that breaks these rules.** When in doubt, delete it.

Keep: tool directives (`noqa`, `oxlint-disable`, `eslint-disable`, `type: ignore`, shebangs), the operator notes in
`.env.example`, `docker-compose.yml` and the `Dockerfile`, the usage text in `backend/app/admin.py`, and the restore
steps in `backend/app/jobs/backup.py`'s docstring (the tests run them).

## Branches and releases

Feature branches from `dev`; `dev` and `main` are protected (PR with passing CI). A release: a PR into `main`
that bumps `VERSION`, then Actions -> Release -> Run workflow on `main`, which tags `vX.Y.Z` and makes the GitHub
release (servers check it for updates; operators `git pull`). Never push tags from a laptop.
