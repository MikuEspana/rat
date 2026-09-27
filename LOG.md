# Work log (autonomous run)

Started 2026-09-27. Each item: its own branch and PR, CI green (guards, typecheck, tests, Docker), then merged into the integration branch `claude/rat-race-planning-1qouxa`. `main` is never touched: the integration PR [#27](https://github.com/MikuEspana/rat/pull/27) stays open for Miguel to merge ("merge everything" was read as: merge every item PR into the integration branch).

Hard limits kept throughout: DRY RUN on, no mainnet transaction, no Jito call, test keypairs only, no secrets, no cloud accounts, no holder payouts, no safety check weakened, no em dashes.

## Summary

| # | Item | PR | Result |
|---|---|---|---|
| Q1 | Remove vanity keys | [#34](https://github.com/MikuEspana/rat/pull/34) | merged |
| Q2 | Red-team every money path | [#35](https://github.com/MikuEspana/rat/pull/35) | merged, 14 bugs fixed |
| Q3 | Property tests (fast-check) | (this PR) | done, 1 bug fixed |

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
