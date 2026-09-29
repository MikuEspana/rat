# Work log (autonomous run)

Started 2026-09-27. Each item: its own branch and PR, CI green (guards, typecheck, tests, Docker), then merged into the integration branch `claude/rat-race-planning-1qouxa`. `main` is never touched: the integration PR [#27](https://github.com/MikuEspana/rat/pull/27) stays open for Miguel to merge ("merge everything" was read as: merge every item PR into the integration branch).

Hard limits kept throughout: DRY RUN on, no mainnet transaction, no Jito call, test keypairs only, no secrets, no cloud accounts, no holder payouts, no safety check weakened, no em dashes.

## Summary

| # | Item | PR | Result |
|---|---|---|---|
| Q1 | Remove vanity keys | [#34](https://github.com/MikuEspana/rat/pull/34) | merged |
| Q2 | Red-team every money path | [#35](https://github.com/MikuEspana/rat/pull/35) | merged, 14 bugs fixed |
| Q3 | Property tests (fast-check) | [#36](https://github.com/MikuEspana/rat/pull/36) | merged, 1 bug fixed |
| Q4 | Chaos tests | [#37](https://github.com/MikuEspana/rat/pull/37) | merged, 3 bugs fixed |
| Q5 | 3-hour launch simulation | [#38](https://github.com/MikuEspana/rat/pull/38) | merged, 2 settings recommended |
| Q6 | `rat preflight` | [#39](https://github.com/MikuEspana/rat/pull/39) | merged |
| Q7 | LAUNCH-DAY.md | [#40](https://github.com/MikuEspana/rat/pull/40) | merged |
| Q8 | Private admin page | [#41](https://github.com/MikuEspana/rat/pull/41) | merged |
| Q9 | Site shell (Vite + React + Three.js) | none | **skipped by Miguel**: built in a separate session in `apps/pixel-site` (not touched here) |
| Q10 | Site deploy docs (Vercel) | none | **skipped by Miguel** (part of Tier 3) |
| Decision | All fees to rats, no burns, no dividends (after legal advice) | this PR | split bug fixed, default `HIRE_SPLIT_BPS=10000` |
| Q11 | Cleanup | [#42](https://github.com/MikuEspana/rat/pull/42) | merged |
| Q12 | Extra launch-risk reduction | [#43](https://github.com/MikuEspana/rat/pull/43) | merged, 4 items |
| Final | STATUS.md | [#44](https://github.com/MikuEspana/rat/pull/44) | merged, queue empty |
| Decision | Pacing defaults | [#46](https://github.com/MikuEspana/rat/pull/46) | merged |

## Q1. Remove vanity keys

**What changed**
- Every rat now gets a fresh normal keypair at hire time (`KeyStore.newRatKey()`). It is encrypted (AES-256-GCM, public key bound as AAD), inserted, then **read back and decrypted** before its address is returned. Only then is the swap built and the hire sent, so a crash right after sending can never lose the key of a funded wallet.
- Rat keys are never reused. A hire abandoned before any transaction (spend cap, no route, price check) retires the key (`status = unused`); `rat dry-run-reset` retires paper wallets the same way.
- Removed: the vanity grinder, the key pool and its refill, pool alerts (`keypool_low`, `keypool_runway`, grinder alerts), the key pool loop, the `keys grind` / `keys import-dir` / `keys pool` commands, `solana-keygen` (wrapper, test double, Docker stage, CI steps), the `VANITY_SUFFIX` / `KEYPOOL_*` / `SOLANA_KEYGEN_PATH` settings, and the `keypool_empty` hire block (it can no longer happen).
- Kept: AES-256-GCM vault, key rotation, creator/fund import, "no plaintext key in DB or logs" tests, the restart-safe hire state machine.
- Mock data and the live mock API use normal addresses; `CONTRACT.md` says the wallet has no suffix.
- Docs: `README.md`, `keys.md`, `go-live.md`, `deploy.md`, `incident.md`, CLI/worker READMEs, smoke README, `OPEN-QUESTIONS.md` #5 (resolved), `STATUS.md`, `ROADMAP.md` (note that it is the original plan).

**Tests added / changed**
- `apps/worker/src/worker.test.ts`: in both hire modes (single and two-step) the rat's key is in the database at the moment every hire tx is submitted; after a crash (tx landed, confirmation lost) a restarted worker with an empty key cache finishes the hire and can sign for the wallet.
- `packages/keys/src/keys.test.ts`: fresh key per hire, stored and decryptable before return, never reused after discard; a store that loses or corrupts the key makes `newRatKey()` fail (no wallet is ever used whose key did not round trip); no plaintext in DB rows or logs; rotation.
- `packages/db/src/store.test.ts`: a duplicate public key is refused, unused keys are kept but never handed out, `markUnused` never touches creator/fund keys, dry-run reset retires paper wallets.

**Bugs found**: none new. Removed dead paths (key pool empty, refill) that could have blocked hires at launch.

## Q2. Red-team review of every money path

Full write-up with severities: `SECURITY-REVIEW.md`.

**What changed**
- **Effects check** (High): every live claim, hire and burn tx is simulated before sending and refused if any of our wallets would lose more than its reservation, or the rat would get less than the quoted minimum. A compromised Jupiter API can no longer drain the creator or fund wallet. New `TxRequest.limits`, `TxSender.simulateEffects` (RPC: `simulateTransaction` with `accounts` + pre-read; SimChain: dry execute).
- **Send that throws = unknown** (High): an RPC failure while waiting for confirmation no longer releases the reservation of a tx that may have landed.
- **Crash windows** (High/Medium): burn and claim reconcile now find the signature in the attempt log if the worker died mid-send.
- **Claims one at a time** (Medium): no new claim while an earlier one could still land.
- **Lease fence** (Medium): the worker renews its lease right before every send; a worker that lost it sends nothing. `authorize()` is serialized.
- **Jupiter build validation** (Medium): exact input amount, minimum output must honour our slippage.
- **Wallet watch** (Medium/Low): signatures are paged (nothing skipped behind a dust flood), oldest first with a per-loop budget, signer check before the error check, one inflow alert key per wallet.
- **Small ones** (Low): two-step funding fee now inside the salary, overspend alert on settle, sweep refuses own wallets and program addresses and includes failed rats.
- Docs: `SECURITY-REVIEW.md`, `packages/safety/README.md`, `apps/cli/README.md`, go-live runbook (dev buy from a separate wallet).

**Tests added** (30): `apps/worker/src/redteam.test.ts` (12: compromised Jupiter x3, crash windows x3, claim race, watcher x3, lease takeover, two-step cost), `packages/safety/src/safety.test.ts` (12: effects check, fence, throw-after-broadcast, parallel authorize, overspend, limit checker), `packages/jupiter` (1), `packages/chain` (3), `apps/cli` (2). Four of them were run against the old logic first and failed, as expected (race: 5 of 5 authorizations passed with budget for 1).

**Bugs found**: 14, all fixed (3 High, 7 Medium, 4 Low). Accepted risks listed in `SECURITY-REVIEW.md`.

## Q3. Property-based tests (fast-check)

**What changed**
- `fast-check` added (dev dependency).
- `packages/safety/src/spend-guard.property.test.ts`: random sequences of claims, claim fees, spends (1 to 4 at once), settles, releases, time jumps of up to 90 minutes and kill switch flips, against the real SpendGuard and the real database ledger, compared step by step with a small independent model. 650 random scenarios per run, at SOL scale and at a tiny lamport scale (so the cap and budget boundaries are hit exactly).
- `tests/e2e/money.property.test.ts`: 12 random launches per run (fee bursts on the bonding curve and PumpSwap, strangers claiming our vault, 0 to 40% of transactions failing in random ways, both hire modes) run by the real worker, live on SimChain. After it settles, every lamport is checked against the chain.
- Fix (RT-15, Low): the burn budget no longer counts a fund share that is booked but not yet forwarded to the fund wallet (burn step and spend guard).

**Invariants proven on every run**
- SOL spent by hires and burns never exceeds SOL claimed, to the lamport. A spend is only granted when the claimed SOL left in its bucket covers it.
- The only cost that can come from the creator's reserve is the network fee of a claim that failed on-chain; while the hire bucket is below zero nothing is spent.
- Rolling-hour caps and the smoke cap are never exceeded (exact boundaries tested).
- Parallel spend requests are granted exactly as if they came one by one.
- The ledger balance always equals the exact sum of what was booked.
- End to end: every lamport that left our vaults is credited exactly once; the ledger's hire and burn spend equals what left the creator and fund wallets on-chain (plus reservations still in flight); claim fees match; creator and fund balances equal the ledger to the lamport; the owner's own SOL is never spent; the fund never burns SOL that has not arrived (checked after every loop).

**Mutation check**: the property was run against 5 deliberately broken guards (budget off by 1 lamport, cap removed, cap off by 1, smoke cap off by 1, no serialization). Every one was caught with a minimal counterexample.

**Tests added**: 5 (3 guard properties, 1 end-to-end property, 1 regression test for the counterexample it found).

**Bugs found**: 1 (RT-15, Low), fixed.

## Q4. Chaos tests

**What changed**
- Chaos harness (`tests/chaos/chaos.ts`): wraps every database repository, the RPC reader and sender, and Jupiter. It can kill the worker right before its k-th operation (every later call hangs forever, like a dead process), or make one kind of dependency fail from its k-th call on.
- `SimWorld.rebuildDeps()`: a fresh deps graph over the same database and chain (empty key cache, new guards), used as "the restarted process".
- Suites (in a separate `chaos` CI job, `pnpm test:long`; `pnpm run ci` runs everything):
  - **A. killed at every step**: 172 kill points across a hire (single mode, two-step mode, and with the tx dropped so the release path runs) and a burn (clean and dropped). After each kill a restarted worker must finish the job.
  - **B. RPC down** from each of the 29 RPC calls of those steps, then back.
  - **C. database drop** from each of the 138 database calls (mid-transaction), then back.
  - **D. Jupiter 429 storm**: 20 minutes of 429s in the middle of a launch.
  - Every scenario ends with the full money check against the chain (the Q3 invariants, now shared in `tests/e2e/helpers.ts`) plus: no rat left half hired, no rat wallet funded twice.
- Plus a 429 storm test on the real Jupiter HTTP client (20 callers): nobody sends before the reset time, at most 4 tries each, never over 55 requests per minute.
- Fixes:
  - **RT-16 (High)**: a reservation released just before a crash was reused for the next hire attempt, so that spend was never booked. Now a reservation is reused only if it is still open.
  - **RT-17 (Medium)**: a crash between reserving and recording the reservation left it stuck forever (0.03 SOL per hire, up to 1 SOL per burn). Orphans are now released at the start of each hire and burn step.
  - **RT-18 (Low)**: a crash or DB drop between booking the cost and marking the job done booked the difference twice. Settles and releases now close their reservation exactly once (unique `closes_id`, migration `0001` with a backfill).
  - `claims.openBot()` moved into the store (so the chaos wrapper sees it).

**Results**: all 172 kill points, 29 RPC points, 138 DB points and the storm pass with every lamport accounted for. Before the fixes, 9 kill points failed the money check.

**Tests added**: 12 chaos tests (each runs up to 43 scenarios), 1 HTTP storm test, 1 regression test (`resilience.test.ts` G, fails without the RT-16 fix).

**Bugs found**: 3 (RT-16 High, RT-17 Medium, RT-18 Low), all fixed.

## Q5. 3-hour launch simulation

**What changed**
- `tests/sim/launch-3h.test.ts`: a 3-hour launch run live on SimChain by the real worker, 5 second ticks: launch rush (90 SOL of creator fees in 30 min), cooling (35 SOL), a second pump (40 SOL at 90 to 120 min), dying (15 SOL). 180 SOL = the ~3,000 rat plan. Runs twice (default settings, paced settings) and checks every limit plus the full money check. `pnpm sim:3h` writes the numbers into `SIMULATION.md`; it also runs in the long CI job (`pnpm test:long`, about 4 minutes).
- New optional setting `BURN_ROUND_MAX_SOL` (default 0 = off, current behavior): at most this much per burn round.
- `sim:launch-hour` keeps the 3-hour section when it rewrites `SIMULATION.md`.

**Numbers** (full tables in `SIMULATION.md`)
- 3,042 rats, every lamport claimed and spent, ledger = chain exactly, in both runs.
- The 30 SOL/h caps set the pace: the rush pays 45 SOL into each budget in 30 minutes, the rest waits and is spent over the next hours (everything spent by minute 185).
- **Default settings hire in bursts: no new rat for 30 minutes** (minute 30 to 60, and again during the second pump), and **no burn for up to 39 minutes**.
- Paced (`MAX_HIRES_PER_LOOP=10`, `BURN_ROUND_MAX_SOL=5`): longest hiring pause 1 minute (about 17 rats a minute all the way), longest burn gap 12 minutes (the normal round spacing). Trade-off: the burn budget is fully spent about 27 minutes later.
- Jupiter: at most 54 calls per minute by default (limit 55), 29 paced.
- `/api/rats` at 3,042 rats: 1.66 MB (412 KB gzipped). The site must fetch it once and then follow `/api/events` (input for Q9).

**Tests added**: 1 long test (two 3-hour runs).

**Bugs found**: none in the money paths. One launch-day issue (bursty hiring and burning with the default settings) with a settings-only fix: Miguel decides (STATUS.md).

## Q6. `rat preflight`

**What changed**
- `rat preflight [--live]`: one PASS / WARN / FAIL line per launch check, then READY or NOT READY. Exit code 1 if anything FAILs. Read-only: it never sends a transaction (Jupiter and Telegram checks are reads: a SOL price call, `getMe` + `getChat`).
- Checks: mode (DRY RUN / LIVE), smoke mode, required settings, backup RPC, database, RPC (slot + latency, primary and backup separately so a dead primary shows), Jupiter key, creator and fund keys (imported, decrypt with `KEY_ENCRYPTION_KEY`, match the configured public keys), creator and fund wallets above their reserves, coin mint exists, approved stocks and the xStocks mint check, `WATCH_FROM_SLOT` (set, not ahead of the chain), kill switch (env and database), caps, Telegram, worker loops.
- `--live`: anything that would stop a live launch is a FAIL (DRY RUN still on, no watch floor, kill switch on, no Telegram, no approved stock). In DRY RUN those are warnings.
- Docs: CLI README, go-live runbook (`rat preflight` at T-1 day, `rat preflight --live` right before going live).

**Tests added**: 6 (`apps/cli/src/preflight.test.ts`): all good, `--live` blockers, missing settings / dead RPC / keys that do not decrypt, rejected Jupiter key, wallets under reserve / failing mint check / unapproved stocks / watch floor in the future, Telegram token and chat checks.

**Bugs found**: none.

## Q7. LAUNCH-DAY.md

**What changed**
- `LAUNCH-DAY.md`: the short checklist for a tired, nervous launch day. The 3 emergency moves first (kill, leaked key, sweep), then the night before, T-1 hour (launch the coin in DRY RUN), T-0 (go live with `rat preflight --live`), what normal looks like, which Telegram alerts matter (and which to ignore), what never to do while live, end of day, numbers to remember. `docs/runbooks/go-live.md` keeps the details.
- README links `LAUNCH-DAY.md` and `SECURITY-REVIEW.md`.

**Tests added**: the docs test now also checks `LAUNCH-DAY.md`: every `rat <command>` it names exists in the CLI and every setting exists in `.env.example`.

**Bugs found**: none.

## Q8. Private admin page

**What changed**
- New service `apps/admin` (Hono, server-rendered, no JavaScript, refreshes every 15 s). Shows mode, kill switch, ledger buckets (available, spent in the last hour, cap used, open reservations), claimed / burned totals, fund share owed, rats by status, the last 25 transactions with Solscan links, errors (failed transactions, worker loop errors) and worker loops.
- KILL and Resume buttons run the CLI's own `killCommand` / `resumeCommand` (exported from `@rat/cli`). Resume needs `RESUME` typed; an env `KILL_SWITCH=true` cannot be resumed from the page.
- Security: `ADMIN_PASSWORD` (at least 16 characters, else it refuses to start), HTTP Basic auth compared in constant time, lockout after 10 wrong passwords per IP for 15 minutes, CSRF token + same-origin check on every POST, `no-store`, no framing, strict CSP, everything HTML-escaped. It never sends a transaction or reads a private key.
- Config only: `infra/railway.admin.json`, Dockerfile copies the new package, `ADMIN_PASSWORD` / `ADMIN_PORT` in `.env.example`, deploy runbook step, README.
- `attempts.latest(n)` in the store.

**Tests added**: 8 (`apps/admin/src/admin.test.ts`): short password refused, auth + health + headers, lockout, dashboard numbers after a claim and hires, kill / resume through the page, env kill cannot be resumed, CSRF and cross-site POSTs refused, HTML escaping (an error message with a script tag, a notice with an image tag). Docs test covers the new Railway file and Dockerfile line.

**Bugs found**: none.

## Q9 and Q10. Skipped

Miguel's instruction during the run: skip Tier 3 (the website shell and its deploy docs). The site is built in a separate session in `apps/pixel-site`; this run never touches that folder. Input for that session from Q5: `/api/rats` is about 1.7 MB (410 KB gzipped) at 3,000 rats, so fetch it once and then follow events (now noted in `CONTRACT.md`).

## Q11. Cleanup

**What changed** (found with an unused-code scan, `knip`, plus a grep for leftovers)
- Removed: a duplicate `@rat/jupiter` dev dependency in the CLI, 3 unused dependencies of the tests package (`@rat/chain`, `@rat/keys`, `@solana/spl-token`), the unused `WSOL_MINT` alias, exports nothing imports (`SMOKE_MAX_CAP`, `sol`/`SOL` re-export in the e2e helpers, `MIN_PASSWORD_LENGTH`).
- Removed 3 config tests that were exact copies of the tests above them.
- Stale numbers: the reconcile comment (3,000 rats) and the `/api/rats` size in `CONTRACT.md` (measured, 3,000 rats).
- Kept on purpose: the 6,000 rat scale tests (2x headroom over the 3,000 plan), exported types (public package API), `ROADMAP.md` (marked as the original plan).

**Tests**: 243 (3 duplicates removed), all green; guards pass.

**Bugs found**: none.

## Q12. Anything else that reduces launch risk

Added to the queue, then done:

| # | Risk found | What was added | Tests |
|---|---|---|---|
| 12a | Every alert comes from the worker, so a dead worker (crash loop, Railway restarts used up, out of memory) is **silent**: claims, hires and burns stop and nobody is told. | Worker-down watchdog in the admin service: no worker loop for 3 minutes = critical Telegram alert (again every 30 minutes, and once when it is back) plus a red WORKER DOWN banner on the admin page. | `admin.test.ts` watchdog test |
| 12b | The rat wallets' keys exist **only** in the database (encrypted). Losing the database loses every rat's tokens. | `rat keys backup --out <file>` (every key checked to decrypt first, still encrypted, file 0600, never overwritten by accident) and `rat keys restore --in <file>` (every key must decrypt, existing keys kept). `LAUNCH-DAY.md`: back up every hour or so while hiring. | backup, lose the database, restore, the restored keys sign; wrong master key refused both ways; no plaintext in the file |
| 12c | A wrong or half-rotated `KEY_ENCRYPTION_KEY` would only show up when a rat wallet must be moved (an emergency sweep). | `rat preflight`: every stored rat key decrypts with the current master key, and every rat has a stored key. | preflight rat keys test |
| 12d | Error texts can carry secrets (an RPC URL with `?api-key=`, a Telegram bot URL, a database password). They were stored in the database, shown on the admin page and sent to Telegram as they were. | `redactSecrets()` on every alert text, every loop error (heartbeats) and every stored send error. The probe showed today's RPC errors do not include the URL, so this is defense in depth. | `redact.test.ts`, alerts + attempt log test |

**Bugs found**: none in the money paths; 4 operational gaps closed.

## Queue empty

`STATUS.md` now opens with the queue table (Item | PR | Result | Anything Miguel must do) and the top 5 risks left. The integration PR into `main` ([#27](https://github.com/MikuEspana/rat/pull/27)) stays open for Miguel.

## Miguel's decision: pacing on by default

After reading `SIMULATION.md`, Miguel chose to make the pacing settings the defaults.

**What changed**
- `MAX_HIRES_PER_LOOP` default 20 -> 10 (about 17 rats a minute, steady under the 30 SOL/h cap) and `BURN_ROUND_MAX_SOL` default 0 -> 5 (burns spread over the hour). `.env.example`, config tests.
- Tests that relied on the old defaults: the paper hire test now expects the configured per-loop limit; the 100 SOL cap test turns burn pacing off explicitly (it tests the cap itself).
- `SIMULATION.md` regenerated: the 3-hour run now compares "unpaced" (the old values, set explicitly) with the new defaults; the launch-hour sections use the new defaults.
- `LAUNCH-DAY.md`, `STATUS.md`, `SECURITY-REVIEW.md` updated.

**Tests**: main suite 249 passed, chaos suite 16 passed, 3-hour simulation passed (same numbers: 3,042 rats, longest hiring pause 1 min, longest burn gap 12 min, ledger = chain).

## Miguel's decision: every fee hires rats (2026-09-28)

After legal advice: hold, never burn, never pay dividends; keep buy and burn as an option for later.

- **Bug found and fixed.** `HIRE_SPLIT_BPS` was applied as the FUND's share in the claim step (4 places), while its name, `.env.example`, the docs and the simulator all mean the hires' share. At 50/50 both readings give the same numbers, so no test could see it. Setting it to 100% "for hires" would have sent every fee to burns. Now `fundShareOf()` in `@rat/core` (the complement of the split, rounding as before) is used everywhere, with unit tests.
- **Default `HIRE_SPLIT_BPS=10000`.** Every claimed lamport hires rats; nothing is forwarded to the fund wallet; the burn step finds an empty budget and skips quietly. Buy and burn comes back by lowering the split (for example 5000) and redeploying.
- **Tests.** Test worlds (`createSimWorld`) keep a 50/50 split so every burn test (chaos, red team, property, launch hour) keeps covering that path. New `tests/e2e/launch-hour.test.ts` D runs the production default live on SimChain: all 12 SOL claimed go to hires, 405 rats, the fund wallet untouched, 0 burns, coin supply unchanged, every claim event shows 0 to the fund.
- **Site and simulator.** The HUD shows **Fund value** (what all the rats' stocks are worth, top positions under it) instead of Total burned; claim lines read "all of it hires rats"; the simulator runs the new split (Normal about 4,900 rats and a $23K fund; Mega ends at 5 hours with about 4,900 rats and 45 SOL still waiting under the hourly cap).
- **Limit found.** The site's building is drawn for about 5,200 rats (`PLAN_RATS`). With every fee hiring, a big launch passes that after about 5 hours at the cap; rats beyond it stand in HQ. Follow-up: a bigger final ring or a stage after the evil empire.

## Miguel's decision: buy and burn removed, every fee hires rats (2026-09-28)

After legal advice: hold, never burn, never pay dividends. Buy and burn is gone completely (not just off).

**What changed**
- **Backend.** Removed:
  - the burn step and its tests;
  - the fund wallet (config, key import, preflight, wallet watch);
  - the direct pump.fun buy (and `@pump-fun/pump-sdk`);
  - the Jito route;
  - the `burn` ledger bucket and the claims' fund columns (migration `0002` drops the `burns` table and 2 columns).
- **Only transactions left:** claim and hire (plus the owner's manual sweep). Every claimed lamport is credited to the hire bucket.
- **New defaults:** `MAX_HIRES_PER_LOOP=20` (was 10), `SPEND_CAP_SOL_PER_HOUR_HIRE=60` (was 30). That is about 34 rats a minute, just over the cap's 33.
- **Contract v2 (`schemaVersion` 2):**
  - no `burn` event;
  - claim data is `{ amountSol, source }`;
  - no `bot.nextBurnAt`, `coin.burnedTokens` or `wallets.fund`;
  - treasury is `{ totalClaimedSol, totalHiredSol, waitingSol }`;
  - new `portfolio.positionCount`.
  - Mock files, the live mock API, the state API and the admin page follow it.
- **Site:**
  - "Fund value" is now **"Portfolio value"** everywhere (HUD, simulator, docs), so nobody reads it as holders' money.
  - The furnace cash-bag effect is gone.
  - New **job-fair line**: rats with no desk queue on the street from the lobby door, around the block, under a "JOB FAIR: N IN LINE" sign. When a desk is built for them they walk in and the rest of the line moves up. Feed lines when the line forms and when it clears.
  - `?rats=` now goes up to 7,000 to show it.
- **Simulator:**
  - no split or burns; 20 per loop, 60 SOL/h.
  - Normal: 4,845 rats, all seated.
  - Mega: 6,373 rats, about 530 in the line.
  - Rug: 816.
  - A 3x Mega test checks that the 60 SOL/h cap binds.
- **CI guard:** token burn code (`createBurn*Instruction`, `buildBurnInstruction`, `burnIx`) is refused in production source.

**Tests**
- Burn-only tests deleted:
  - burn config;
  - burn totals;
  - the Jito route (5, replaced by 2 plain RPC send tests);
  - burn step;
  - burn drain;
  - chaos burn rows;
  - kill-burn.
- Converted: the red-team burn kill-mid-send is now a hire version, and the property regression is now a fixed hire scenario.
- `checkMoney` now also asserts that the whole claim goes to hires and that nothing is booked outside the hire bucket.
- Launch hour B scans every hire ledger row for the rolling-hour maximum: exactly 60 SOL, 20 per loop, 44 Jupiter calls a minute at most.
- No safety check was weakened. Some timeouts were raised, because hires doubled.

**3-hour simulation** (`SIMULATION.md`)
- 180 SOL of fees became 6,084 rats.
- The hire budget was fully spent by minute 180 (359 with the old limits).
- The busiest hour spent exactly 60 SOL, and hiring never paused for more than 1 minute.
- At most 44 Jupiter calls in any minute; the limiter allows 55 and the Free tier 60.
- The ledger equals the chain to the lamport.

**Jupiter tier**: the numbers above said Developer for headroom; Miguel chose to stay on the Free tier with a hard call budget instead (next entry).

## Miguel's decision: stay on Jupiter's Free tier, hard budget of 40 calls a minute (2026-09-28)

**What changed**
- **One Jupiter budget for the whole worker** (`packages/jupiter/src/budget.ts`):
  - every call takes a token: prices, builds and retries;
  - at most `JUPITER_MAX_RPM` = 40 in any 60 s, the same sliding window Jupiter counts with (a refill-rate bucket could burst past 40 in a rolling minute);
  - the config refuses anything above 40;
  - the Free tier allows 60, so 20 stay free for the CLI and scripts on the same key.
- **Production**:
  - `BudgetedSwapBuilder` and `BudgetedPriceSource` wrap the real clients;
  - the HTTP client runs with no limiter and no retries, so every request is exactly one token;
  - the budget starts spent, so a restarting or crash-looping worker cannot burst. The smoke script starts full.
- **SimChain**: the same wrappers sit around the mocks, on the fake clock.
- **Prices** every 45 s (was 15). All mints go in ONE batched call; more than 50 is refused. With no token, the round is skipped and the last prices stay.
- **Hires**:
  - a hire starts only while the budget has room, always leaving one token for prices;
  - otherwise the rest wait for the next loop: no key, no reservation, no call;
  - a 429 on a build stops the loop at once (no retry on the other stocks), releases the reservation and retires the unused key.
- **429**:
  - every caller stops for 5 s, then 10, 20, 40 ... up to 5 minutes, or Jupiter's `x-ratelimit-reset` if later;
  - a `jupiter_429` alert goes out (Telegram, throttled);
  - the first success resets the backoff;
  - `hire_idle` now names the Jupiter budget as the reason when it is.
- **Site**:
  - the HUD's portfolio value and PnL glide to each new value over 2 s (prices refresh every 45 s);
  - the browser simulator runs the same budget (at most 40 calls in any minute, checked in its tests).

**Tests**
- Budget unit tests:
  - never more than 40 in any rolling minute over 5 minutes of calls every 100 ms (exactly 200 calls);
  - an empty budget makes no call;
  - `startEmpty`;
  - the backoff sequence 5, 10, 20, 40, 80, 160, 300, 300 s;
  - a later reset header wins;
  - a success resets the backoff;
  - one token per batched price call, and more than 50 mints refused;
  - the worker's HTTP client reports a 429 once, with the reset time.
- Config: `JUPITER_MAX_RPM` above 40 is refused; the defaults are 40 and 45 s.
- Worker:
  - with a 5-call budget, hires stop at 3 and continue a minute later, with no key or reservation for the waiting ones;
  - a 429 costs exactly one call, alerts, skips the price round and resumes after the backoff.
- Chaos: in a 20 minute 429 storm the worker now makes at most 12 calls (it was allowed up to 600), alerts, and still recovers with the ledger exact.

**3-hour simulation at the new cap** (180 SOL of fees, `SIMULATION.md`)
- **Most Jupiter calls in any minute: 40** (never more; the Free tier allows 60).
- **Longest hiring delay: 64 minutes.** SOL claimed at minute 23 in the rush waited 64 minutes for its rat. Hiring itself never paused while SOL waited.
- **Rats waiting at peak: about 2,050** (61.6 SOL claimed, not hired yet, at minute 26).
- **Every fee spent: yes, by minute 189** (0.01 SOL left). Without the budget it was minute 180.
- 6,084 rats; ledger = chain to the lamport.
- **The budget binds a little before the 60 SOL/h cap.** Two 20-hire loops can fall in one minute, so the busiest hour spent 57.4 SOL.


## Miguel's decision: the site shows every hire at once, money always moving (2026-09-28)

The backend is unchanged (40 Jupiter calls a minute, one call per hire). Only the site changed.

**What changed**
- **Every claim shows its rats at once.**
  - One applicant per 0.03 SOL claimed lines up outside the lobby (the job-fair line), drawn as interns.
  - Each hire turns the rat at the front of the line into the new hire, who walks in to a desk.
  - With no backlog (early on), a hire comes up the subway stairs and walks straight to its desk, as before.
  - When every desk is taken (about 5,800 rats), a hired rat stays in line until a desk is built.
  - The line follows `treasury.waitingSol`; it is only corrected when it drifts by more than 25 + 5% for 10 s, so hire loops in flight do not make it jump.
- **The Vault**: a gold safe drawn in code replaces the furnace. Bills fly into it from the subway on every claim and from each new rat on every hire; it flares when they land.
- **"+$X" popups** rise above the Vault: gold for a claim, green for stock bought. One every 0.7 s; what comes in between adds up.
- **HUD**: a fifth stat, "Job fair", shows the line length ("2,041 rats in line") in green when there is a line.
- **Simulator**: a Rush scenario runs the backend's 3-hour launch (90 SOL of fees in 30 minutes, 180 SOL in all). The line peaks at about 2,045 and drains.

**Tests**
- The simulator's engine tests run Rush too: every rule holds, about 180 SOL of fees, more than 1,000 rats waiting at the peak, less than one salary left at the end.
- Headless browser (Playwright): no console errors; Rush shows the line and the HUD stat (1,662 in line at minute 12); Normal has no line and hires walk straight in; bills and popups on screen; the HUD fits on mobile.

## Miguel's decision: Railway Postgres, nightly encrypted offsite backups (2026-09-29)

**Checked:** the code is plain Postgres. node-postgres through `DATABASE_URL`, plain SQL migrations, a session advisory lock. No Supabase auth, storage, RLS, extensions or pooler. The only Supabase traces were docs, one comment and the read-only role file's name.

**What changed (config, scripts and docs; no app code)**
- **Wiring:** worker and admin get `DATABASE_URL=${{Postgres.DATABASE_URL}}`; the API gets `DATABASE_URL_READONLY` built from references and one shared variable (`RAT_API_DB_PASSWORD`). The database password is never copied. The CLI runs inside Railway (`railway ssh --service worker`).
- `infra/supabase-readonly-role.sql` is now `infra/readonly-role.sql` (run in `railway connect Postgres`, password set with `\password`).
- **Nightly backup** (`infra/backup/`, `infra/railway.backup.json`): a Railway cron service. `pg_dump` over the private network, archive checked, encrypted with `age` to the owner's public key, one signed S3 upload (SHA-256 checked by the store, MD5 ETag checked by the job) to a bucket outside Railway. Every step has a time limit; any failure sends one Telegram `backup_failed` alert naming the step, with no secret in it. It never deletes (bucket lifecycle rule). Optional heartbeat URL for a night that never starts.
- **Restore drill:** `infra/backup/restore-check.sh` restores one backup into an empty scratch database (refuses any database with tables), checks every table and the migrations, prints PASS and the restore time. On the launch-day checklist.
- **CI:** a `backup` job runs `infra/backup/selftest.sh` on Postgres 16 (simulated launch, backup under busybox like the Alpine image, a local S3 server that checks signatures, restore, every table compared, the three failure alerts). The `docker` job builds the backup image.

**Test restore (local, nothing real):** 101 rats, 274 ledger entries, 103 encrypted keys, 35 claims dumped, encrypted, uploaded, downloaded and restored: every table has the same rows, the ledger is identical (md5), 3 of 3 migrations. A wrong S3 secret, a database that is down and a private key pasted as the recipient each sent exactly one alert.

## Miguel's decision: Option A, one-command Mac setup, dev buy at launch (2026-09-29)

**Wallets:** creator `4VYWcTTDYyMVic58AcUC7Nodt6vNQwjKhA9UphaAKiot` (made in Phantom, funded right before launch), cold wallet `DX7RpxyhbcGeiBQh76ed2wZHw8WZ2CdMoDibpWmX9ajj`. The launch includes a 0.1 SOL dev buy from the creator wallet; those coins stay there forever. Miguel trades from a separate wallet.

**What changed**
- `scripts/setup-mac.sh`: the whole backend setup in one command (tools, Railway and Cloudflare logins, Railway project with Postgres and 4 services wired by references, private R2 bucket with a 30-day rule, generated secrets in `~/rat-secrets`, hidden prompts for every secret, Telegram chat auto-detected, creator key imported inside Railway, DRY RUN preflight, test alert, first backup, nightly schedule, optional healthchecks.io check, restore drill on the real backup). Safe to re-run. Secrets only go through stdin, never a command line, never printed. Runbook: `docs/runbooks/setup-mac.md`.
- `scripts/rat.sh`: runs a `rat` command inside the Railway worker.
- **Dev buy never counted as fees:** claims are only credited from pump.fun claim instructions. New worker test: a launch tx that moves SOL (even into the fee vault) is ignored by the watch and the claim books only the claimed fees.
- **Dev buy coins protected (SECURITY-REVIEW A3 closed):** the effects check now always protects the creator's coin account (both token programs, may not go down). A red-team test (a compromised Jupiter appending a transfer of the dev-buy coins) failed before the fix and passes after.
- **Preflight:** `launch txs` (every creator-signed tx from `WATCH_FROM_SLOT` on was sent by the bot or is in `KNOWN_OWNER_TX_SIGS`; a listed signature that does not exist is a typo), `dev buy` (coins held by the creator wallet), `cold wallet` (set, not the creator, on-curve, not a bot key). `--json` output for the setup script.
- `COLD_WALLET` setting: preflight checks it and `rat sweep` uses it when `--to` is left out.
- Docs: `LAUNCH-DAY.md` and `go-live.md` (fund about 0.3 SOL, dev buy inside the launch, list every creator-signed launch signature), `deploy.md`, `keys.md`.

**Tested without Miguel's accounts:** a harness with fake `railway`, `wrangler` and `brew`, fake Telegram / RPC / Jupiter / healthchecks servers, a local S3 server and a real Postgres 16. It runs the real `rat keys import`, migrations, `backup.sh` and restore drill. First run (with wrong answers first to exercise every retry) and second run (no input at all) both finish; the second one skips every step. No secret appears in either transcript or on any command line. The read-only API user can read and cannot write. A contract test ties the script's two allowed pre-launch FAILs to the real preflight wording.
