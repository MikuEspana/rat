# Go live

## T-1 day
- [ ] Integration PR merged into `main`, CI green.
- [ ] Smoke test done on a throwaway coin (`tests/smoke/README.md`), `tests/smoke/REPORT.md` reviewed. If the 1-tx hire failed there, set `HIRE_MODE=two_step`.
- [ ] `pnpm --filter @rat/jupiter check:stocks` looks right; mints verified on xstocks.fi; `approved: true` in `config/stocks.json` for the ones you want; `rat stocks-sync`.
- [ ] `pnpm --filter @rat/jupiter check:scaled-ui` run once (OPEN-QUESTIONS #3).
- [ ] `XSTOCKS_MINT_AUTHORITY` set to the confirmed xStocks mint authority (optional, recommended).
- [ ] Worker + API deployed in DRY RUN (`deploy.md`). Site points at the API and shows the dry run banner.
- [ ] Rehearsal: `DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR=20` for 30 minutes, watch the site, then set it back to `0` and run `rat dry-run-reset --yes`.
- [ ] `rat keys pool` shows at least 2,000 keys.
- [ ] `rat status` shows both keys imported. Master key backed up.
- [ ] `rat alert-test` arrives on Telegram. `rat kill` / `rat resume` tested.

## T-1 hour
- [ ] Fund the creator wallet with the 0.05 SOL reserve + launch cost, the fund wallet with 0.01 SOL.
- [ ] Launch the coin on pump.fun from the creator wallet: **normal mode, no holder rewards, no fee sharing**.
- [ ] Set `COIN_MINT`, redeploy (still DRY RUN). `rat status` + the site show paper claims reading the real vault.
- [ ] `rat dry-run-reset --yes` to start the live history clean.

## Important while the bot is live
- **Never send a transaction from the creator or fund wallet yourself** (a buy, a transfer, a claim on pump.fun). The wallet watch sees a transaction signed by a bot wallet that the bot did not send, assumes a leaked key, and engages the kill switch. Sending SOL **to** these wallets is fine (it is alerted and never spent).
- Launch the coin and do any manual setup **before** switching `DRY_RUN=false` (the watch starts from the latest signature when it first runs live).

## T-0
- [ ] Set `DRY_RUN=false` and `LIVE_CONFIRM=I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS` on the worker, redeploy (the API only needs `DRY_RUN=false` to show live rows).
- [ ] Watch on Solscan: the first claim (fund share transferred in the same tx), the first rats (addresses end in RAT, each holds its stock), the first burn within 10 minutes.

## T+1 hour
- [ ] `rat status`: buckets, spent in the last hour vs caps, txs, key pool, heartbeats.
- [ ] Any doubt: `rat kill`.
