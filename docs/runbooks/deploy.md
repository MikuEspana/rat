# Deploy (owner, one time)

Agents did not create any of these resources. Everything below is done by the owner.

**On a Mac, one command does all of it** (Railway, R2 backups, secrets, the creator key, preflight, a restore drill): `scripts/setup-mac.sh`, see `setup-mac.md`. This page is the same setup by hand.

## 1. Postgres (Railway, same project as the bot)
The code only needs plain Postgres through `DATABASE_URL` (node-postgres and plain SQL migrations, nothing Supabase specific).
1. In the Railway project (step 2): **+ New > Database > PostgreSQL**. Keep the service name `Postgres`: the references below use it. It runs Postgres 16 and is private by default; leave Public Access off.
2. On the api service: `RAT_API_DB_PASSWORD` = the output of `openssl rand -hex 32` (hex, so it is safe inside a URL). Keep it in your password manager too.
3. Service variables are Railway references, so the database password is never copied anywhere:
   - worker and admin: `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - api: `DATABASE_URL_READONLY=postgresql://rat_api:${{RAT_API_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}`

   `DATABASE_URL` is a direct connection over the private network, which the single-worker lock needs (a session advisory lock): never put PgBouncer in front of the worker.
4. Deploy the worker once (step 2) so it runs the migrations. Then create the API's read-only user: `railway connect Postgres` opens psql without showing you any password; run `\i infra/readonly-role.sql`, then `\password rat_api` and paste `RAT_API_DB_PASSWORD`.
5. Backups: turn on Railway's volume backups and the nightly encrypted offsite dump (see `backup-restore.md`).
6. The CLI against production runs inside Railway, where `DATABASE_URL` already is: `railway ssh --service worker`, then `pnpm --filter @rat/cli rat status`. Nothing is copied to your laptop.

## 2. Railway (worker, API, admin page)
1. New project from the GitHub repo `MikuEspana/rat`.
2. Service **worker**: config file path `infra/railway.worker.json`. Exactly 1 replica.
3. Service **api**: config file path `infra/railway.api.json`. Generate a public domain.
4. Service **admin** (private admin page, optional but recommended): config file path `infra/railway.admin.json`. Generate a domain and keep it to yourself. Variables: `ADMIN_PASSWORD` (at least 16 characters, from your password manager), `DATABASE_URL=${{Postgres.DATABASE_URL}}` (the kill switch is a database setting), `DRY_RUN` like the worker, and `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` for its worker-down watchdog (a Telegram alert when the worker's loops stop for 3 minutes, since a dead worker cannot alert by itself). It serves HTTPS on Railway; open it, log in with any user name and the password.
5. Variables (Railway > Variables), from `.env.example`:
   - both: `DATABASE_URL` (worker) / `DATABASE_URL_READONLY` (api) as references (step 1), `DRY_RUN=true`, `COIN_MINT` (empty until launch), `CREATOR_PUBKEY`, `STOCKS_FILE=config/stocks.json`
   - worker only: `KEY_ENCRYPTION_KEY` (32 random bytes, base64), `KEY_VERSION=1`, `RPC_URL`, `RPC_URL_BACKUP`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
   - api only: `CORS_ORIGIN` (your site domain), `API_CACHE_SEC=3` (the API listens on the `PORT` Railway injects, `API_PORT` is only a fallback)
6. Leave `LIVE_CONFIRM` empty until launch.
7. Service **backup** (nightly encrypted offsite dump): config file path `infra/railway.backup.json`. Variables and schedule: `backup-restore.md`.

Generate the master key on your own machine: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Store it in your password manager too.

## 3. Keys (inside Railway: `railway ssh --service worker`)
See `keys.md`: import the creator key. Rat wallets are created at hire time (nothing to prepare).

## 4. Vercel (your site)
- Point the site at the API domain: it reads `/api/state` every 5s, `/api/rats` every 30s, `/api/events?afterId=` every 5s (see `CONTRACT.md`).
- Until the API is up, animate against `pnpm mock:api` (live-changing mock data on localhost:8787, see `CONTRACT.md`) or the static `packages/contract/mock/*.json`.

## 5. Check
- `rat status` shows DRY RUN, both keys imported, heartbeats.
- `curl https://<api-domain>/health` returns `{ "ok": true, "mode": "dry_run", ... }` once the worker runs.
