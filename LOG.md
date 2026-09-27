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
| Q11 | Cleanup | [#42](https://github.com/MikuEspana/rat/pull/42) | merged |
| Q12 | Extra launch-risk reduction | [#43](https://github.com/MikuEspana/rat/pull/43) | merged, 4 items |
| Final | STATUS.md | (this PR) | queue empty |

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
