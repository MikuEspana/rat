# Launch-day incidents

One problem per section: what you see, what Telegram and the admin page show, the exact fix.
Run every command from `~/wallstreetrats` on the Mac. `scripts/rat.sh X` runs `rat X` inside the worker.
If `railway ssh` is down, use `scripts/rat-local.sh X` instead (same command, runs on the Mac).

**When in doubt: `scripts/rat.sh kill --reason "what I saw"`** (or the red KILL button on the admin page).
It only stops new transactions. Nothing is lost. Undo: `scripts/rat.sh resume` (admin page: type RESUME).

Telegram alerts look like `[RAT RACE !!! critical] text`. The same key is sent at most once every 10 minutes.

| # | Problem | Telegram key |
|---|---|---|
| 1 | launch.sh stopped halfway | none |
| 2 | Bot not live after launch | `startup_retrying`, `preflight_failed`, `staging_refused`, `worker_down` |
| 3 | Bot killed itself: a tx it did not send | `unknown_signed_*`, `watch_overflow_*` |
| 4 | The coin does not pay its fees to us | `coin_creator` |
| 5 | RPC down or slow | `claim_failed`, `task_failing_*` |
| 6 | Claims come in, no rats hired | `hire_idle`, `no_eligible_stocks`, `jupiter_429` |
| 7 | Money does not match | `effects_*`, `overspend_*`, `rat_balance_*`, `hire_no_tokens_*`, `claim_unverifiable_*`, `hire_gave_up_*` |
| 8 | Worker crashed or stuck | `worker_down`, `task_failing_*` |
| 9 | Railway itself is down or slow | none (Railway commands fail) |
| 10 | The site looks wrong | none |
| 11 | A bot wallet runs low | `wallet_low_*` |
| 12 | Save the rat keys (every hour) | none |
| 13 | Move everything to safety | none |
| 14 | Alerts you can ignore | `cap_alert_*`, `cap_reached_*`, `inflow_*`, `external_claim_*`, `stock_paused_*` |

---

## 1. launch.sh stopped halfway

- **You see:** `scripts/launch.sh` ended with a red STOPPED line (a Railway setting lost, a build failed, `railway ssh` did not answer).
- **Telegram / admin:** nothing yet. Admin still says DRY RUN, or LIVE with an old API.
- **Fix:** run it again. It finds the coin's settings already on the worker, asks you to confirm the mint and type GO, then only does what is missing. It never asks for the launch again.
  ```
  scripts/launch.sh
  ```
- If it says the worker already runs LIVE, answer `y` to redeploy only the API.
- **Done when:** it prints **LIVE**.

## 2. Bot not live after launch

- **You see:** the site ring says "clocking in" for more than 10 minutes, no rats.
- **Telegram:**
  - `startup_retrying`: the worker cannot read the chain or the database. It retries every minute by itself.
  - `preflight_failed`: the worker refused to start LIVE. Each reason is on its own line.
  - `staging_refused`: the worker found staging settings or a staging database. Each reason is on its own line.
  - `worker_down` (from the admin service): no worker loop for 3 minutes.
- **Admin:** "Worker loops" ages keep growing.
- **Fix:**
  ```
  scripts/rat.sh preflight --live      # every FAIL line says what to fix
  railway logs --service worker        # the last lines say why it stopped
  ```
  - `startup_retrying`: go to incident 5 (RPC) or check Postgres on the Railway dashboard.
  - `preflight_failed` / `staging_refused`: fix the line it names. Then `railway redeploy --service worker --from-source --yes`.
- **Done when:** the admin page shows LIVE and loops a few seconds old.

## 3. The bot killed itself: a transaction it did not send

- **Telegram:** `unknown_signed_<sig>` "A transaction signed by the creator wallet was NOT sent by the bot ... Kill switch engaged". Or `watch_overflow_*` (a flood of transactions that may hide one).
- **Admin:** kill switch ON. Site banner: PAUSED.
- **First:** open the signature on Solscan. **Was it you?** (a transfer you made from the creator wallet)
  - **Yes, it was me:** add the signature to the accepted list, then resume:
    ```
    railway variable list --service worker --json | jq -r .KNOWN_OWNER_TX_SIGS    # current list
    railway variable set "KNOWN_OWNER_TX_SIGS=<current list>,<sig>" --service worker --skip-deploys
    railway redeploy --service worker --from-source --yes
    scripts/rat.sh resume
    ```
  - **No, it was not me:** assume the creator key leaked. Keep the kill switch ON. Go to incident 13 (move everything to safety).
- **Never** resume before you know who signed it.

## 4. The coin does not pay its creator fees to us

- **Telegram:** `coin_creator` "The coin ... no longer pays its creator fees to the creator wallet: ... No new claims will come in." Repeats every 10 minutes.
- **Admin:** "Claimed" stops growing.
- **Why:** fee sharing, holder rewards or cashback got turned on for the coin. The fees then go somewhere else, and the bot cannot claim them.
- **Fix:** nothing to fix in the bot. It keeps hiring with what it already claimed.
  ```
  scripts/rat.sh preflight --live      # the "coin creator" line says what changed
  ```
  - Check the coin's page on pump.fun: turn fee sharing, holder rewards or cashback off if you can.
  - Otherwise decide: leave it running until the budget is spent, or `scripts/rat.sh kill --reason "coin creator changed"`.

## 5. RPC down or slow

- **Telegram:** `claim_failed` again and again, `task_failing_claim` (the claim loop also runs the wallet watch and the hires), or `startup_retrying`.
- **Admin:** "Last transactions" full of `failed` / `expired`. "Errors" shows RPC messages (429, timeout, fetch failed).
- **Nothing is lost:** a failed claim leaves the fees in the vault for the next try. A hire that did not land is retried, never paid twice.
- **Fix:** switch to your backup RPC. The URL has an API key, so it goes through a hidden prompt, never on the command line:
  ```
  printf 'New RPC URL (hidden): '; IFS= read -rs RPC; echo
  printf '%s' "$RPC" | railway variable set RPC_URL --stdin --service worker --skip-deploys; unset RPC
  railway redeploy --service worker --from-source --yes
  ```
- **Done when:** `scripts/rat.sh status` shows new confirmed transactions.

## 6. Claims come in, no rats are hired

- **Telegram:**
  - `hire_idle` "No rat hired for 30 min while X SOL waits ... Reason: ...".
  - `no_eligible_stocks`.
  - `jupiter_429`: Jupiter is refusing calls.
- **Admin:** "Waiting for hires" grows, "Spent on hires" stands still.
- **Usual cause:** stock prices are stale (markets closed, a weekend) or Jupiter has no route. Hires start again by themselves when prices are fresh.
- **Fix:**
  ```
  scripts/rat.sh status               # hire bucket, spent in the last hour, loop ages and last errors
  ```
  - The reason is in the `hire_idle` text. The admin page "Errors" table shows the Jupiter or price errors.
  - A stock is not approved or its mint is not verified: fix `config/stocks.json`, then `scripts/rat.sh stocks-sync`.
  - `jupiter_429`: something else uses the same Jupiter key. Stop it. The worker alone stays under 40 calls a minute.
- The money waits. Nothing is lost.

## 7. Money does not match

- **Telegram (critical):**
  - `effects_*`: a transaction was refused because it would have moved more than allowed. Nothing was sent.
  - `overspend_*`: a transaction cost more than it reserved.
  - `rat_balance_*`: a rat holds less stock than the database says. The rat is frozen.
  - `hire_no_tokens_*`: a hire landed but the rat got no tokens.
- **Telegram (warn, check on Solscan, no kill needed if it is one):**
  - `claim_unverifiable_*`: a claim has no attempt record. Marked failed; if it landed, its SOL is in the creator wallet but not booked (safe side).
  - `hire_gave_up_*`: a rat was not hired after every retry. Its reserved SOL goes back to the budget.
- **Fix:**
  ```
  scripts/rat.sh kill --reason "money mismatch"
  scripts/rat.sh audit                # every FAIL line names the claim, rat or transaction
  ```
  - Open the named signature or rat wallet on Solscan.
  - `rat_balance_*` alone (one rat, the issuer moved its tokens) does not need a kill. The rat is already frozen.
- **Resume only** when `scripts/rat.sh audit` says `AUDIT PASSED` and you know why it happened.

## 8. Worker crashed or stuck

- **Telegram:** `worker_down` (the admin service sends it, again every 30 minutes while down, once when back). `task_failing_<loop>` means one loop keeps failing.
- **Admin:** "Worker loops" ages above 3 minutes. The site ring says "back soon".
- **Fix:**
  ```
  railway logs --service worker
  railway redeploy --service worker --from-source --yes
  ```
  - A restart is safe at any moment: the new worker waits for the old one's lock (120 s at most), then books whatever was in flight exactly once.
- **Done when:** the loops on the admin page are a few seconds old and Telegram says the worker is back.

## 9. Railway itself is down or slow

- **You see:** `railway ...` commands fail or hang. `scripts/launch.sh` stops with `could not set` / `could not redeploy`.
- **Check:** https://status.railway.com (open it in the browser).
- **The running bot keeps running** while Railway's dashboard or API is down. Only changes and deploys wait.
- **Fix:**
  - Deploys paused on Railway's side: wait. Do not launch the coin until `railway status` answers and deploys work.
  - After the launch, if `scripts/launch.sh` stopped: run it again when Railway answers (incident 1).
  - Need to stop the bot while `railway ssh` is down: the admin page KILL button, or `scripts/rat-local.sh kill --reason "railway down"`.

## 10. The site looks wrong

| The site shows | Meaning | Do |
|---|---|---|
| "clocking in" on the ring (for minutes) | the worker is not running its loop yet | incident 2 |
| "back soon" | the worker ran and stopped | incident 8 |
| "Reconnecting to the trading floor..." | the API does not answer | `railway logs --service api`, then `railway redeploy --service api --from-source --yes` |
| "The rats are clocking in..." banner after the launch | the API still runs the old settings | `scripts/launch.sh` again (incident 1) |
| "The rats are on a break" banner | the kill switch is on | on purpose? If not: find out why, then `scripts/rat.sh resume` |
| "pre-launch" market cap after the launch | the API has no `COIN_MINT` | `scripts/launch.sh` again |

- Check the whole published site: `scripts/site-go-live.sh`.

## 11. A bot wallet runs low

- **Telegram:** `wallet_low_hire` "hire wallet ... holds X SOL, needs Y (amount + reserve)".
- **Why:** the creator wallet pays the fees and the rats' salaries out of claims. Its reserve (0.05 SOL) is never spent.
- **Fix:** send a little SOL **to** the creator wallet from your own wallet (0.05 to 0.1 SOL). Sending **to** it is always safe.
- **Never** send **from** the creator wallet: that trips the kill switch (incident 3).

## 12. Save the rat keys (every hour while hiring)

- **Why:** each rat's wallet key exists only in the database, encrypted. Without a backup, a lost database means lost rats.
- **Do:**
  ```
  scripts/keys-backup.sh
  ```
- **Done when:** it prints `OK saved N keys` and a new file is in `~/wallstreetrats-key-backups/`.
- Keep that folder away from `KEY_ENCRYPTION_KEY`. Not `rat keys backup --out <file>` inside Railway: that file is wiped by the next deploy.

## 13. Move everything to safety (last resort)

- **When:** a leaked key (incident 3, "not me"), or you want every rat's stock and SOL out.
- **Do:**
  ```
  scripts/rat.sh kill --reason "sweep"
  scripts/rat.sh sweep --to <your cold wallet>                                        # prints the plan
  scripts/rat.sh sweep --to <your cold wallet> --confirm "SWEEP ALL RATS TO <your cold wallet>"
  ```
  - Kill first: only then are rats still being hired swept too.
  - If the creator wallet was drained, each rat pays its own fee.
  - Tokens frozen by their issuer cannot move: their SOL still goes, and the sweep lists which rats to sweep again later. It exits with an error while anything is left.
- The cold wallet must not be the creator or a rat wallet (the CLI refuses).
- The creator wallet's own SOL and dev-buy coins: move them with your own wallet app, not the bot.

## 14. Alerts you can ignore

| Key | Meaning |
|---|---|
| `cap_alert_hire`, `cap_reached_hire` | 50% / 100% of the 60 SOL hourly hire cap used. The rest waits for the window and is spent later. |
| `inflow_*` | Someone sent SOL to a bot wallet. The bot never spends it. |
| `external_claim_*` | Someone else claimed our fees for us. Booked for hires as usual. |
| `owner_tx_*` | A transaction in `KNOWN_OWNER_TX_SIGS` was accepted. |
| `stock_paused_*` / `stock_resumed_*` | The issuer paused a stock. Its rats are frozen until it resumes. No hires into it. |
| `rat_frozen_*` | The issuer froze one rat's token account. That rat is frozen. |
| `mint_rejected_*` | A stock failed the mint check. The bot never hires into it. |
| `orphan_reservations_*` | A restart left reservations. Released; nothing was sent with them. |
| `claim_failed` (once) | One claim attempt failed. The fees wait for the next one. Only a repeat for 30+ minutes matters (incident 5). |

---

Sources (VERIFIED = read in this repo's code or tests; ASSUMED = not checked against the live service):
- Alert keys and texts: `apps/worker/src/steps/*.ts`, `apps/worker/src/main.ts:31-50`, `packages/safety/src/spend-guard.ts:87-188`, `packages/safety/src/guarded-sender.ts:97`, `apps/admin/src/main.ts:22`. VERIFIED.
- Telegram format and 10-minute throttle: `packages/safety/src/alerts.ts:4-32`. VERIFIED.
- Worker-down after 180 s, repeat every 30 min: `apps/admin/src/watchdog.ts:3-8`. VERIFIED.
- `railway variable set --stdin --skip-deploys`, `railway redeploy --from-source --yes`: used by `scripts/setup-mac.sh:179-183` and `scripts/lib/wsr.sh:55-129`, tested against a fake Railway only. ASSUMED for the live Railway CLI version on the Mac.
- `railway logs --service`: ASSUMED (Railway CLI docs, https://docs.railway.com/reference/cli-api).
- The running bot keeps running while Railway's dashboard or API is down: ASSUMED (https://status.railway.com history).
- Fees going elsewhere when fee sharing or holder rewards are on: pump-public-docs `CREATOR_FEE_SHARING.md`, `HOLDER_REWARDS_README.md` (`packages/pump/src/bonding-curve.ts`). VERIFIED in the docs, not on chain.
