# Deploy (owner, one time)

Agents did not create any of these resources. Everything below is done by the owner.

## 1. Supabase (Postgres)
1. Create a project (paid tier recommended so it never pauses). Region close to the worker.
2. Settings > Database: copy the **direct connection** string (or the session pooler) for the worker and CLI: `DATABASE_URL`.
3. Deploy the worker once (step 2 below) so it runs the migrations, then run `infra/supabase-readonly-role.sql` in the SQL editor (change the password).
4. Build `DATABASE_URL_READONLY` with the `rat_api` user (the transaction pooler is fine for the API).
5. Turn on daily backups (see `backup-restore.md`).

## 2. Railway (worker + API)
1. New project from the GitHub repo `MikuEspana/rat`.
2. Service **worker**: config file path `infra/railway.worker.json`. Exactly 1 replica.
3. Service **api**: config file path `infra/railway.api.json`. Generate a public domain.
4. Variables (Railway > Variables), from `.env.example`:
   - both: `DATABASE_URL` (worker) / `DATABASE_URL_READONLY` (api), `DRY_RUN=true`, `COIN_MINT` (empty until launch), `CREATOR_PUBKEY`, `FUND_PUBKEY`, `STOCKS_FILE=config/stocks.json`
   - worker only: `KEY_ENCRYPTION_KEY` (32 random bytes, base64), `KEY_VERSION=1`, `RPC_URL`, `RPC_URL_BACKUP`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
   - api only: `CORS_ORIGIN` (your site domain), `API_CACHE_SEC=3` (the API listens on the `PORT` Railway injects, `API_PORT` is only a fallback)
5. Leave `LIVE_CONFIRM` empty until launch.

Generate the master key on your own machine: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Store it in your password manager too.

## 3. Keys (from a machine with the production env)
See `keys.md`: import the creator and fund keys, fill the rat key pool.

## 4. Vercel (your site)
- Point the site at the API domain: it reads `/api/state` every 5s, `/api/rats` every 30s, `/api/events?afterId=` every 5s (see `CONTRACT.md`).
- Until the API is up, animate against `pnpm mock:api` (live-changing mock data on localhost:8787, see `CONTRACT.md`) or the static `packages/contract/mock/*.json`.

## 5. Check
- `rat status` shows DRY RUN, both keys imported, the key pool, heartbeats.
- `curl https://<api-domain>/health` returns `{ "ok": true, "mode": "dry_run", ... }` once the worker runs.
