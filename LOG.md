# Work log (autonomous run)

Started 2026-09-27. Each item: its own branch and PR, CI green (guards, typecheck, tests, Docker), then merged into the integration branch `claude/rat-race-planning-1qouxa`. `main` is never touched: the integration PR [#27](https://github.com/MikuEspana/rat/pull/27) stays open for Miguel to merge ("merge everything" was read as: merge every item PR into the integration branch).

Hard limits kept throughout: DRY RUN on, no mainnet transaction, no Jito call, test keypairs only, no secrets, no cloud accounts, no holder payouts, no safety check weakened, no em dashes.

## Summary

| # | Item | PR | Result |
|---|---|---|---|
| Q1 | Remove vanity keys | (this PR) | done |

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
