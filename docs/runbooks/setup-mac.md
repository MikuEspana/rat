# Setup on a Mac: one command

`scripts/setup-mac.sh` does the whole backend setup: Railway (Postgres, worker, api, admin, backup), a private R2 bucket for the nightly encrypted backups, the generated secrets, your API keys, the creator key import, a DRY RUN preflight, a test alert, the first backup and a restore drill.

**Everything stays in DRY RUN.** Nothing in the script can send a mainnet transaction. It never asks for a seed phrase.

## The command
Open Terminal and paste:
```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/MikuEspana/rat/main/scripts/setup-mac.sh)"
```
About 20 to 30 minutes, mostly waiting for builds. Safe to run again at any time: finished steps print **DONE** and are skipped.

## Have these ready
- Homebrew installed (https://brew.sh).
- A Railway account (Hobby plan) and a Cloudflare account with R2 turned on.
- Your Helius RPC URL, your Jupiter API key, your Telegram bot token.
- In Telegram: you sent any message (like "hi") to your bot in the last 24 hours, so the script can find your chat.
- Phantom open, with the creator account `4VYWcTTDYyMVic58AcUC7Nodt6vNQwjKhA9UphaAKiot` (it does not need SOL yet).
- Your password manager open.

## How to read the output
- **OK**: done now. **DONE**: was already done, skipped. **NOTE**: expected, read it and move on.
- **STOPPED**: the line under it says what to fix. Fix it, then paste the same command again.
- Hidden prompts show nothing while you paste. That is on purpose. Paste once, press Enter.

## What you see at each step, and what to do if it stops

| Step | What you see | If it stops |
|---|---|---|
| 1 Tools | `OK railway ..., node ..., age ...`, `OK repo at ~/wallstreetrats`, then `OK Postgres 18 client tools` (the major of `infra/backup/Dockerfile`, installed with `brew install postgresql@18`; no database server runs on the Mac) | Homebrew missing: install it from brew.sh, open a new Terminal, run again. A `brew install` failed: run that one `brew install` yourself and read its error. |
| 2 Logins | Two browser windows (Railway, then Cloudflare): click Authorize / Allow. Then `OK Cloudflare account ...` and `OK SSH key registered` | Run `railway login` or `npx wrangler login` by hand, then run the command again. |
| 3 Railway project | `OK project wall-street-rats created`, Postgres and 4 services, then per service `OK worker builds with infra/Dockerfile` and `OK worker runs in EU West (Amsterdam)` (Postgres moves there right after it is created, its volume too) (builder, start command and restart rules set on the service and read back before anything is built), then `OK versions match: Railway's Postgres 18, the backup job's pg_dump 18, this Mac's tools 18` | Check railway.com/dashboard: a Hobby plan is needed. "Railway's database runs Postgres N, but the backup job ... are M": the backup and the drill would fail; `infra/backup/Dockerfile` must name the database's major, then run again. `Railway has not applied it yet ... Reading it again`: normal, Railway applies setting changes in the background (slower during an incident on status.railway.com); the script reads them again for up to 5 minutes. "Railway still does not show the build settings": open the exact page it prints and compare. Right there: Railway is still applying them, run again later (or put `WSR_APPLY_WAIT_SEC=900` in front of the command to wait longer). Wrong there: set Builder to Dockerfile and the Dockerfile path shown, then run again. |
| 4 R2 bucket | `OK bucket wsr-db-backups-xxxxxx created`, the 30-day rule, then 6 clicks in the Cloudflare page it opens (the list is on screen) and 2 hidden prompts for the token | "refused that token": make sure it is Object Read & Write and scoped to the bucket name shown, paste both values again. "could not create the R2 bucket": turn on R2 in the Cloudflare dashboard. |
| 5 Generated secrets | A big box: **SAVE THESE FILES IN YOUR PASSWORD MANAGER NOW**, then 4 file paths in `~/rat-secrets` | Save all 4 files, then press Enter. If it says the worker has a DIFFERENT master key: stop and ask, never replace it (the stored wallet keys depend on it). |
| 6 Your secrets | Hidden prompts: Helius URL, optional backup RPC, Jupiter key, Telegram token. Then `Detected chat: <your name>. Is that you?` and `OK ... DRY_RUN=true everywhere`, then the worker builds | "did not answer" / "HTTP 401" / "rejected": the value was wrong, paste it again. No chat found: send "hi" to your bot, press Enter. Worker did not start: the last log lines are shown. If they say Railpack or "No start command detected", just run the command again: step 3 fixes the build settings and step 6 rebuilds the worker from the latest commit (`rebuilding worker`). |
| 7 Creator key | Right before it: `OK railway ssh reaches the worker and its settings`. Then two lines on where Phantom shows the key, one hidden prompt, `OK creator key imported ... (clipboard cleared)`, then the api and admin build | `DONE creator key ... (stored, decrypts with the master key, matches)` when a run already stored it: no paste. "not imported: the creator key is X but CREATOR_PUBKEY is Y": you copied another account's key. Pick the creator account in Phantom and paste again. "a creator key is stored but does not work": the line says why (for example it does not decrypt with the worker's KEY_ENCRYPTION_KEY); nothing was changed. "Railway does not know this SSH key yet": open the link it prints and sign in with your Railway account (or run the `railway ssh keys add` line it prints), then run again. "its settings ... could not be handed to the rat command": the line after it says what was tried (names only); check DATABASE_URL and KEY_ENCRYPTION_KEY on the worker, or use the route without ssh below. |
| 8 Preflight + alert | The preflight table. Expected before launch: FAIL `settings` (no COIN_MINT yet), FAIL `creator wallet` (0 SOL, you fund it right before launch), WARN for stocks and the watch floor. Then `Did it arrive on your phone?` | Any other FAIL line stops the script: that line says how to fix it. No alert on the phone: open the bot, press Start, run again. |
| 9 Backup | `OK first backup uploaded`, `OK ... every night at 03:30 UTC`, a yes/no for a free healthchecks.io check, then the restore drill table and `OK restore drill PASSED` | "first backup failed": the reason is on the line above (usually the R2 token). Drill did not pass: nothing was changed on Railway, send the lines above to your engineer. |
| 10 Done | A green checklist, the admin page URL, the public API URL and the NEXT STEP | |

**Railway having trouble** (`Failed to fetch: error decoding response body`, "Railway did not answer"): every Railway call that is safe to repeat is tried 3 times, and every variable written is read back. If it still stops, Railway's API is down (status.railway.com): run the same command again later, finished steps are skipped. A failed read is never taken for "not set": a secret already on Railway (above all the master key) is never replaced, and no secret file in `~/rat-secrets` is ever generated again.

The healthchecks.io check (step 9, optional) alerts you if a night's backup never starts at all. Before you answer yes: sign up at healthchecks.io, add their Telegram integration, then create an API key (Settings > API Access, not read-only).

## After setup
- Next: `LAUNCH-DAY.md`, "The night before".
- Right before launch: send about 0.3 SOL to the creator wallet (0.1 SOL dev buy, launch cost, 0.05 SOL reserve).
- The dev buy tokens stay in the creator wallet forever. The bot never counts them as fees, never sells them and refuses any transaction that would move them (go-live.md).
- Run any `rat` command inside the worker from `~/wallstreetrats`: `scripts/rat.sh status`, `scripts/rat.sh preflight --live` (without railway ssh: `scripts/rat-local.sh ...`, see below).
- The script never turns DRY RUN off. That is a step in LAUNCH-DAY.md that you do yourself.

## If `railway ssh` does not work: the route without it
`railway ssh` runs every `rat` command inside the worker. Railway's relay refuses an SSH key it does not know with a JSON answer (`"status":"signup_required"` and a `human_signup_url`) and exit code 0, so nothing runs. The setup script and `scripts/rat.sh` now spot that answer and print the link. Open it, sign in with your Railway account, then run again.

If ssh still cannot be used, `scripts/rat-local.sh` runs the same `rat` commands on this Mac against the Railway database:
```
cd ~/wallstreetrats && scripts/rat-local.sh keys import --role creator
```
- **The key:** it asks for the key in a hidden prompt, encrypts it with the master key on this Mac, and only the encrypted key goes over the network. It clears the clipboard afterwards.
- **The settings:** the worker's variables and Postgres's public address are read with `railway variable list`. They reach the command on stdin, never on a command line, and are never printed.
- **The connection:** the command runs with a clean environment and connects over TLS.
- **The first run** installs the rat CLI's packages into `~/wallstreetrats` (a few minutes, once).
- **It needs Postgres's public address** (Railway dashboard: Postgres > Settings > Networking > TCP Proxy). The script says so if it is off.
- **Any other `rat` command works the same way:** `scripts/rat-local.sh preflight`, `scripts/rat-local.sh status`.

## Region
Every service and Postgres run in **EU West (Amsterdam)**, Railway region `europe-west4-drams3a`. The script sets it on creation and moves anything that runs elsewhere (Postgres with its volume, while the database is still empty; the other services on their next deploy), then checks where each deployment really runs.

Why EU West and not US East:
- About 68% of Solana stake is delegated to validators in Europe, so most block leaders are there (REPORTED: [Helius, Measuring Solana's Decentralization](https://www.helius.dev/blog/solana-decentralization-facts-and-figures)).
- Helius runs RPC nodes in Amsterdam and Frankfurt, next to Railway's EU West (REPORTED: [Helius forum, node locations](https://forum.helius.dev/t/where-are-heliuss-rpc-nodes-located/38)).
- Railway's EU West region is in Amsterdam (VERIFIED: [Railway regions](https://docs.railway.com/deployments/regions)).
- The bot is not latency critical (a claim every 35 s, one Jupiter build per hire), so the gain is small either way; staying next to the RPC and the leaders is the safe default.

## Where things are
| What | Where |
|---|---|
| Generated secrets | `~/rat-secrets` (folder only you can read). Also in your password manager. |
| Setup progress (ids only, no secrets) | `~/rat-secrets/setup-state.env` |
| The repo | `~/wallstreetrats` |
| SSH key for `railway ssh` | `~/.ssh/railway_wsr_ed25519` |

## Official docs for every tool the script uses
- Homebrew: https://docs.brew.sh
- Railway CLI: https://docs.railway.com/cli (variables: https://docs.railway.com/variables, ssh: https://docs.railway.com/cli/ssh, cron: https://docs.railway.com/cron-jobs)
- Wrangler R2 commands: https://developers.cloudflare.com/workers/wrangler/commands/#r2
- R2 API tokens: https://developers.cloudflare.com/r2/api/tokens/
- R2 lifecycle rules: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- age: https://github.com/FiloSottile/age
- Telegram Bot API (getUpdates): https://core.telegram.org/bots/api#getupdates
- healthchecks.io API: https://healthchecks.io/docs/api/
- PostgreSQL 18 pg_restore: https://www.postgresql.org/docs/18/app-pgrestore.html
