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
- [ ] Settings from `SIMULATION.md`: `MAX_HIRES_PER_LOOP=10` and `BURN_ROUND_MAX_SOL=5` (steady hiring and burning, no 30 minute pauses).
- [ ] `rat alert-test` arrives on your phone. Phone charged, Telegram notifications on, not muted.
- [ ] `KEY_ENCRYPTION_KEY` backed up offline (without it the rat wallets are lost).
- [ ] Cold wallet address written down (for an emergency sweep). It must NOT be the creator, fund or a rat wallet.
- [ ] Admin page opens with your password.
- [ ] Go to sleep.

## T-1 hour: launch the coin (bot still in DRY RUN)

- [ ] Fund the creator wallet (0.05 SOL reserve + launch cost) and the fund wallet (0.01 SOL).
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
- [ ] Solscan: first claim (the fund's half goes out in the same tx).
- [ ] Site: first rats walk in.
- [ ] Within 8 to 12 minutes: first buy + burn.

## What normal looks like

- About 17 new rats a minute (with `MAX_HIRES_PER_LOOP=10`), about 1,000 an hour.
- "Waiting" budget grows during the rush. Normal: at most 30 SOL per hour is spent per bucket; the rest waits and is spent later. Nothing is lost.
- A burn round every 8 to 12 minutes, in chunks of at most 1 SOL a few seconds apart.
- Worker restarts and redeploys are safe at any moment (tested at every single step).

## Telegram: which alerts matter

| Alert | Meaning | Do |
|---|---|---|
| `cap_alert_*`, `cap_reached_*` | 50% / 100% of the hourly cap used. Spending waits for the window. | Nothing. |
| `inflow_*` | Someone sent SOL to a bot wallet. It is never spent. | Nothing. |
| `external_claim_*` | Someone else triggered our fee claim. Booked 50/50 as usual. | Nothing. |
| `no_eligible_stocks`, `hire_idle` | No hires (usually stale stock prices: markets closed). | Check the admin page. Wait, or approve more stocks. |
| `burn_no_route`, `burn_failed`, `claim_failed` | One attempt failed; the money waits for the next one. | Nothing, unless it repeats for 30+ minutes. |
| `task_failing_*` | A worker loop keeps failing. | Railway logs. Restarting the worker is safe. |
| `wallet_low_*` | A bot wallet is below its reserve. | Send a little SOL **to** it. |
| `effects_*` | A transaction was refused: it would have taken more than allowed. Nothing was sent. | **KILL.** Do not resume until you know why. |
| `overspend_*`, `rat_balance_*`, `hire_no_tokens_*` | Money did not match what was expected. | **KILL**, then check the admin page and `rat status`. |
| `unknown_signed_*`, `watch_overflow_*` | Possible leaked key or a flood hiding one. The bot killed itself. | `docs/runbooks/incident.md`. |

## Never do this while live

- Send a transaction **from** the creator or fund wallet (it trips the kill switch). Sending SOL **to** them is fine.
- Claim the creator fees on pump.fun yourself.
- Flip `DRY_RUN` back and forth.
- Sweep to one of the bot's own wallets (the CLI refuses anyway).

## End of the day

- [ ] `rat status` and the admin page: claimed vs spent, nothing stuck.
- [ ] Coin dying: the bot keeps burning what is left, then idles. Leave it running, or `rat kill`.

## Numbers to remember

- Salary 0.03 SOL per rat. Claimed fees split 50% hires / 50% buy + burn.
- Caps: 30 SOL per hour for hires, 30 SOL per hour for burns.
- 180 SOL of creator fees = about 3,000 rats.
