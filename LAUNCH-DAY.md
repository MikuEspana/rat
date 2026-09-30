# Launch day

Read top to bottom. One box at a time. Details live in `docs/runbooks/go-live.md`; this page is the short version.

Setup first: `scripts/setup-mac.sh` (one command, `docs/runbooks/setup-mac.md`) ends with a green checklist.
Every `rat ...` command below runs inside Railway: type it as `scripts/rat.sh ...` from `~/wallstreetrats` (for example `scripts/rat.sh preflight --live`).

**Something went wrong? `docs/runbooks/INCIDENTS.md`**: one screen per problem, the exact fix command.

**If anything feels wrong: KILL.** `rat kill --reason "why"` or the red KILL button on the admin page. It only stops new transactions. Nothing is lost, nothing is undone. Resume later with `rat resume`.

## The 3 emergency moves

| Situation | Do this |
|---|---|
| Anything looks off | `rat kill` (or admin page KILL). Safe at any moment. |
| Telegram says `unknown_signed_...` (a tx you did not send, signed by a bot wallet) | The bot already killed itself. Assume a leaked key. Follow `docs/runbooks/incident.md`. |
| The rats' tokens or SOL must be moved to safety | `rat sweep --to <your cold wallet>` prints a plan. Re-run with the exact `--confirm` phrase it prints. |

## The night before

- [ ] `rat preflight` says **READY**.
- [ ] Pacing is on by default: `MAX_HIRES_PER_LOOP=20` and `SPEND_CAP_SOL_PER_HOUR_HIRE=60` (about 34 rats a minute, steady, no long pauses). Leave them unless you mean to change them.
- [ ] Jupiter: the **Free** key is enough. The worker never makes more than 40 calls in any minute (hard budget; the Free tier allows 60), so your own CLI checks on the same key stay under the limit too. A `jupiter_429` alert means something else is using the key.
- [ ] `rat alert-test` arrives on your phone. Phone charged, Telegram notifications on, not muted.
- [ ] `KEY_ENCRYPTION_KEY` backed up offline (without it the rat wallets are lost).
- [ ] Backups: Railway Daily and Weekly backups on, the nightly encrypted dump has run at least once (a file in your bucket), and you did one restore drill on it: `infra/backup/restore-check.sh` says **PASS** (`docs/runbooks/backup-restore.md`). The age private key (`~/rat-backup.key`) is in your password manager.
- [ ] Admin service has `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` too: it alerts you if the worker dies (the worker cannot).
- [ ] Cold wallet address written down (for an emergency sweep). It must NOT be the creator or a rat wallet.
- [ ] Admin page opens with your password.
- [ ] `scripts/site-go-live.sh` says **SITE READY**: wallstreetrats.world reads the production API and shows the honest pre-launch state (the "The rats are clocking in..." banner, 0 rats, market cap "pre-launch").
- [ ] Go to sleep.

## T-1 hour: arm the bot, then launch the coin

- [ ] Fund the creator wallet with about **0.35 SOL**: 0.1 dev buy + launch cost + 0.05 reserve + 0.15 for 5 founding rats + spare. It is the bot's only wallet besides the rats'.
- [ ] From `~/wallstreetrats`, start **`scripts/launch.sh` BEFORE the coin exists.** It checks this is the production bot, in DRY RUN, the creator wallet's balance, and the preflight (read-only). Only the coin's own lines may FAIL yet.
- [ ] **Type GO to arm.** The bot restarts LIVE with its kill switch ON ("armed"): it sends nothing and waits 30 minutes for your coin. The founding rats are booked. It prints **ARMED**.
- [ ] Now launch on pump.fun from the creator wallet: name Wall Street Rats, ticker WSR, **normal mode, no holder rewards, no fee sharing, no cashback**, dev buy **0.1 SOL** inside the launch.
- [ ] The dev-buy coins stay in the creator wallet **forever**. Never sell or move them (anything signed by the creator wallet stops the bot). They are never counted as fees and the bot can never move them. Your own trading: your separate wallet only.
- [ ] **Paste the CA** pump.fun shows (or just press Enter once Solscan shows the launch). The script finds the launch on chain; if it is not the CA you pasted, it asks.
- [ ] It registers the coin: the site shows the CA, the kill switch is released, fee claims start and the founding rats walk in within about 30 s. No build in between.
- [ ] Then, no hurry: the coin goes into the worker's and the API's settings, one restart (hiring pauses about a minute), `rat preflight --live`. It ends with **LIVE**.
- **It stopped halfway?** **Run `scripts/launch.sh` again.** It goes on from where it stopped: armed, it asks whether you already created the coin (never create a second one) and goes on from the CA; a coin it already found, it keeps. If the bot already runs LIVE with its coin, it says so and only offers what is left to restart.
- The rehearsal: `scripts/launch.sh --rehearsal` from `~/wallstreetrats-staging` runs this same flow on staging. By hand instead: `docs/runbooks/go-live.md`.

## T-0: watch it

- [ ] Admin page: mode **LIVE**, kill switch off, worker loops a few seconds old.
- [ ] Solscan: first claim (all of it stays in the creator wallet for hires).
- [ ] Site: first rats walk in.

## What normal looks like

- About 17 new rats a minute, about 1,000 an hour.
- "Waiting" budget grows during the rush. Normal: at most 60 SOL per hour is spent on hires; the rest waits and is spent later. Nothing is lost.
- No buy and burn: every claimed lamport hires rats. The portfolio is the rats' stocks.
- The site: past about 5,800 rats every desk is taken and new hires line up outside the lobby (the job-fair line). That is by design.
- Worker restarts and redeploys are safe at any moment (tested at every single step).

## Telegram: which alerts matter

| Alert | Meaning | Do |
|---|---|---|
| `cap_alert_*`, `cap_reached_*` | 50% / 100% of the hourly cap used. Spending waits for the window. | Nothing. |
| `inflow_*` | Someone sent SOL to a bot wallet. It is never spent. | Nothing. |
| `external_claim_*` | Someone else triggered our fee claim. Booked for hires as usual. | Nothing. |
| `no_eligible_stocks`, `hire_idle` | No hires (usually stale stock prices: markets closed). | Check the admin page. Wait, or approve more stocks. |
| `claim_failed` | One attempt failed; the money waits for the next one. | Nothing, unless it repeats for 30+ minutes. |
| `task_failing_*` | A worker loop keeps failing. | Railway logs. Restarting the worker is safe. |
| `worker_down` (from the admin service) | The worker stopped running (crash, restarts used up). | Railway: restart the worker, read its logs. |
| `wallet_low_*` | A bot wallet is below its reserve. | Send a little SOL **to** it. |
| `effects_*` | A transaction was refused: it would have taken more than allowed. Nothing was sent. | **KILL.** Do not resume until you know why. |
| `overspend_*`, `rat_balance_*`, `hire_no_tokens_*` | Money did not match what was expected. | **KILL**, then check the admin page and `rat status`. |
| `unknown_signed_*`, `watch_overflow_*` | Possible leaked key or a flood hiding one. The bot killed itself. | `docs/runbooks/incident.md`. |

## Never do this while live

- Send a transaction **from** the creator wallet (it trips the kill switch). Sending SOL **to** it is fine.
- Claim the creator fees on pump.fun yourself.
- Flip `DRY_RUN` back and forth.
- Sweep to one of the bot's own wallets (the CLI refuses anyway).

## End of the day

- [ ] `rat status` and the admin page: claimed vs spent, nothing stuck.
- [ ] `rat audit` says **AUDIT PASSED**: every claim equals what left the fee vaults on chain, every rat was paid once and holds what the database says, and the creator wallet's SOL over every bot transaction equals the ledger to the lamport. WAIT means a hire is in flight: run it again in a minute. Any FAIL: `rat kill`, then read the line.
- [ ] `scripts/keys-backup.sh` on your Mac, from `~/wallstreetrats` (every hour or so while hiring, and once at the end). It ends with `OK saved N keys` and a file in `~/wallstreetrats-key-backups/`. Store that folder away from `KEY_ENCRYPTION_KEY`. The rat wallets' keys exist nowhere else. (Not `rat keys backup --out <file>`: inside Railway that file stays on the worker's disk and is wiped by the next deploy.)
- [ ] Coin dying: the bot hires with what is left, then idles. Leave it running, or `rat kill`.

## Numbers to remember

- Salary 0.03 SOL per rat. Every claimed lamport hires rats (no buy and burn).
- Cap: 60 SOL per hour for hires (about 2,000 rats an hour), at most 20 per 35 s loop; the rest waits and is spent later.
- 180 SOL of creator fees = about 6,000 rats (about 6 hours of hiring at the cap).
