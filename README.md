# MSaving

A spending tracker you run yourself, for you, your family or a small group. Your money data stays on your own
machine or server: nobody else runs it, and the project collects nothing.

- Several books (personal, household, a side business), each with its own currency, shared if you like
- Accounts in any currency: cash, bank, savings, investments, credit cards, loans, money lent
- Expenses, income, transfers, refunds, with full edit history; categories, budgets, a dashboard
- Who owes whom: money lent and borrowed, by person
- Daily exchange rates with no account or key needed
- Download everything as readable CSV files; delete your account any time
- Vietnamese and English

Free and open source ([AGPL-3.0](LICENSE)).

## Quick start

On any machine with [Docker](https://docs.docker.com/engine/install/) and git:

```bash
git clone https://github.com/LeeMinNguyeen/msaving
cd msaving
docker compose up -d --build      # builds the server here: a few minutes the first time
docker compose logs msaving       # the setup code
```

Open http://localhost:8080, enter the setup code, and create your account: it becomes the server's admin.
To update later: `git pull && docker compose up -d --build`.

## Documentation

**[https://msaving.leminhnguyen.com/docs/](https://msaving.leminhnguyen.com/docs/)**

- [Install](https://msaving.leminhnguyen.com/docs/getting-started/install/), [accounts and invites](https://msaving.leminhnguyen.com/docs/getting-started/accounts-and-invites/),
  [use it from other devices (HTTPS)](https://msaving.leminhnguyen.com/docs/getting-started/other-devices/), [updates](https://msaving.leminhnguyen.com/docs/getting-started/updates/),
  [backups and restore](https://msaving.leminhnguyen.com/docs/getting-started/backups/), [settings](https://msaving.leminhnguyen.com/docs/getting-started/settings/)
- [How it works](https://msaving.leminhnguyen.com/docs/how-it-works/overview/) and the [security model](https://msaving.leminhnguyen.com/docs/how-it-works/security/)
- [Contributing](https://msaving.leminhnguyen.com/docs/contributing/run-locally/): run it from source, tests, conventions. Pull requests go to `dev`.

Found a security problem? Please report it privately through
[security advisories](https://github.com/LeeMinNguyeen/msaving/security/advisories/new), not in a public issue.

## License

[GNU AGPL-3.0](LICENSE). You may run, change and share MSaving; if you run a changed version for others, you must
share your changes with them. It comes with no warranty.
