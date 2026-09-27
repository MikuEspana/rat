# Security review: every money path (red team)

Date: 2026-09-27. Scope: every code path that moves SOL or tokens: claim, hire, burn, sweep, ledger, spend guard, sender, wallet watch.
Method: for each path, list the ways it can lose money (bugs, crashes, outside attackers, a compromised API), write each one as a test, fix every real bug.
All tests run on the in-memory SimChain. Nothing touched mainnet, DRY RUN stayed on.

Severity: **High** = can lose money that was never claimed, or drain a wallet. **Medium** = can misbook, strand or double-send money, or hide an attack. **Low** = small amounts or noise.

## Findings (all fixed)

| ID | Severity | Path | What could go wrong | Fix | Test |
|---|---|---|---|---|---|
| RT-01 | High | hire, burn | Our creator and fund wallets sign whatever instructions the Jupiter API returns. A compromised API, API key, DNS or proxy could add one transfer and drain the **whole** wallet, not just one salary or one burn chunk. | **Effects check.** Every live claim, hire and burn tx is simulated before it is sent and refused if any of our wallets would lose more than its reservation, or the rat would get less than the quoted minimum of its stock. Critical alert. Fails closed: no limits or no simulation = not sent. | `redteam.test.ts` "compromised Jupiter API" (3), `safety.test.ts` "GuardedSender live checks" (9), `chain.test.ts` simulateEffects (2) |
| RT-02 | High | every send | A send that threw after the tx may already have been broadcast (for example the RPC failed while we waited for confirmation) was reported as "not sent". Hire and burn then gave the reservation back: the ledger re-credited money that was actually spent, so the bot could later spend SOL it never claimed. | A throw after the attempt is written now means `unknown`: the reservation is kept and the signature is re-checked until it lands or expires. Only a refusal before broadcast (`BlockedError`) counts as "not sent". | "hire: the RPC fails while waiting for confirmation", "a send that throws after broadcast is unknown" |
| RT-03 | High | burn | Worker killed while waiting for a burn confirmation (up to 2 minutes). The burn row had no signature yet, so the restart released the reservation as "never sent" even though the burn had landed. The next round then burned the fund's own SOL. | Before calling a burn "never sent", reconcile looks it up in the attempt log (written before every send). | "burn: worker killed after the tx landed" |
| RT-04 | Medium | claim | Same crash window for claims: the claim was marked failed and never booked, so the claimed SOL sat unbooked (never hired, never burned). | Same attempt log lookup. | "claim: worker killed mid-send" |
| RT-05 | Medium | claim | A new claim could go out while an earlier one could still land. Both would forward the fund share, moving hire money to the fund; the hire budget would then show SOL that is not in the wallet. | No new claim while an earlier bot claim is unresolved (at most about 1 to 2 minutes, until its blockhash expires). A claim that cannot be checked is closed with an alert, so it can never block claims forever. | "a claim that may still land blocks the next one" |
| RT-06 | Medium | two workers | The single-worker lease (120 s) was only renewed between ticks. A tick with many hires waiting for confirmations can run longer than that; a second worker (for example a redeploy that starts the new container before stopping the old one) then takes over and both spend the same budget. | **Lease fence**: right before every send the worker renews its lease; if another worker holds it, nothing is sent (`lease_lost`). | "a worker whose lease was taken over sends nothing more", "a worker that lost the lease sends nothing (fence)" |
| RT-07 | Medium | spend guard | `authorize()` read the budget and cap, then wrote the reservation, with nothing in between stopping a second call. Five parallel calls with budget for one: **all five passed** (shown by the test before the fix). Not reachable today (steps run one at a time), but one refactor away. | `authorize()` calls are serialized. Across processes, RT-06 covers it. | "five parallel authorizations with budget for one" |
| RT-08 | Medium | Jupiter build | The quote was not checked for spending exactly the requested amount, nor for honouring our slippage. A bad quote could spend more than reserved, or give a sandwich bot much more room than 1.5% on burns. | Rejected unless `inAmount` equals the request and the minimum output is at least `outAmount x (1 - slippage)` (1 raw unit of rounding allowed). Jupiter's own compute budget and tip instructions stay ignored. | `jupiter.test.ts` "red team: a quote that spends a different amount" |
| RT-09 | Medium | wallet watch | Only the newest 1,000 signatures were read per loop and the cursor then jumped to the newest. An attacker with a leaked key could drain, then send 1,000+ dust transfers (about 0.005 SOL of fees) to push the theft out of view: the kill switch never fired. External claims could be missed the same way. | The reader pages back to the cursor (up to 10,000 per loop; above that a critical alert). The watcher works oldest first, at most 250 lookups per loop, and only moves its cursor past signatures it fully handled. | "a key-leak tx hidden behind 1,100 dust transfers is still caught", "getSignaturesSince pages back" |
| RT-10 | Medium | wallet watch | A **failed** tx signed by our creator or fund key was filed as "failed, not ours" before the signer check. A failed drain attempt proves the key leaked, and went unnoticed. | Signer check first: kill switch + critical alert. | "a FAILED transaction signed by our creator key" |
| RT-11 | Low | wallet watch | Each unknown inflow alerted under its own key: a dust spam floods Telegram (rate limits) and buries real alerts. | One alert key per wallet (`inflow_creator`, `inflow_fund`), throttled to one per 10 minutes. Inflows are still never credited. | "dust spam: one alert key per wallet" |
| RT-12 | Low | two-step hire (fallback) | The funding tx sent the full salary and paid its fee on top: every hire cost salary + 5,000 to 15,000 lamports, so the hire bucket could go slightly negative (spent > claimed). Found by the new effects check. | Transfer = salary minus the worst-case funding fee. | "the funding tx fee comes out of the salary" |
| RT-13 | Low | ledger settle | A spend that cost more than its reservation was booked silently. | Critical `overspend_hire` / `overspend_burn` alert (the real cost is still booked). | "a spend that cost more than reserved" |
| RT-14 | Low | emergency sweep | The destination was not checked: sweeping to the creator, fund or a rat wallet (whose keys might be exactly what leaked) or to a program address (tokens stuck). Failed rats (two-step funded, never bought) were skipped, stranding their SOL. | Refuses the bot's own wallets and off-curve addresses; failed rats are swept too. | `cli.test.ts` "red team: refuses the bot's own wallets", "a failed rat still holding SOL" |

## Checked, already safe (existing tests)

- Kill switch blocks every tx except the owner's sweep.
- Paper and live ledgers are separate: paper credits can never fund a live spend.
- Every hire and burn needs a reservation, written before the tx is built.
- A hire is never retried while an earlier attempt can still land; before a retry the rat's wallet is read on-chain.
- External claims are credited only from our own vault addresses (derived from the creator key), so nobody can fake a credit without real SOL moving from our vaults.
- Unknown inflows are never credited to the ledger.
- Hire price is checked against the Price API (max deviation).
- Sending needs `DRY_RUN=false` AND the exact `LIVE_CONFIRM` phrase, checked twice; `RpcTxSender` is the only file that can send (CI guard).
- Rat keys are encrypted and stored before any SOL reaches the wallet (Q1).

## Risks we accept (not fixed)

| # | Risk | Why accepted / what limits it |
|---|---|---|
| A1 | A fully compromised Jupiter (quote and Price API both lying) can still give a bad price inside our limits. | Worst case per tx: one salary (0.03 SOL) or the value lost on one burn chunk. Hourly caps (30 SOL per bucket) stop a long bleed. Consider lower caps for the first hour. |
| A2 | The effects check reads balances, then simulates (about 1 slot apart). An unrelated inflow in between could hide a drain of the same size. | Needs an inflow and a malicious instruction in the same second. Negligible. |
| A3 | Token protection covers the rat's stock account only. Other tokens in the creator wallet (for example a dev buy of the coin) are not protected by the effects check. | Do the dev buy from a separate wallet, or move those tokens out before setting `WATCH_FROM_SLOT` (see `docs/runbooks/go-live.md`). |
| A4 | The lease uses each worker's own clock. Two machines with clocks more than 2 minutes apart could overlap. | One container; the fence limits any overlap to a single send. |
| A5 | Alerts are only as reliable as Telegram. | Alert failures never stop the bot; the kill switch and caps work without alerts. |
| A6 | The effects check costs 2 extra RPC calls per live send. | At most 20 hires per loop; well inside normal RPC limits. |

## Sources

- `simulateTransaction` with `accounts` returns the post-simulation state of the listed accounts; `minContextSlot` supported. **VERIFIED**: https://solana.com/docs/rpc/http/simulatetransaction
- `getSignaturesForAddress`: newest first, `limit` max 1,000, `before` / `until` for paging. **VERIFIED**: https://solana.com/docs/rpc/http/getsignaturesforaddress
- Token account layout: mint (32 bytes), owner (32), amount (u64) at byte 64. **VERIFIED**: `AccountLayout` in `@solana/spl-token` (`src/state/account.ts`), https://github.com/solana-program/token
- Jupiter `otherAmountThreshold` = minimum output after applying `slippageBps` to `outAmount`. **VERIFIED**: github.com/jup-ag/docs `swap/v1/get-quote.mdx` (example: out 16198753, 50 bps, threshold 16117760)
- Jupiter with an integrator `payer`: the temporary WSOL account rent is paid by and returned to the payer in the same tx. **REPORTED**: github.com/jup-ag/docs `ultra/gasless.mdx` (stated for Ultra, not for Swap v2 `/build`; the effects check enforces the salary limit either way, and the first smoke test will show the real cost)
- Hosts that start the new container before stopping the old one during a redeploy. **UNCLEAR**: depends on the host's deploy settings; the lease fence makes it safe either way.
