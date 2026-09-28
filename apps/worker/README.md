# @rat/worker

The bot. Owned by WS09. `pnpm --filter @rat/worker start` (DRY RUN unless `DRY_RUN=false` + `LIVE_CONFIRM`).

Loop (tick-based scheduler, loops never overlap, single worker via a lease lock):

| Task | Every | What |
|---|---|---|
| prices | 15s | one batched Jupiter Price v3 call: all stocks + SOL + coin |
| mints | 35s | one RPC call: mint facts, xStocks mint verification (rule #12), pause -> freeze / resume -> unfreeze |
| claim | 35s | claim both vaults + unwrap + fund share in ONE tx; then wallet watch; then hires |
| burn | 10 min | buy the coin with the burn bucket and burn it in the same tx (skip under 0.01 SOL) |
| reconcile | 35s | 500 rat token accounts: issuer freeze or balance mismatch -> rat frozen + alert |

Hire state machine: attempt recorded before sending; never retried while it can still land; before a retry the rat wallet is read on-chain; reservations are settled with the real cost or released. `HIRE_MODE=two_step` funds first, then the rat buys.

Wallet watch (owner decision #7): an external pump.fun claim of OUR vault is credited like our own (any fund share rides in the next claim tx); any other inflow is alerted and left unspent; a tx signed by our creator or fund that the bot did not send trips the kill switch.

DRY RUN: paper claims (growth of the real claimable since the last paper claim, plus `DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR` for rehearsals), paper hires and burns with real quotes; every tx is simulated, nothing is sent. Paper rows are separate from live rows (`rat dry-run-reset --yes`).

`sim-world.ts` builds the whole system on SimChain + mock Jupiter for tests and the e2e simulation.
