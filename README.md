# MSaving

A spending tracker you run yourself, for you, your family or a small group. Your money data stays on your own
machine or server: nobody else runs it, and the project collects nothing.

*Tiếng Việt: [README.vi.md](README.vi.md)*

- Several books (personal, household, a side business), each with its own currency
- Accounts in any currency: cash, bank, savings, investments, credit cards, loans, money lent
- Expenses, income, transfers, refunds, with full edit history
- Categories, budgets per day, week, month, quarter or year, a dashboard
- Who owes whom: money lent and borrowed, by person
- Shared books with roles (owner, editor, viewer)
- Daily exchange rates with no account or key needed
- Download everything as readable CSV files; delete your account any time
- Vietnamese and English

Free and open source ([AGPL-3.0](LICENSE)). Status: first release in progress; a mobile app (Android, iOS)
comes later.

## Install

You need a machine that stays on (a home computer, a mini PC, a Raspberry Pi 4 or newer, or a VPS) with
[Docker](https://docs.docker.com/engine/install/) and Docker Compose. 1 GB of memory is enough.

```bash
mkdir msaving && cd msaving
curl -O https://raw.githubusercontent.com/LeeMinNguyeen/msaving/main/docker-compose.yml
docker compose up -d
docker compose logs msaving
```

The log shows a **setup code**, like `CJJV-SJ9H-EDWZ`. Open http://localhost:8080, enter the code, and create
your account: it becomes the server's **admin**. The code proves you're the person who installed the server,
so nobody who finds it first can take it over. A new code is printed on every start until the admin exists.

Nothing else to configure: the database, its passwords and the daily jobs are set up on the first start.

## Invite people

New accounts need an invite. As the admin, open **Server admin**, then **Create invite**. Send the link, or
let them scan the QR code: they pick a username and a password, and they're in. Each invite works once and
expires (1, 7 or 30 days). There is no email: if someone forgets their password, make them a **Reset link**
in the same screen.

You can also open sign-up to anyone who can reach the server (**Server admin**, **New accounts**).

## Use it from other devices

The server listens only on the machine itself (`127.0.0.1:8080`) until you choose how others reach it. The
mobile app will need HTTPS, so pick one of these:

**Tailscale (recommended for a home machine and a private group).** Everyone in your group installs
[Tailscale](https://tailscale.com/download) and joins your network; nothing is opened to the internet. On the
server:

```bash
tailscale serve --bg 8080
```

It prints an address like `https://money.your-network.ts.net`.

**Your own domain.** Point a domain (for example `money.example.com`) at the server, open ports 80 and 443,
and add a `.env` file next to `docker-compose.yml`:

```
COMPOSE_PROFILES=https
DOMAIN=money.example.com
```

Then `docker compose up -d`. Caddy gets and renews the certificate by itself.

**Cloudflare Tunnel.** For a home machine where you can't open ports: create a tunnel in the Cloudflare
dashboard that points your hostname at `http://localhost:8080`, and run `cloudflared` on the server
([guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)).

**Home network only, no HTTPS.** Set `BIND=0.0.0.0` in `.env` and open `http://<the server's address>:8080`.
Traffic isn't encrypted, so only do this on a network you trust, and the mobile app won't work this way.

## Update

```bash
docker compose pull
docker compose up -d
```

The server takes a backup before applying any database change. To stay on one version, set
`MSAVING_VERSION=1.2.0` in `.env`. The admin sees on **Server admin** when a new version is out.

**One-click updates (optional).** Add `COMPOSE_PROFILES=updater` to `.env` (`https,updater` with Caddy) and
run `docker compose up -d`. The admin can then press **Update now** on **Server admin**. This starts a small
helper that can control Docker on this machine, which is root-level access: it only ever pulls the MSaving
image and restarts that container, but turn it on only if you're comfortable with that. Updating is a web
app feature; the mobile app doesn't do it.

## Backups

Every night (and before every update) the server writes a backup into the `backups` volume and keeps about
6 days of them. They're on the same disk as the server, so **copy them somewhere else** regularly:

```bash
docker compose cp msaving:/backups ./msaving-backups
```

Backups contain password hashes: keep the copies private.

To restore one (it replaces everything on the server):

```bash
docker compose stop msaving
docker compose cp ./msaving-backups/msaving-<time>.dump db:/tmp/restore.dump
docker compose exec db dropdb -U postgres --force --maintenance-db=template1 postgres
docker compose exec db createdb -U postgres postgres
docker compose exec db psql -U postgres -c 'alter default privileges revoke execute on functions from public'
docker compose exec db sh -c "pg_restore --list /tmp/restore.dump | grep -v -E ' (SCHEMA|COMMENT) - (SCHEMA )?public ' > /tmp/restore.list && pg_restore -U postgres --no-owner --single-transaction --exit-on-error --use-list=/tmp/restore.list -d postgres /tmp/restore.dump"
docker compose start msaving
docker compose exec msaving python -m app.admin repurge
```

The last line deletes again any account that was deleted for good after that backup was taken.

## When the web app can't help

```bash
docker compose exec msaving python -m app.admin reset-password <username>   # a one-time reset link, admin included
docker compose exec msaving python -m app.admin make-admin <username>       # a new admin
```

## Your own database

MSaving runs its own PostgreSQL by default. To use yours instead (PostgreSQL 15 or newer, or a Supabase
project's direct connection), set it in `.env`, as the database's owner:

```
ADMIN_DATABASE_URL=postgresql://postgres:PASSWORD@HOST:5432/postgres?sslmode=require
```

and start without the built-in one: `docker compose up -d --scale db=0`. The server creates its own limited
logins in that database.

## Settings

All optional, in a `.env` file next to `docker-compose.yml` ([example](.env.example)):

| Setting | Default | What it does |
|---|---|---|
| `PORT` | `8080` | The port on the server |
| `BIND` | `127.0.0.1` | Who can reach that port: `127.0.0.1` this machine only, `0.0.0.0` every network |
| `COMPOSE_PROFILES`, `DOMAIN` | | `https` and your domain: HTTPS through Caddy |
| `MSAVING_VERSION` | `latest` | Which release to run |
| `ADMIN_DATABASE_URL` | | Your own database instead of the built-in one |
| `OXR_APP_ID` | | Exchange rates from Open Exchange Rates with your key, instead of the free source |
| `JOBS_HOUR` | `19` | When the daily jobs run, as an hour in UTC (19 = 02:00 in Vietnam) |
| `COMPOSE_PROFILES` `updater` | | One-click updates from the web app (see Update) |
| `UPDATE_CHECK` | `on` | `off`: never ask GitHub whether a new version is out |

## Security

- Passwords are stored as argon2id hashes; sign-in tokens only as their SHA-256. Optional two-step
  verification with an authenticator app, and recovery codes.
- Every account sees only its own books: the database enforces it (row-level security), and the server
  connects with a login that can't get around it.
- Sign-in, sign-up and codes are rate limited. No analytics, no tracking, no third-party scripts.
- In a browser, only this server's own web app can use its API: a copy of the web app on another address, or
  any other website, is refused. The mobile app connects from any number of phones.
- You are responsible for your server: keep it updated, use HTTPS beyond your own machine, and copy the
  backups elsewhere.

Found a security problem? Please report it privately through GitHub's
[security advisories](https://github.com/LeeMinNguyeen/msaving/security/advisories/new), not in a public issue.

## Development

```bash
git clone https://github.com/LeeMinNguyeen/msaving && cd msaving
docker compose up -d --build          # the whole stack from this checkout, at http://localhost:8080
```

`backend/` is the API (Python, FastAPI, PostgreSQL), `web/` the web app (React, TypeScript). Each has a
`CLAUDE.md` with its commands and rules. Pull requests go to `dev`.

## License

[GNU AGPL-3.0](LICENSE). You may run, change and share MSaving; if you run a changed version for others, you
must share your changes with them. It comes with no warranty.
