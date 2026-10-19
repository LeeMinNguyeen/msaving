# CLAUDE.md: msaving-web

React web app for Project MSaving, the MVP client. Workspace-wide rules are in `~/projects/msaving/CLAUDE.md`; decisions, design and the MVP's screens and build order in **msaving-docs** (the source of truth). A change to a decision or to documented behaviour comes with a paired msaving-docs PR.

## Stack

React, Vite, TypeScript, TanStack Query. Supabase JS client for sign-in only. Everything else goes through the FastAPI API with the access token as a bearer token.

Decided (msaving-docs, Decisions: Web app tools): npm, React Router, i18next (react-i18next), Vitest (with jest-dom matchers), oxlint (from the Vite template), Material UI (`@mui/material`, MUI's default theme following the device's light/dark setting until there's a design). Node 22.

Hosting: Firebase Hosting, site `<project>-app` in each environment's Google Cloud project. `scripts/firebase-json.mjs` writes `firebase.json` at deploy time (CSP naming that environment's API and Supabase); `.github/workflows/deploy.yml` deploys on merge to staging/main once the repository variable `DEPLOY_ENABLED` is true. Setup: msaving-docs Operations → Cloud setup.

Not decided yet (pick a default, label it, and record it in msaving-docs Decisions): form library (plain controlled inputs so far).

## Layout and commands

```
src/
  config.ts          build-time settings (VITE_API_URL, VITE_SITE_URL, VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY)
  lib/supabase.ts    Supabase client, sign-in only
  lib/api.ts         fetch wrapper (bearer token, ApiError with the API's error code) and the API's types
  lib/queries.ts     TanStack Query hooks and keys
  lib/money.ts       format and parse amounts in minor units by language, no floats
  auth/              session hook
  components/        shared pieces: Shell (top bar, book switcher), AmountField, pickers, error text
  i18n/              vi.json (default), en.json, i18next setup; strings.test.ts checks the keys match
  pages/             one file per screen; App.tsx routes and sends each user to the step they're missing
```

```bash
cp .env.example .env.local     # untracked; works as is (development's sign-in, API on your machine)
npm install
npm run dev                    # http://localhost:5173 (the API's CORS and Supabase's redirect list expect this origin)
npm run lint && npm test && npm run build
```

Sign-in uses the shared **development** environment, so accounts and data you create live there (made-up data
only). The API runs locally from msaving-backend (`uvicorn ... --port 8000`). **Frontend-only work:** set
`VITE_API_URL=https://msaving-api-dev.leminhnguyen.com` and skip the backend; the dev API allows
`http://localhost:5173`. Only someone changing the schema switches to local Supabase (the commented lines in
`.env.example`).

## Screens (MVP, 12)

Sign up / sign in (with TOTP and Turnstile), Choose username (with privacy policy consent checkbox; this creates the account), Create a book, Dashboard (home), Add/edit transaction, Transactions (filters, edit history), Accounts (incl. people lent/borrowed), Categories and budgets, Book settings, Profile and security (devices, 2FA, export, withdraw consent, delete account), Updated privacy policy (blocks the app until agreed or withdrawn), Account closing (deletion date and Restore). Designed for desktop first: sidebar layout from the `md` breakpoint, tables where there's a list. Phones still get a working layout (top bar, lists, full-screen dialogs) until the mobile app is in the stores; then `VITE_APP_STORE_URL` / `VITE_PLAY_STORE_URL` are set and phones are sent there (`lib/store.ts`). Tablets stay on the web app.

## Rules

- **Never call the database or Supabase Data API.** Supabase is for Auth only. Never ship the `service_role` key or any secret; build-time config holds public values only.
- **Money:** integers in minor units from the API; format with `Intl.NumberFormat` in the user's locale (`1.250.000 ₫` in Vietnamese, `1,250,000 ₫` in English). Never do money math in floats. Amount fields group thousands while typing and parse by the same locale and the currency's decimals: in Vietnamese `.` groups thousands, so "1.250" for VND is 1250.
- **Languages:** Vietnamese is the default, English second. One string file per language, same keys (CI fails otherwise). Error codes from the API (`plan_limit`, `consent_required`, ...) are translated here. Database labels like "Deleted user" ("Người dùng đã xóa") and currency names are translated here. User-typed text is never translated.
- **Concurrency:** send the `version` you loaded; on 409, reload and tell the user. Generate a transaction's id when the user taps Save and reuse it on retry.
- **Freshness:** refetch on window focus and about every minute (TanStack Query).
- **Security:** strict Content-Security-Policy from `scripts/firebase-json.mjs` (`style-src` needs `'unsafe-inline'` for MUI's Emotion; scripts `'self'` only; adding Turnstile means adding `https://challenges.cloudflare.com` to script-src and frame-src); no third-party scripts beyond what sign-in needs; short access-token lifetime; "Sign out other devices" in Profile.
- **URLs:** no hardcoded domains; read `API_URL` and `SITE_URL` (privacy policy at `SITE_URL/privacy/<version>`) from environment config. Prod app runs at `msaving-app.leminhnguyen.com`, dev at `msaving-app-dev.leminhnguyen.com`.
- **Sign-up flow:** the email must be confirmed from the link before the account exists; pass the chosen language as Supabase user metadata so Auth emails use it. Password minimum 10 characters.
- **From the old app** (`LeeMinNguyeen/BudgetTracking-App`, see msaving-docs Product → The old app): reuse `src/locales/vi.json` and `en.json` as the first draft of the string files, and `src/utils/currencies.ts` for currency names and symbols. Accounts left out of net worth show greyed out but stay clickable. Category colours come from a preset grid (the old `CategoryFormScreen` has one). Create a book has an "Add starter categories" tick, on by default. The category picker on a transfer lists only transfer categories, and on anything else hides them.
- **Shared API client and types** with mobile later: a shared package or generated from FastAPI's OpenAPI schema. Undecided.

## Branches

feature (from `dev`) -> `dev` (deploys nowhere) -> `staging` (deploys to development) -> `main` (production). All protected, PR with passing checks only.

## Don't

- Don't add shared books, payments, Premium or AI screens in the MVP; the API may expose tables for them, the UI doesn't.
- Don't store financial data in localStorage beyond what the auth client needs.
- Don't add analytics or tracking cookies (none decided).

## Gotchas

- i18next's `<Trans>` drops tags named like HTML void elements (`<link>`, `<br>`, `<img>`...): use names like `<policy>`.
- Queries that need a session pass `enabled`; the cache is cleared on sign-out.
