# Infra

Config only. **Nothing here has been created or deployed by agents** (no Railway, Vercel or bucket resources).

| File | What |
|---|---|
| `Dockerfile` | one image for the worker and the API (Node 22, pnpm, runs TypeScript with tsx). Defaults to `DRY_RUN=true`. |
| `railway.worker.json` | Railway config-as-code for the worker service: 1 replica, restart on failure. |
| `railway.api.json` | Railway config-as-code for the API service: health check on `/health`. |
| `railway.admin.json` | Railway config-as-code for the private admin page: health check on `/health`. |
| `railway.backup.json` | Railway config-as-code for the nightly backup cron service (its own image, no restarts; the schedule is set in the service settings). |
| `backup/` | `backup.sh` (pg_dump, age encryption, signed upload to a bucket outside Railway, Telegram alert on failure), its `Dockerfile`, `restore-check.sh` (restore drill) and `selftest.sh` (the whole loop, local, run by CI). |
| `readonly-role.sql` | creates the read-only `rat_api` user for `DATABASE_URL_READONLY`. |

See `docs/runbooks/deploy.md` for the step-by-step setup.
