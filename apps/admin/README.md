# @rat/admin

Private admin page. One password, no JavaScript, refreshes itself every 15 seconds.

- **Shows**: mode (DRY RUN / LIVE), kill switch, ledger buckets (available, spent in the last hour, cap used, open reservations), claimed / burned totals, fund share owed, rats by status, the last 25 transactions (Solscan links), errors (failed transactions and worker loop errors), worker loops.
- **Buttons**: KILL (the same code as `rat kill`, always allowed) and Resume (the same code as `rat resume`, type `RESUME` to confirm; an env `KILL_SWITCH=true` cannot be resumed from here).
- **Worker-down watchdog**: every minute it checks the worker's loop heartbeats; no loop for 3 minutes = a critical Telegram alert (again every 30 minutes while down, and once when it is back) and a red WORKER DOWN banner. Set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` on this service too.
- **Never** sends a transaction and never reads a private key.

## Run

```
ADMIN_PASSWORD='at least 16 characters' DATABASE_URL=... pnpm --filter @rat/admin start   # http://localhost:8790
```

Deploy: `infra/railway.admin.json` (see `docs/runbooks/deploy.md`). Needs the worker's `DATABASE_URL` (the kill switch is a database setting).

## Security

- HTTP Basic auth over HTTPS; the password is compared in constant time. Refuses to start with a password under 16 characters.
- 10 wrong passwords from one IP lock it out for 15 minutes.
- Every POST needs a CSRF token from the page (valid 1 to 2 hours) and must come from the same origin.
- `Cache-Control: no-store`, no framing, strict content security policy, every value HTML-escaped.
