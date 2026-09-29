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

## Fix: Railway built the worker with Railpack (2026-09-29)

**What happened on the real run:** step 6 stopped. Railway ignored the config file path set in step 3 and auto-detected the build with Railpack ("No start command detected"), so the worker failed.

**What changed in `scripts/setup-mac.sh`**
- Step 3 sets the build settings on each service itself before its first build: builder Dockerfile, the Dockerfile path, the start command and the restart / health rules, all read from `infra/railway.<service>.json`. The config file path stays, and the documented Dockerfile variable is set too. Railway's answer is read back; nothing is built until it holds the builder, Dockerfile and start command. The read-back holds every variable decrypted, so only the build settings leave that pipe.
- The check compares with what Railway has, not with a "done" flag, so a re-run repairs a service that was built the wrong way: a connected service whose settings changed or whose last deploy failed gets a fresh build of the latest commit (`redeploy --from-source`, or connecting the repo again on an older CLI), never a replay of the failed build.
- Every `environment edit` now sends its patch as JSON on stdin (the Railway CLI reads piped stdin in place of flags).
- Step 5 says DONE when the passwords are already on Railway (they were never overwritten; now the message says so).

**Tested:** the harness's fake Railway now builds like the real one did (config file path ignored, Railpack without a builder setting, a plain redeploy replays the last build). Fresh setup: no build ever fails. Repair: the script from `main` stops exactly like the real run; the new script fixes the settings, rebuilds the worker and finishes without asking any finished step again; a third run changes nothing. The same repair with an older CLI (no `--from-source`, no settings read-back) also finishes. No secret in any transcript or on any command line (railway, wrangler, brew, jq, curl).

## Fix: a fresh worker waits for the creator key (2026-09-29)

`setup-mac.sh` starts the worker (step 6) before the creator key is imported inside it (step 7). The worker stopped at startup when no creator key existed, so on a real project it would crash-loop and step 7 could not reach it. Now the long-running worker waits, doing nothing, until the key is imported, then starts. A wrong or undecryptable key still stops it. Proved on the real worker process against Postgres 16: `main` exited with "no creator key imported"; the fix waited, `rat keys import` worked, and the worker started.

## Fix: rat commands over railway ssh get the worker's settings (2026-09-29)

**What happened on the real run:** step 6 stopped right before the creator key import: "railway ssh into the worker works, but its settings are not visible there". A `railway ssh` session does not get the service's variables, so `rat` inside it had no DATABASE_URL or KEY_ENCRYPTION_KEY.

**What changed:** `scripts/in-worker.cjs` runs every `rat` command sent over ssh (by `setup-mac.sh` and `scripts/rat.sh`). It takes the settings from the running worker process (`/proc/<pid>/environ`), or else from the service variables sent as the first line of stdin (`railway variable list --json`, rendered values). The rest of stdin goes to the command, so the creator key still comes only from the hidden prompt through stdin. No value is printed or put on a command line.

**Tested:** the harness's fake Railway now runs ssh commands without the service variables, like the real one. The script from `main` stops exactly like the real run; the new script finishes, imports the key through the hidden prompt (a wrong key refused first), asks nothing again before step 7 and rebuilds nothing. Also: a fresh setup, the older-CLI repair, a setup with no readable worker process (settings over stdin), and `scripts/rat.sh status`. No secret in any transcript or on any command line (railway, wrangler, brew, jq, curl).

## Region: everything in EU West (Amsterdam) (2026-09-29)

The first real run put every service and Postgres in Southeast Asia (the account's default region). `setup-mac.sh` now sets region `europe-west4-drams3a` on every service as soon as it exists (the app services before their first build) and moves anything running elsewhere: Postgres right away with its volume (the database is still empty), the other services on their next deploy. It checks where each deployment really runs (`railway service list --json`) and stops at the end if anything is outside EU West. Why EU West: most Solana stake and Helius nodes (Amsterdam, Frankfurt) are in Europe; details in `docs/runbooks/setup-mac.md`. The staging setup uses the same code.

## Rehearsal: STAGING mode (2026-09-29)

For the mainnet dress rehearsal (a separate Railway project, a throwaway test creator, a test coin). Every test-only feature is impossible in production, each rule with a test:
- `STAGING=true` is refused at config load with the production creator wallet (`PRODUCTION_CREATOR_PUBKEY`) and without a creator; `STAGING_CRASH_AFTER_SEND` is refused without STAGING.
- A staging database is marked once by `rat staging-init` (only with STAGING on, only on an empty database, never next to the production creator key). The worker, the API and every CLI command refuse a marked database with production settings, and staging settings on a database holding the production key.
- `rat staging-seed --sol X --confirm "SEED X SOL"`: books SOL already sent to the test creator as hire budget (`hire:seed_credit`), at most 0.5 SOL per seed and 1 SOL in total, never more than the wallet really holds above its reserve. It is never a creator fee: the public claimed figure comes from the claims table only.
- `STAGING_CRASH_AFTER_SEND=N`: the worker kills itself (SIGKILL) right after the Nth hire is broadcast, once per database, to prove crash recovery on mainnet.
- The API sends `treasury.stageSol` (claimed + seeded) only on a staging database with STAGING on, so a rehearsal can show a real stage-up; production never sends it.
- Staging Telegram alerts say STAGING. A fresh staging worker waits, doing nothing, until `rat staging-init`.
- Guard: no deploy or setup file (scripts, Railway files, workflows, Dockerfiles, .env files) turns STAGING or the crash test on, except the staging scripts.

## Site: stages by SOL claimed, Company Roadmap (2026-09-29)

The building's stage now goes by `treasury.totalClaimedSol` (0 / 0.25 / 1 / 5 / 20 / 50 SOL, read only through `apps/pixel-site/src/floor/stage-source.ts`, never closes); rooms, desks, landmarks and the sewer still go by rats hired. New Company Roadmap panel (every stage, done / next with "0.62 / 1 SOL" / locked; one line on a phone), kept clear of the Vault and the job-fair line (headless check at every stage, desktop and phone). Details in `apps/pixel-site/NOTES.md`; screenshots in `apps/pixel-site/assets/preview/sol_stages/`.

Rehearsal: a STAGING API also sends `treasury.stageSol` (claimed plus the rehearsal seed). The site uses it for the stage only on a page opened with `?api=<staging API>`; the production build ignores it, and the HUD's claimed figure is always `totalClaimedSol` (`floor.test.ts`).

## Fix: railway ssh never ran anything (unregistered SSH key), and a route without ssh (2026-09-29)
**Root cause (from the owner's real run and railway CLI 5.63.1's source):**
- `railway ssh keys list` also prints this Mac's keys that are not registered, under "Local Keys (not registered)". setup-mac.sh looked for the key's fingerprint in the whole list, found it there and skipped `railway ssh keys add`.
- Railway's relay then refused the unknown key with `{"status":"signup_required", "human_signup_url": ...}` and exit code 0, so no command ever ran in the worker. Setup read the empty answer as "the worker's settings could not be reached".

**Fixes:**
- Only the "Registered SSH Keys" part of the list counts.
- `ssh_ready` sends a marker before the first command. The marker must come back; the exit code is never trusted. On `signup_required` it stops and prints Railway's link plus the `railway ssh keys add` line. Other relay answers are retried, then shown.
- The settings check prints a names-only diagnosis when it fails: the user, whether a settings line arrived on stdin (and which names it lacks), and how many processes had unreadable settings.
- `scripts/rat.sh` spots `signup_required` too and prints the link.

**New `scripts/rat-local.sh`, the route without railway ssh:** it runs `rat` commands on the Mac against Postgres's public address (TLS).
- The settings go on stdin to `scripts/in-worker.cjs` (`RAT_SETTINGS_FROM=stdin`: only those count), in a clean environment.
- `keys import` asks for the key in a hidden prompt and encrypts it on the Mac.

**Tested:**
- **Harness:** the fake Railway now lists keys and refuses unknown keys exactly like 5.63.1.
  - The script from `main` reproduces the owner's stop and its cause.
  - The new script registers the key and finishes.
  - When registration is impossible, setup and `rat.sh` print the link, and the same command finishes once the key is linked.
- **`rat-local.sh` against a real Postgres 16 that refuses non-TLS connections, as a non-root user:**
  - the key import goes through the hidden prompt, and the key is stored encrypted and never shown;
  - over 1.4 million process samples, the creator key, the master key and the database password never appeared on any command line.

## Fix: setup step 7 called a stored, working creator key "not usable" (2026-09-29)
**Root cause:** the key check ran `rat preflight --json` in the worker and looked for `creator key: PASS`. Before launch, preflight always has FAIL lines (no COIN_MINT yet, the creator wallet not funded), so it exits 1. Under `set -o pipefail` that exit code made the whole check fail even when the line said PASS.
- The owner's first run stored the key and still stopped. The second run was told "a creator key is already stored", then stopped the same way.
- The harness missed it because its fake preflight always exited 0.

**Fix (`scripts/setup-mac.sh`):**
- `preflight_json` returns preflight's JSON line and ignores its exit code; step 8 uses it too (it would otherwise have exited silently).
- Step 7 reads the `creator key` line:
  - PASS (stored, decrypts with the worker's KEY_ENCRYPTION_KEY, derives CREATOR_PUBKEY) is DONE, with no paste;
  - "no creator key imported" asks for the key;
  - "already stored" is checked instead of failing;
  - a stored key that fails stops with the real reason and never asks to paste again.
- Three more places could end the script silently under `set -e` plus `pipefail` (the import error line, `domain_of`, the healthchecks call). They are guarded now.

**Tested:** in the harness, preflight now exits like the real CLI.
- The script from `main` reproduces both of the owner's stops: "not usable" after storing the key, then "already stored" followed by "not usable".
- The new script counts the stored key as done, asks for nothing, and finishes steps 8 to 10, restore drill included.

## Rehearsal: rat audit and the rehearsal on SimChain (2026-09-29)

- `rat audit` (read-only, production-safe): every booked claim equals what left the creator's fee vaults in its transaction (and its ledger credit); every hired rat was paid by the creator exactly once and holds what the database says; the creator wallet's SOL change over every bot transaction (and external claims) equals the ledger to the lamport. Owner transactions (launch, dev buy, deposits), seeded SOL and emergency sweeps are kept apart. PASS / FAIL / WAIT (in flight), exit 1 unless PASS, `--json` for scripts. On LAUNCH-DAY.md's end-of-day list.
- `tests/e2e/rehearsal.test.ts`: the whole rehearsal on SimChain in LIVE mode with STAGING on and the plan's budget: launch with a 0.1 SOL dev buy (never a fee, no kill), a claim of 0.0009 SOL of real fees booked exactly, a seed and 5 hires at the real salary, a burst at 0.01 SOL under a 0.05 SOL/h cap with the worker killed right after one hire was broadcast (recovered, paid once), the cap pausing and resuming, the kill switch tripped by an unexpected creator transaction with nothing sent after, and `rat audit` PASS / PASS / PASS. A second test tampers with the database: the audit catches both.
- The long CI suite runs with at most 2 workers: four CPU-heavy files in parallel starved a worker past vitest's 60 s RPC timeout once (all tests had passed).

## Fix: Postgres 18 everywhere (the backup stopped at check_versions) (2026-09-29)
**Root cause:** Railway's Postgres template now runs Postgres 18. The backup image used `postgres:16-alpine`, and `pg_dump` 16 refuses a newer server. The owner's step 9 stopped at `check_versions`, which is the job's own guard.

**Fixes:**
- `infra/backup/Dockerfile` is `postgres:18-alpine`. It is the one source of truth for the major.
- `scripts/setup-mac.sh`:
  - step 1 reads that major and runs `brew install postgresql@18` (client tools; no server is started on the Mac);
  - it checks that psql, pg_restore and initdb are that major, and uses them for the restore drill and `railway connect`;
  - at the end of step 3, before anything depends on it, it reads Railway's server version (`\echo :SERVER_VERSION_NUM` over `railway connect`) and stops unless the database, the backup job and the Mac's tools are the same major.
- CI: the backup self-test runs on a `postgres:18` service with `postgresql-client-18` from the PostgreSQL apt repository, and the backup image test checks `pg_dump` is 18.
- `scripts/check-guards.mjs` rule 9: CI's service image, client and client path must equal the Dockerfile's major, and setup may not hard-code `postgresql@N`.
- The docs, `STATUS.md` and the runbook test now say 18.
- Step 9 re-run: until a first backup has succeeded, setup rebuilds the backup service from the latest commit and reads only the new deployment's log. A failed attempt from before (like the owner's `check_versions` stop) is never read again, even if Railway has not redeployed the backup yet.

## Rehearsal: the staging scripts (2026-09-29)
- **`scripts/setup-staging.sh`:** the rehearsal's setup is `setup-mac.sh` with the staging profile.
  - Its own project `wall-street-rats-staging`, folder `~/wallstreetrats-staging`, secrets `~/rat-secrets-staging`, master key, Postgres and R2 bucket (`wsr-staging-backups-...`).
  - It asks for the test creator's public address and refuses production's wallets.
  - It makes a throwaway sweep wallet with Node's ed25519: the key goes in a mode 600 file and is never printed.
  - Settings: `STAGING=true` and `MIN_CLAIM_SOL=0.0003` on the worker, admin and api.
  - No nightly schedule and no healthchecks question.
  - `rat staging-init`, then the kill switch ON, before the key import.
- **`setup-mac.sh` profile hooks** (`WSR_PROFILE`, `WSR_EXTRA_VARS` and others; no `STAGING=true` in it):
  - production refuses extra settings and the staging project;
  - staging refuses the production creator, the production secrets folder and the production project.
- **`scripts/staging.sh check | 1 ... 8 | teardown | report`:** the rehearsal, one phase at a time.
  - Each phase shows what it sends and the SOL, waits for the exact word GO, and opens the kill switch only for that phase. The switch closes on exit, also on FAIL or Ctrl-C.
  - Isolation checks run before every phase: the linked project, STAGING on the worker, the test creator, and a master key compared by hash with production's.
  - The report writes `rehearsal-report.md`. GO only if phases 0 to 8 and the production site check PASS.
- **`scripts/approve-stocks.sh`:** for each enabled xStock it shows the mint and opens xstocks.fi, and you confirm it matches. It then sets `APPROVED_STOCKS` (loaded on top of `config/stocks.json`; an unknown symbol is a config error), redeploys the worker and runs `rat stocks-sync`. The on-chain mint check still applies.
- **`rat status --json`:** one line for scripts, with no secret in it.
- **Fixed along the way:** setup's remote `rat` commands joined their arguments without quoting, so an argument with spaces or parentheses broke the worker's shell (no current command passed one). Each argument is quoted now, as `scripts/rat.sh` already did.
- **Docs:** `docs/runbooks/rehearsal.md`.

**Tested:**
- `tests/scripts/staging-test.sh` (in CI): 16 checks with fake `rat` and `railway`, covering the isolation refusals, the GO gate (anything but GO sends nothing), the kill switch back ON after a PASS and after a FAIL, and GO / NO-GO.
- Setup harness scenario F:
  - `setup-staging.sh` finishes with its own project, STAGING, the test creator, the throwaway cold wallet, a marked database and the kill switch on;
  - it refuses the production creator at the prompt;
  - staging refuses a folder linked to production, and production refuses the staging project;
  - the throwaway key is never shown, and no secret leaks.
- Unit tests for `APPROVED_STOCKS` and `status --json`.

## Site go-live check (2026-09-29)
- **`pages.yml`:** with the repository variable `SITE_API_BASE` set, wallstreetrats.world is built against the production API, and the build must contain it. Without it, the site stays the simulator demo, as before. The simulator stays at `?sim` either way.
- **A new `verify` job** runs after a production build. `apps/pixel-site/tools/verify-live.mjs`:
  - waits for the published bundle to be the one built against that API;
  - checks the API answers and allows the site's origin (CORS);
  - opens the site in Chromium (desktop and phone) and checks: no console errors, the page reached the API, no simulator, the banner the API's mode calls for, RATS HIRED equal to the API's count, and "pre-launch" while there is no coin.
- **`scripts/site-go-live.sh`** (the Mac):
  - checks the API and CORS;
  - shows the two clicks that switch the site and waits for it;
  - asks you to check it on the phone;
  - records `SITE_GO_LIVE` in `~/rat-secrets/setup-state.env`, which the rehearsal report's GO / NO-GO reads.
- **Tested against the real API** (DRY RUN, an empty Postgres, no coin), with the site built against it in Chromium: 15 of 15 checks passed on desktop and phone, including the DRY RUN banner, RATS HIRED 0 and "pre-launch". A site built for another API fails.

## Fix: setup stops during a Railway API incident (2026-09-29)
Miguel's staging setup stopped twice while Railway reported an "API degradation" incident.
- **Stop 1, step 3:** "Railway did not keep the build settings of backup: build.builder is RAILPACK", while the dashboard showed Dockerfile.
  - Cause (Railway CLI 5.63.1 source): `railway environment edit` returns as soon as Railway has queued the change; a background workflow applies it ("returns its id as soon as the workflow STARTS"). The read right after it saw the old settings.
  - Not a wrong environment or service: the service list, the edit and the read all use the linked environment, and the CLI caches nothing.
  - Fix: after each change (build settings, region, nightly schedule) the settings are read again for up to 5 minutes (`WSR_APPLY_WAIT_SEC`), and the change is sent once more halfway. The comparison is unchanged. If it still differs, the stop names the project, environment and service id and prints that service's exact dashboard page.
- **Stop 2, step 5:** `railway variable set BACKUP_AGE_RECIPIENT` failed with "error decoding response body".
  - Fix: every `railway variable set` (setup, `staging.sh`, `approve-stocks.sh`) and `environment edit` is tried 3 times, then read back.
- **Found while fixing:** a failed read was taken for "not set".
  - In setup this could have written the local master key over a different one on Railway, skipping the "never replace it" check. Now every read that decides something is retried and otherwise stops the script. The same goes for the service list (no second service with the same name) and `environment config` (an older CLI is recognized from its help, not from a failure).
  - In `staging.sh`, a failed read counted as "not the production master key". Now it fails the isolation check.
  - `approve-stocks.sh` confirms APPROVED_STOCKS is really removed.
- **Re-running never regenerates a secret:** secret files are only created when missing, and Railway's secrets are only set when Railway lists the variables without them.
- **Tests:**
  - Setup harness scenario H: main's script reproduces the stop. The new one finishes with every 4th call failing and every change lost once and applied late. A change Railway never applies still stops, and nothing is built. After a step-5 stop the re-run finishes with every secret file and Railway secret unchanged. An unreadable worker, or one with a different master key, is never overwritten.
  - `staging-test.sh`: 4 new checks.

## Rehearsal: the short version (2026-09-29)
Miguel wants only the money mechanisms before launch: phases 1, 2, 3 and the kill switch part of 6.
- **Where the time went:** every `redeploy` is a full build of the repo, one service after the other. A plain `railway redeploy` rebuilds too (Railway docs, `builds/skipped-builds.md`), so the flag alone saves nothing.
- **`redeploy worker api`** (`scripts/lib/wsr.sh`): every service's build starts first, then one wait for all of them. Phase 1 waits for 2 builds instead of 4. Its triggers are tried 3 times (Railway incident); a failed build still stops, naming the service.
- **Phase 1** tells you to do phase 2's trades while it builds; phase 2 then only claims.
- **`staging.sh 6 --skip-watchdog`:** the kill switch part only (about 5 minutes, no build). Recorded as `PARTIAL`, never `PASS`, so the report can never say GO without the watchdog test. Phase 6 now needs phase 1 (a live worker), not phase 4.
- Every GO gate, the kill switch per phase, every audit and every check are unchanged.
- **Tests:** `staging-test.sh`: 26 checks (6 new: both builds start before any wait, a failed build stops; phase 6 without phase 1 refused, `--skip-watchdog` records PARTIAL and never stops the worker, an unknown option refused; PARTIAL makes the report NO-GO).

## Rehearsal: the fast version on the Mac (2026-09-29)
The rehearsal was slow only because every settings change rebuilt the app on Railway (during a Railway incident). Now the staging worker, API and site can run on Miguel's Mac against mainnet and the staging database: a change is a restart in seconds.
- **`scripts/staging-local.sh start | restart | stop | status`:**
  - same guards as `staging.sh` (now shared in `scripts/lib/staging-guard.sh`);
  - stops the Railway staging worker first (only one worker ever runs, by its lock);
  - the settings are the staging services' own Railway variables, handed to each app on stdin by `scripts/local-app.cjs`: never on a command line, never printed, never on disk;
  - the worker reaches the database through Postgres's public address (TLS); the API through it with its own read-only user, never the master key;
  - stops are graceful (the worker finishes its tick and releases its lock), never a hard kill; a stale process id is never taken for the app.
- **Local mode** in `staging.sh` and `approve-stocks.sh`: a redeploy is a local restart, `rat` runs through `scripts/rat-local.sh`. Only when the staging state says so AND the folder is linked to that same staging project (a production folder never is).
- **`STAGING_STAGE_SCALE`** (default 20 on the local API): multiplies the stage source so 3 rats cross a stage. The config refuses it without STAGING, the API applies it only on a marked staging database, the public claimed figure is never scaled, and `check-guards` rule 8 fails any deploy file that sets it above 1. Phase 3 checks the stage source against claimed plus seeded times the scale.
- **`staging.sh 3 --rats N`** (2 to 5): the seed and the confirmation phrase follow N.
- **Tests:**
  - `tests/scripts/staging-local-test.sh` (CI): 18 checks with a fake `railway` and stand-in apps run by the real launcher (guards; the settings each app gets; nothing from the shell; no secret on any command line, log or screen; restart with changed settings; `staging.sh 6` in full using the local worker with no build; stop).
  - Unit tests: the config refuses the scale without STAGING (also next to the production creator); the API scales the stage source only and never the claimed figure; unscaled and absent on an unmarked database.
  - In the sandbox, the real worker, API and site ran through the launcher against a real Postgres 18: the API answered with CORS for the local site and the stage source, the worker ran its loops, a stop was graceful and released the lock, and no process was left.

## Launch day in one build (2026-09-29)
Launch day used two Railway builds between the coin and a live bot (the coin's settings, then going live). Now one.
- **`rat --with KEY=VALUE preflight`** (`scripts/in-worker.cjs`): the live preflight runs with the coin's settings BEFORE anything changes on Railway. Only `COIN_MINT`, `WATCH_FROM_SLOT`, `KNOWN_OWNER_TX_SIGS`, `DRY_RUN`, `LIVE_CONFIRM`, and only for the read-only `preflight`: any other key or command is refused.
- **`scripts/lib/launch.sh`**, shared by the launch and the rehearsal: find the launch on chain, the preflight with the coin's settings, then every launch setting in one change per service (read back) and one redeploy of the worker and the API side by side.
- **`scripts/launch.sh`** (production): refuses anything but the production project, the production creator wallet and a DRY RUN bot; waits while you launch; `launch txs` and `dev buy` PASS and no FAIL with the coin's settings, or nothing changes; nothing without the exact word GO; ends with LIVE checked. About 5 minutes plus one build from the coin to the bot live.
- **`staging.sh 1`** runs the same steps (the kill switch stays ON), so the rehearsal tests what launch day runs. LAUNCH-DAY.md, go-live.md and rehearsal.md updated.
- **Tests:** `tests/scripts/launch-test.sh` (19 checks, in CI: every refusal changes nothing; the preflight sees exactly the coin's settings; order preflight, reset, settings, redeploys; one change per service; one redeploy each; a launch typed by hand; `--with` only for preflight and only the launch settings). `staging-test.sh`: phase 1 in 5 new checks.

## Fix: rehearsal phase 8 on Postgres 18, and the results file (2026-09-29)
- **Phase 8** still used the Postgres 16 tools (`postgresql@16`): a pg_restore 16 cannot read the Postgres 18 backup, so the drill would always FAIL. It now reads the major from `infra/backup/Dockerfile`, as setup does, and checks that initdb, pg_ctl and pg_restore really are that major before any backup starts.
- **`check-guards` rule 9** now fails a hard-coded `postgresql@N` in any script (it only looked at `setup-mac.sh`, which is how phase 8 slipped through).
- **The results file** (`state_set` in `scripts/lib/wsr.sh`): every write used the same temporary file, so two scripts writing at once lost lines (the old version kept 1 of 20 simultaneous writes). Now a lock and its own temporary file per write; a lock left by a killed script is taken over after 10 seconds.
- **Tests** (`staging-test.sh`, 4 new): 20 simultaneous writes all kept; a stale lock taken over; phase 8 refuses Postgres 16 tools before any backup, accepts Postgres 18 ones.

## Check: production auto-deploy (read only, 2026-09-29)
- `docs/runbooks/auto-deploy.md`: the repo proves setup connects every production service to `MikuEspana/rat` branch `main`, and worker, api and admin have no watch paths, so if Railway's auto deploy is on (its default) every merge to `main` rebuilds and restarts them. Harmless in DRY RUN; a risk during the launch.
- Proposal, nothing changed: no merges to `main` from T-1 hour until the bot has run live for an hour; "Wait for CI" on the production worker, api and admin; watch paths after launch; disabling auto deploy only if manual deploys are preferred. Whether auto deploy is on is for Miguel to confirm in the dashboard.

## Docs: the morning checklist (2026-09-29)
- `docs/runbooks/MORNING.md`: status.railway.com first, pull, finish the staging setup, the fast rehearsal (commands, minutes and what PASS looks like for each), production prep (stock approval, preflight, site go-live, the auto-deploy decision, funding), then `scripts/launch.sh`. Listed in `docs/runbooks/README.md` with `rehearsal.md` and `auto-deploy.md`.

## Red team: the money paths against mainnet failure modes (2026-09-29, night)
Four read-only audits (claim, hire and Jupiter, sending and recovery, keys) plus the randomized chaos run (`tests/chaos/fuzz.ts`, next PR). Every fix has a test that fails without it.
- **Sending.** The expiry check read the block height and the signature status in two calls: behind a load-balanced RPC a lagging status node called a landed hire expired, and the rat was paid twice. Now one `getEpochInfo` and a status answer from a node at least that far. A rejected send (any JSON-RPC error, another node may have forwarded it) stays `unknown` until its blockhash expires and is never rebroadcast. The kill switch is checked again right before the send.
- **Hourly cap.** A release counted at its own time freed cap room after its reservation had left the window (about 2% over the cap under drops). Settles and releases now count at the reservation's time.
- **Claims.** Two workers in a redeploy overlap both booked the same claim (chaos seed 37): every claim status change is now conditional on the claim being open, with its ledger entries in one transaction. A claim pending when the kill switch went on was never booked (chaos seed 1): open claims are re-checked while killed (a read, nothing sent). An external claim retried after a crash no longer jams the watch. A stranger-built claim is measured over both vaults together.
- **Watch.** A leaked-key tx is acted on (kill switch, alert) before it is marked seen. A failing claim step no longer skips the watch; hires only run after a successful watch.
- **Launch.** Preflight FAILs, and the worker alerts every 10 minutes, when the coin's bonding curve does not pay its creator fees to `CREATOR_PUBKEY` in SOL (another wallet, fee sharing, holder rewards, cashback, not SOL-paired): the bot would claim nothing, silently. A failed launch retry signed by the creator is listed in `KNOWN_OWNER_TX_SIGS` and the watch floor comes after it.
- **Keys.** `scripts/keys-backup.sh` saves the key backup on the Mac (`rat keys backup` inside Railway wrote to the container disk). The creator re-import and the worker refuse a changed master key under the same `KEY_VERSION`. The worker and CLI read the previous key during a rotation. A malformed key never shows up in an error. New setups revoke `key_pool` from the API's read-only user.
- **Sweep.** Works when the creator is drained (each rat pays its own fee), moves the SOL of frozen or paused accounts, sweeps rats still being hired only with the kill switch on, exits 1 when anything is left; staging teardown stops before "delete the project" while any rat wallet holds anything.
- **Worker.** Startup waits out an RPC or database hiccup instead of exiting (Railway gives up after 10 restarts). two_step (the fallback) retries a swap refused before sending instead of raising a false critical alert, and no longer builds a swap for an empty wallet. A stale SOL price stops hires like a stale stock price.
- **SimChain** now mirrors the network where the chaos run needed it: rejected sends stay unknown, a tx whose blockhash expired never lands.

## Chaos run: thousands of randomized launches on SimChain (2026-09-29, night)
- `tests/chaos/fuzz.ts`: one seed is one launch (20 to 90 loops of 35 s, then calm until every hire settles). At random:
  - fee bursts, strangers claiming our vault, 0 to 60% of claims and hires dropped, failed, timed out or rejected;
  - RPC, database and Jupiter outages; stocks with no route or no price; price shocks;
  - random hourly caps (0.05 to 60 SOL), a transaction signed by the creator key that the bot did not send (a leak);
  - the worker killed in the middle of any operation (a crash mid-send), and a worker frozen mid-operation that wakes up after its replacement took the lease (a redeploy overlap).
- Every worker process runs behind the real lease and send fence.
- Checked after every loop:
  - the creator's own SOL is never spent;
  - the rolling-hour spend stays under the cap;
  - spend never exceeds claims;
  - nothing is sent once the kill switch is on;
  - a leaked-key tx turns the kill switch on within 3 loops of a live worker holding the lease.
- At the end: the full money check against the chain (every lamport that left our vaults booked once, ledger equals chain to the lamport, no rat funded twice) and no rat left half hired.
- **What it found** (fixed in the red team PR, each with a regression test):
  - two workers in a redeploy overlap both booked one claim (seed 37);
  - a claim pending when the kill switch went on was never booked (seed 1).
  - It also exposed where SimChain was kinder than the network: rejected sends, and txs sent after their blockhash expired.
- **Numbers:**
  - on the code before the fixes, about 800 seeds: 35 failures (the bugs above plus harness mistakes, since fixed);
  - on the fixed code: 679 seeds so far, 0 failures (the run continues through the night).
- CI runs 8 seeds in the long job. Thousands in shards: `CHAOS_RUNS=667 CHAOS_SEED=1 CHAOS_VERBOSE=1 pnpm vitest run tests/chaos/fuzz.test.ts`. Replay one seed step by step: `CHAOS_SEED=<n> CHAOS_RUNS=1 CHAOS_TRACE=1`.

## Launch dress rehearsal: Railway slow and failing (2026-09-29, night)
`tests/scripts/launch-rehearsal.sh` (in CI) runs `scripts/launch.sh` against fakes with Railway as slow as during its incidents and failing on purpose, timing every call.
- **Timing** (scaled 1:20, estimated at incident speed: 2 s per Railway call, 8 s per `railway ssh`, a 5 minute build): about 6 minutes from start to LIVE, almost all of it the one build. 9 Railway calls (18 before: the RPC address was read from Railway before every chain read, and the read-back after setting variables read once per key), 5 ssh calls.
- **Found and fixed:**
  - `rat_json` failed when `railway ssh` dropped, and under `set -e` and `pipefail` `launch.sh` then ended **without a word** right after the build. Now an empty answer, and each step says what went wrong.
  - A second run after a stop halfway was refused ("already set to LIVE") or asked for the launch again. It now finishes: it takes the coin's settings from the worker, confirms the mint, GO, completes what is missing and redeploys. With the worker already LIVE (only the API build failed) it only offers the API redeploy.
  - Right after the build, `railway ssh` can reach the old DRY RUN container while it drains, or drop: the LIVE check asks for up to two minutes before calling it, and says whether the worker answered DRY RUN or did not answer.
  - A live preflight that did not answer said "launch txs is not PASS, the line above says why" with no line above: now "the live preflight gave no answer (railway ssh)", nothing changed, run it again.
- 10 checks: incident-speed timing; reads failing twice; a lost write then the second run; a failed API build then the second run; the old container answering and ssh dropping after the build; ssh down for the preflight.

## Faster, smaller service image (2026-09-29, night)
- `.dockerignore` keeps the site (`apps/pixel-site`, 73 MB of assets, served by GitHub Pages), the tests, the docs and the Markdown out of the image. `infra/Dockerfile` installs only what the services run (`pnpm install --prod`); `tsx` is now a dependency of each app that runs with it, so TypeScript, the test tools, vite and drizzle-kit stay out.
- Measured here (Docker 29, BuildKit, same machine and network for both): image 761 MB to 545 MB; the install layer 192 MB to 141 MB; the source layer 79 MB to 1.7 MB; a clean build 30 s to 19 s; a rebuild after a code-only change (the usual merge) about 5 s to about 1.3 s. On Railway most of a build is uploading the context and pushing the image, so the smaller layers are what count (ASSUMED: Railway's timings are not measurable from here).
- CI now starts the worker, the API and the admin in the image with an invalid `DRY_RUN`: reaching that config error proves every import resolved with the production-only install (a module left out fails first; checked with an image missing `hono`: the API fails the step).

## Site: launch-day states, empty states, phones (2026-09-29, night)
Checked in Chromium, desktop and phone (320 to 430 px wide), against fixture API states (before the coin, just launched with the bot not up, a stale bot, the first claim, paused, every stage from 3 to 3,100 rats), the live mock, and `?sim` at 300x (normal, mega, rush): no console errors anywhere.
- **Bot starting looks intentional.** The next-hire ring said "hiring..." forever while the worker was still starting after launch. It now says "bot starting" (never claimed) or "back soon" (a restart) with a slowly turning arc, and "opens at launch" before the coin exists. The simulator (clock up to 300x) never reads as stalled.
- **DRY RUN banner** says what is going on: "pre-launch rehearsal" before the coin, "warming up ... real hiring starts when it goes live" after it. Both still start with `DRY RUN:` (the live site check looks for it).
- **No rats yet:** RATS HIRED says "first hire soon" (not "all at work"), the leaderboard and the live feed explain why they are empty, and the news ticker no longer says "HIRES ITS 0TH RAT" (nor 1TH, 2TH, 3TH, 22TH: English ordinals now).
- **Phones:** the leaderboard sat on top of the live feed's rows (a later CSS rule put both at the same height), and "find my rat" and TIMELAPSE ran off the right edge of the HUD. Both fixed; `tools/verify-live.mjs` now fails on either.
- **API down** (a redeploy): the page says "Reconnecting to the trading floor..." instead of the raw API address and error (still in the console and on hover).

## scripts/morning.sh: the morning checks, GO or WAIT (2026-09-29, night)
- One command for `docs/runbooks/MORNING.md` step 0, from `~/wallstreetrats`. Read-only: it changes nothing on Railway, signs and sends nothing, prints no secret.
- It stops at once in the wrong folder (not the production project, a STAGING worker, another creator wallet), like `scripts/launch.sh`.
- Then one line per check, OK or WAIT with the fix:
  - the scripts up to date with main;
  - status.railway.com has no incident (its `summary.json`);
  - the "Limited Access" banner gone (you answer: Railway shows it only on the dashboard);
  - worker, api and admin deployed;
  - production in DRY RUN with no `LIVE_CONFIRM`;
  - the running worker in DRY RUN with loops under 3 minutes old;
  - `rat preflight` with nothing open but the expected pre-launch lines (the same rule as `scripts/setup-mac.sh`).
- `tests/scripts/morning-test.sh` (22 checks, in CI): GO only when all pass, each problem its own WAIT, never a Railway write.

## Fast rehearsal: `staging-local.sh start` no longer fails at random (2026-09-29, night)
- CI caught `scripts/staging-local.sh start` stopping with "the local worker stopped right after it started" while the apps were in fact starting.
- Right after `nohup node ... &` the new process can still be the forked shell, not node yet (fork before exec). The readiness check looked for `scripts/local-app.cjs <app>` in its arguments and took it for a crash.
- A slow Mac can hit the same thing tomorrow at MORNING.md step 1 (`scripts/staging-local.sh start`).
- Now, for the first 5 seconds a process that is alive counts as starting. One that is gone, or never becomes the app, still stops the start.
- `tests/scripts/staging-local-test.sh` forces that moment with a fake `ps`: it fails without the fix.
