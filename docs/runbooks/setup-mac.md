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
| 1 Tools | `OK railway ..., node ..., age ..., psql 16...` then `OK repo at ~/wallstreetrats` | Homebrew missing: install it from brew.sh, open a new Terminal, run again. A `brew install` failed: run that one `brew install` yourself and read its error. |
| 2 Logins | Two browser windows (Railway, then Cloudflare): click Authorize / Allow. Then `OK Cloudflare account ...` and `OK SSH key registered` | Run `railway login` or `npx wrangler login` by hand, then run the command again. |
| 3 Railway project | `OK project wall-street-rats created`, Postgres 16 and 4 services created | Check railway.com/dashboard: a Hobby plan is needed. Then run again. |
| 4 R2 bucket | `OK bucket wsr-db-backups-xxxxxx created`, the 30-day rule, then 6 clicks in the Cloudflare page it opens (the list is on screen) and 2 hidden prompts for the token | "refused that token": make sure it is Object Read & Write and scoped to the bucket name shown, paste both values again. "could not create the R2 bucket": turn on R2 in the Cloudflare dashboard. |
| 5 Generated secrets | A big box: **SAVE THESE FILES IN YOUR PASSWORD MANAGER NOW**, then 4 file paths in `~/rat-secrets` | Save all 4 files, then press Enter. If it says the worker has a DIFFERENT master key: stop and ask, never replace it (the stored wallet keys depend on it). |
| 6 Your secrets | Hidden prompts: Helius URL, optional backup RPC, Jupiter key, Telegram token. Then `Detected chat: <your name>. Is that you?` and `OK ... DRY_RUN=true everywhere`, then the worker builds | "did not answer" / "HTTP 401" / "rejected": the value was wrong, paste it again. No chat found: send "hi" to your bot, press Enter. Worker did not start: the last log lines are shown; open Railway > worker > Deployments. |
| 7 Creator key | Two lines on where Phantom shows the key, then one hidden prompt. `OK creator key imported ... (clipboard cleared)`, then the api and admin build | "not imported: the creator key is X but CREATOR_PUBKEY is Y": you copied another account's key. Pick the creator account in Phantom and paste again. |
| 8 Preflight + alert | The preflight table. Expected before launch: FAIL `settings` (no COIN_MINT yet), FAIL `creator wallet` (0 SOL, you fund it right before launch), WARN for stocks and the watch floor. Then `Did it arrive on your phone?` | Any other FAIL line stops the script: that line says how to fix it. No alert on the phone: open the bot, press Start, run again. |
| 9 Backup | `OK first backup uploaded`, `OK ... every night at 03:30 UTC`, a yes/no for a free healthchecks.io check, then the restore drill table and `OK restore drill PASSED` | "first backup failed": the reason is on the line above (usually the R2 token). Drill did not pass: nothing was changed on Railway, send the lines above to your engineer. |
| 10 Done | A green checklist, the admin page URL, the public API URL and the NEXT STEP | |

The healthchecks.io check (step 9, optional) alerts you if a night's backup never starts at all. Before you answer yes: sign up at healthchecks.io, add their Telegram integration, then create an API key (Settings > API Access, not read-only).

## After setup
- Next: `LAUNCH-DAY.md`, "The night before".
- Right before launch: send about 0.3 SOL to the creator wallet (0.1 SOL dev buy, launch cost, 0.05 SOL reserve).
- The dev buy tokens stay in the creator wallet forever. The bot never counts them as fees, never sells them and refuses any transaction that would move them (go-live.md).
- Run any `rat` command inside the worker from `~/wallstreetrats`: `scripts/rat.sh status`, `scripts/rat.sh preflight --live`.
- The script never turns DRY RUN off. That is a step in LAUNCH-DAY.md that you do yourself.

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
- PostgreSQL 16 pg_restore: https://www.postgresql.org/docs/16/app-pgrestore.html
