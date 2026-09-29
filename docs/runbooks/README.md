# Runbooks

| Runbook | When |
|---|---|
| [MORNING.md](MORNING.md) | the morning of the launch: the fast rehearsal, production prep, the launch, in order with minutes |
| [rehearsal.md](rehearsal.md) | the mainnet rehearsal (the fast version on your Mac, or on Railway) |
| [auto-deploy.md](auto-deploy.md) | what a merge to `main` does to production, and what to switch on before the launch |
| [setup-mac.md](setup-mac.md) | the whole setup on a Mac in one command (`scripts/setup-mac.sh`): what each step shows, what to do if one fails |
| [deploy.md](deploy.md) | first setup: Railway (Postgres, worker, API, admin, backup), Vercel, env vars (config only, done by the owner) |
| [go-live.md](go-live.md) | launch day, step by step |
| [kill-switch.md](kill-switch.md) | stop everything now |
| [keys.md](keys.md) | import, rotate, back up keys; how rat wallets are created |
| [backup-restore.md](backup-restore.md) | database backups (Railway plus a nightly encrypted dump outside Railway), restore drill, restore |
| [incident.md](incident.md) | something looks wrong |

All commands run from the repo root. `rat` means `pnpm --filter @rat/cli rat` with the production env loaded.
