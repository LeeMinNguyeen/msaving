# CLAUDE.md: web

The React web app for MSaving, served by the server itself (same origin as the API). Monorepo rules:
`../CLAUDE.md`. Workspace rules: `~/projects/msaving/CLAUDE.md`. How it works: the public docs
(https://msaving.leminhnguyen.com/docs/); decisions and the screens: the private msaving-docs (MVP scope).

## Stack

React, Vite, TypeScript, TanStack Query, React Router, i18next (react-i18next), Material UI (MUI's default
theme following the device's light/dark setting), Vitest (with jest-dom matchers), oxlint. npm, Node 22.
Not decided yet (pick a default, label it, record it in msaving-docs Decisions): form library (plain controlled inputs
and FormData so far).

## Layout and commands

```
src/
  config.ts          build-time settings, all optional: the mobile app's store links
  auth/              session.ts (the token, in localStorage), useSession, signOut, forms (new-account form, signed-in submit)
  lib/api.ts         fetch wrapper (bearer token, ApiError with the API's code; a 401 not_signed_in forgets the token) and types
  lib/queries.ts     TanStack Query hooks and keys (useInstance, useMe, ...)
  lib/money.ts       format and parse amounts in minor units by language, no floats
  components/        Shell (sidebar, book switcher, admin link), AccountForm (fields before sign-in), pickers, errors
  i18n/              vi.json (default), en.json, i18next setup; strings.test.ts checks the keys match
  pages/             one file per screen; App.tsx routes (sign-in, join, reset, setup when the server has no admin)
```

```bash
npm install
npm run dev                    # http://localhost:5173, /v1 proxied to the API on 127.0.0.1:8000 (backend/scripts/dev.sh)
MSAVING_API=http://127.0.0.1:8080 npm run dev     # or against the compose stack
npm run lint && npm test && npm run build
```

## Screens

Before sign-in: Sign in, Join (invite code from `/join?code=`), Reset password (`/reset?token=`), Set up this
server (only while the server has no admin). Signed in: Create a book, Dashboard, Add/edit transaction,
Transactions, Accounts (with people), Categories and budgets, Book settings, Profile and security (password,
two-step with recovery codes, devices, export, delete account), Server admin (admin only: server name, sign-up
mode, invites with link and QR, accounts, reset links), Account closing. Desktop first; phones get a working
layout until the mobile app ships.

## Rules

- **Same origin.** The server serves this app; API calls go to `/v1` on the same address. Never hardcode a
  domain. Invite and reset links are built from `window.location.origin`.
- **Never call the database.** Everything goes through the API with the session token.
- **Money:** integers in minor units from the API; `Intl.NumberFormat` in the user's locale (`1.250.000 ₫` in
  Vietnamese, `1,250,000 ₫` in English). Amount fields parse by the same locale and the currency's decimals.
- **Languages:** Vietnamese default, English second. One string file per language, same keys (the tests fail
  otherwise). API error codes are translated under `errors.*`. User-typed text is never translated.
- **Concurrency:** send the `version` you loaded; on 409, reload and tell the user. Generate a transaction's id
  when the user taps Save and reuse it on retry.
- **Freshness:** refetch on window focus and about every minute.
- **Security:** the server sends a strict CSP (scripts `'self'` only; `style-src 'unsafe-inline'` for MUI's
  Emotion; QR codes are `data:` images from the API). No third-party scripts, fonts or analytics. Nothing in
  localStorage but the session token and the language choice.
- **From the old app** (msaving-docs, The old app, private): accounts left out of net worth are greyed out but
  clickable; category colours from a preset grid; "Add starter categories" on by default; the category picker
  on a transfer lists only transfer categories.

## Gotchas

- i18next's `<Trans>` drops tags named like HTML void elements (`<link>`, `<br>`, `<img>`...): use names like `<policy>`.
- Queries that need a session pass `enabled`; the cache is cleared on sign-out (`main.tsx`).
- Fast refresh: files under `pages/` and `components/` export components only; shared functions go in `auth/` or `lib/`.
