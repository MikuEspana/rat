# Go live

## T-1 day
- [ ] Integration PR merged into `main`, CI green.
- [ ] Smoke test done on a throwaway coin (`tests/smoke/README.md`), `tests/smoke/REPORT.md` reviewed. If the 1-tx hire failed there, set `HIRE_MODE=two_step`.
- [ ] `pnpm --filter @rat/jupiter check:stocks` looks right; mints verified on xstocks.fi; `approved: true` in `config/stocks.json` for the ones you want; `rat stocks-sync`.
- [ ] `pnpm --filter @rat/jupiter check:scaled-ui` run once (OPEN-QUESTIONS #3).
- [ ] `XSTOCKS_MINT_AUTHORITY` set to the confirmed xStocks mint authority (optional, recommended).
- [ ] Worker + API deployed in DRY RUN (`deploy.md`). Site points at the API and shows the dry run banner.
- [ ] Rehearsal: `DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR=20` for 30 minutes, watch the site, then set it back to `0` and run `rat dry-run-reset --yes`.
- [ ] `rat status` shows both keys imported. Master key backed up.
- [ ] `rat alert-test` arrives on Telegram. `rat kill` / `rat resume` tested.
- [ ] `rat preflight` says **READY** (every FAIL line fixed; WARN lines read and understood).

## T-1 hour: launch the coin, THEN tell the worker about it
Order matters: the coin launch is a creator-wallet transaction the bot did not send. The wallet watch must know about it before the worker's first live start, or it looks like a leaked key and trips the kill switch.
1. [ ] Fund the creator wallet with the 0.05 SOL reserve + launch cost, the fund wallet with 0.01 SOL (sending SOL **to** them is fine).
2. [ ] Launch the coin on pump.fun from the creator wallet: **normal mode, no holder rewards, no fee sharing**. Do any other manual step with the creator or fund wallet now too.
   - Dev buy: do it from a **separate** wallet, or move the bought coins out of the creator wallet right now. The bot's spend check protects the creator's SOL, not other tokens sitting in it (SECURITY-REVIEW.md A3).
3. [ ] Open the launch transaction on Solscan and wait until it shows **Finalized**. Note its **signature** and its **slot** (block).
4. [ ] On the worker set:
   - `COIN_MINT` = the coin mint
   - `WATCH_FROM_SLOT` = the launch slot + 1 (the watch never looks at anything older)
   - `KNOWN_OWNER_TX_SIGS` = the launch signature, plus any other transaction you signed with the creator or fund wallet after that slot (comma separated)
5. [ ] Redeploy, still DRY RUN. `rat status` + the site show paper claims reading the real vault.
6. [ ] `rat dry-run-reset --yes` to start the live history clean.

## Important while the bot is live
- **Never send a transaction from the creator or fund wallet yourself** (a buy, a transfer, a claim on pump.fun). The wallet watch sees a transaction signed by a bot wallet that the bot did not send, assumes a leaked key, and engages the kill switch. Sending SOL **to** these wallets is fine (it is alerted and never spent).
- If you really must: `rat kill`, send it, add its signature to `KNOWN_OWNER_TX_SIGS`, redeploy, check `rat status` (expect one critical alert about it), then `rat resume`.

## T-0: start live (only after the steps above)
- [ ] With the worker's live settings (`DRY_RUN=false`, `LIVE_CONFIRM`, `WATCH_FROM_SLOT`, ...), `rat preflight --live` says **READY**. Any FAIL: stop and fix it first.
- [ ] Set `DRY_RUN=false` and `LIVE_CONFIRM=I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS` on the worker, redeploy (the API only needs `DRY_RUN=false` to show live rows). This is the worker's first live start. Its preflight refuses to start live if 0 stocks are approved, if no approved stock passes the mint check, or if `WATCH_FROM_SLOT` is ahead of the chain (it would hide a real leak); the logs and a Telegram alert say exactly why.
- [ ] Watch on Solscan: the first claim (with the default split nothing goes to the fund wallet), the first rats (each a fresh wallet holding its stock). No burns unless `HIRE_SPLIT_BPS` was lowered.

## T+1 hour
- [ ] `rat status`: buckets, spent in the last hour vs caps, txs, heartbeats.
- [ ] Any doubt: `rat kill`.
