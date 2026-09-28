# @rat/worker

The bot. Owned by WS09. `pnpm --filter @rat/worker start` (DRY RUN unless `DRY_RUN=false` + `LIVE_CONFIRM`).

Loop (tick-based scheduler, loops never overlap, single worker via a lease lock):

| Task | Every | What |
|---|---|---|
| prices | 15s | one batched Jupiter Price v3 call: all stocks + SOL + coin |
| mints | 35s | one RPC call: mint facts, xStocks mint verification (rule #12), pause -> freeze / resume -> unfreeze |
| claim | 35s | claim both vaults + unwrap in ONE tx (every lamport to the hire budget); then wallet watch; then hires (at most 20 per loop, 60 SOL per hour) |
| reconcile | 35s | 500 rat token accounts: issuer freeze or balance mismatch -> rat frozen + alert |

Hire state machine: attempt recorded before sending; never retried while it can still land; before a retry the rat wallet is read on-chain; reservations are settled with the real cost or released. `HIRE_MODE=two_step` funds first, then the rat buys.

Wallet watch (owner decision #7): an external pump.fun claim of OUR vault is credited to hires like our own; any other inflow is alerted and left unspent; a tx signed by our creator that the bot did not send trips the kill switch.

DRY RUN: paper claims (growth of the real claimable since the last paper claim, plus `DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR` for rehearsals), paper hires with real quotes; every tx is simulated, nothing is sent. Paper rows are separate from live rows (`rat dry-run-reset --yes`).

`sim-world.ts` builds the whole system on SimChain + mock Jupiter for tests and the e2e simulation.
