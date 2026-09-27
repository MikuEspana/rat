# Infra

Config only. **Nothing here has been created or deployed by agents** (no Supabase, Railway or Vercel resources).

| File | What |
|---|---|
| `Dockerfile` | one image for the worker and the API (Node 22, pnpm, runs TypeScript with tsx). Defaults to `DRY_RUN=true`. |
| `railway.worker.json` | Railway config-as-code for the worker service: 1 replica, restart on failure. |
| `railway.api.json` | Railway config-as-code for the API service: health check on `/health`. |
| `supabase-readonly-role.sql` | creates the read-only `rat_api` user for `DATABASE_URL_READONLY`. |

See `docs/runbooks/deploy.md` for the step-by-step setup.
