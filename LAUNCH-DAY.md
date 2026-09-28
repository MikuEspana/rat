# Launch day

Read top to bottom. One box at a time. Details live in `docs/runbooks/go-live.md`; this page is the short version.

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
- [ ] Admin service has `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` too: it alerts you if the worker dies (the worker cannot).
- [ ] Cold wallet address written down (for an emergency sweep). It must NOT be the creator or a rat wallet.
- [ ] Admin page opens with your password.
- [ ] Go to sleep.

## T-1 hour: launch the coin (bot still in DRY RUN)

- [ ] Fund the creator wallet (0.05 SOL reserve + launch cost). It is the bot's only wallet besides the rats'.
- [ ] Launch on pump.fun from the creator wallet: **normal mode, no holder rewards, no fee sharing**.
- [ ] Dev buy: from a **different** wallet (or move those coins out of the creator wallet now).
- [ ] Solscan: wait for the launch tx to be **Finalized**. Copy its **signature** and **slot**.
- [ ] Worker settings: `COIN_MINT`, `WATCH_FROM_SLOT` = slot + 1, `KNOWN_OWNER_TX_SIGS` = the launch signature (plus any other tx you signed with a bot wallet since).
- [ ] Redeploy (still DRY RUN). The site shows paper claims from the real vault.
- [ ] `rat dry-run-reset --yes`.

## T-0: go live

- [ ] With the live settings, `rat preflight --live` says **READY**. Any FAIL: stop and fix it.
- [ ] Worker: `DRY_RUN=false` and `LIVE_CONFIRM=I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS`. API: `DRY_RUN=false`. Redeploy.
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
- [ ] `rat keys backup --out rat-keys-<date>.json` (every hour or so while hiring, and once at the end). Store it away from `KEY_ENCRYPTION_KEY`. The rat wallets' keys exist nowhere else.
- [ ] Coin dying: the bot hires with what is left, then idles. Leave it running, or `rat kill`.

## Numbers to remember

- Salary 0.03 SOL per rat. Every claimed lamport hires rats (no buy and burn).
- Cap: 60 SOL per hour for hires (about 2,000 rats an hour), at most 20 per 35 s loop; the rest waits and is spent later.
- 180 SOL of creator fees = about 6,000 rats (about 6 hours of hiring at the cap).
