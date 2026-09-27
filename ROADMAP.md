# RAT RACE v1 Roadmap (approved)

Approved by the owner on 2026-09-27 with the answers below. Mechanics are in `README.md`, the website JSON is in `CONTRACT.md`.

Tags for external facts: **VERIFIED** (read in official docs or code), **REPORTED** (secondhand), **UNCLEAR**. Numbers like [1] point to Sources at the bottom.

## 1. Owner decisions (final)

| # | Decision |
|---|---|
| 1 | Spend cap **30 SOL/hour per bucket** (hire, burn), 60 total, alert at 50% of each |
| 2 | HOODx and CRCLx skipped (mints not verified) |
| 3 | 1-tx hire by default, 2-tx fallback behind `HIRE_MODE=two_step`. The smoke test decides |
| 4 | Direct pump.fun buy fallback when Jupiter has no route |
| 5 | Coin token program detected at runtime |
| 6 | Scaled UI multiplier vs Jupiter price: checked against one stock with a script before launch |
| 7 | Claims we did not send: if SOL left **our** creator vault through a pump.fun claim instruction (any signer), auto split 50/50 like our own. Anything else unexplained: alert, leave unspent |
| 8 | Tier names kept: intern, analyst, associate, vp, partner |
| 9 | All math fee-agnostic: only what was actually claimed is used |
| 10 | Jupiter free tier. Limit is config (`JUPITER_MAX_RPM`) |
| 11 | Emergency sweep: CLI only, typed confirmation, never run by the bot |
| 12 | Before any stock can be hired into: mint must be Token-2022 and its mint authority must match the other xStocks. Failing mints are rejected |
| 13 | No Supabase, Railway or Vercel resources are created by agents. Config and runbooks only |
| - | PnL in USD, display only. Rats keep a small SOL buffer for a future sell feature. EU operator, proceed |

## 2. Stack

- TypeScript on Node 22, pnpm workspaces, ESM, run with `tsx` (no build step).
- `@solana/web3.js` v1 + `@solana/spl-token`.
- Postgres (Supabase in prod) with Drizzle ORM. Tests use PGlite (Postgres in WASM), so no Docker needed.
- Hono for the API, `commander` for the CLI, `zod` for config and contract validation, `pino` logs with secret redaction.
- Vitest for tests, GitHub Actions CI.
- Deploy target: Railway (worker + api) and Vercel (site). Config and runbooks only.

## 3. Repo layout

```
apps/
  worker/     the bot: claim, hire, burn, prices, freeze, reconcile, creator watch, key pool
  api/        public read-only state API (CONTRACT.md)
  cli/        status, kill, resume, keys, ledger, dry-run reset, emergency sweep
packages/
  core/       domain types, ports (interfaces), config, money math, logger, fake clock
  contract/   frontend types, zod schemas, display math, mock JSON
  db/         Drizzle schema, migrations, repositories, ledger
  keys/       AES-256-GCM vault, vanity key grinder, key store
  chain/      RPC reader, the ONLY transaction sender, SimChain for tests
  pump/       pump.fun claim / burn / direct buy builders, external claim parser
  jupiter/    Price API v3 client, Swap v2 /build client, rate limiter, mocks
  safety/     spend guard (ledger + caps), kill switch, guarded sender, alerts, mint verifier
tests/
  e2e/        full simulated loops (mocks + fake clock), incl. a 50 SOL hour in DRY RUN
  smoke/      mainnet smoke script (0.1 SOL cap). Written, NOT run
infra/        Dockerfiles, railway.json
docs/runbooks/
config/stocks.json
```

## 4. How the loops work

**Claim (every 35s)**
1. Read claimable from both vaults: bonding curve `creator_vault` PDA (`["creator-vault", creator]`, pump program) and PumpSwap `coin_creator_vault_ata` (authority PDA `["creator_vault", creator]`, pump_amm program). VERIFIED [1][4].
2. Skip if under `MIN_CLAIM_SOL` and nothing is owed to the fund.
3. One tx signed by the creator: `collect_creator_fee_v2` (pays native SOL for SOL-paired coins) and/or `collect_coin_creator_fee` (pays WSOL, then we close the WSOL account to unwrap) + a transfer of the fund's share to the fund wallet. VERIFIED [1].
4. Claimed amount = what left **our vaults** in that tx (vault balance deltas), not the creator wallet delta. Ledger: hire += claimed - fund share - tx fee, burn += fund share.

**Creator watch (every 35s)**: new signatures on the creator wallet that are not ours are parsed. A pump.fun claim instruction for our creator (claims are permissionless, VERIFIED [1]) is credited and split 50/50; its fund share rides in our next claim tx. Anything else is alerted and left unspent. An unknown tx signed BY our creator trips the kill switch.

**Hire (after each claim)**
1. `n = min(hire bucket / salary, MAX_HIRES_PER_LOOP, cap room, key pool)`.
2. Pick a stock weighted by 24h return rank (Jupiter `priceChange24h`, VERIFIED [5]), 5% floor, only approved + mint-verified + active + fresh-priced stocks.
3. Jupiter Swap v2 `GET /swap/v2/build` with `taker` = rat, `payer` = creator (VERIFIED [6]). One tx: creator transfers salary minus overhead to the rat, rat swaps salary minus buffer. Both sign.
4. Attempt recorded before send. Never retry while an attempt can still land. Before a retry, read the rat wallet: if it holds the stock, it is active.

**Burn (random 8 to 12 min, chunks of at most 1 SOL, 1.5% slippage; updated after the owner review)**: `min(burn bucket, fund balance - reserve)`, skip under 0.01 SOL. `/build` SOL to coin with `taker` = fund, burn in the same tx (min out + leftovers). Fallback: direct pump.fun buy (`sharing_config` account is mandatory for buys, VERIFIED [3]). Burn uses the coin's token program (pump `create_v2` coins are Token-2022, VERIFIED [2]).

**Prices (every 15s)**: one Jupiter Price v3 call for all stocks + SOL + coin (max 50 ids per call, `x-api-key` header, VERIFIED [5]). Missing tokens are marked stale, never zero.

**Freeze (every 35s)**: read all stock mints: Pausable `paused` flag (REPORTED [9]) and Scaled UI multiplier. Paused stock = its rats frozen, one event. **Reconcile**: 500 rat token accounts per loop, account frozen or balance mismatch = rat frozen + alert (issuer has a permanent delegate, REPORTED [8]).

**Mint verification (startup + hourly)**: every configured mint must be owned by Token-2022 and share the expected mint authority (`XSTOCKS_MINT_AUTHORITY` or the majority of at least 3 configured mints). Failing mints are rejected and never hired into.

## 5. Capacity

- At swarmed-like volume (180 SOL of fees in 7h) about 90 SOL goes to hires = about 3,000 rats. Built for 6,000.
- Peak 50 SOL/h claimed: about 25 SOL/h per bucket, under the 30 SOL/h per bucket cap.
- Jupiter: 1 `/build` per hire + 1 per burn + 4 price calls/min. At 20 hires per 35s loop that is about 38/min, under 55/min.

## 6. Workstreams

Integration branch: `claude/rat-race-planning-1qouxa`. Each workstream branches from it, opens a PR into it, and is merged there when its tests pass. The integration branch then has one PR into `main` for owner review.

| # | Workstream | Owns | Depends on | Branch |
|---|---|---|---|---|
| WS01 | Foundation | root tooling, CI, `packages/core` | none | `ws/01-foundation` |
| WS02 | Contract | `packages/contract` | WS01 | `ws/02-contract` |
| WS03 | Database | `packages/db` | WS01 | `ws/03-db` |
| WS04 | Keys | `packages/keys` | WS01 | `ws/04-keys` |
| WS05 | Chain | `packages/chain` | WS01 | `ws/05-chain` |
| WS06 | Pump | `packages/pump` | WS01, WS05 | `ws/06-pump` |
| WS07 | Jupiter | `packages/jupiter` | WS01, WS05 | `ws/07-jupiter` |
| WS08 | Safety + CLI | `packages/safety`, `apps/cli` | WS01, WS03, WS04, WS05 | `ws/08-safety` |
| WS09 | Worker | `apps/worker` | WS01 to WS08 | `ws/09-worker` |
| WS10 | API | `apps/api` | WS02, WS03 | `ws/10-api` |
| WS11 | Tests | `tests/e2e`, `tests/smoke` | WS09 | `ws/11-tests` |
| WS12 | Deploy | `infra/`, `docs/runbooks/` | WS09, WS10 | `ws/12-deploy` |

Conflict rules: write only inside owned folders; root files and `packages/core` belong to WS01; only WS03 writes migrations; never hand-edit `pnpm-lock.yaml`.

### WS01 Foundation
- Owns: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`, `.github/workflows/ci.yml`, `scripts/`, `packages/core/**`.
- Outputs: domain types, ports, `loadConfig()` for every var in `.env.example`, lamports math (bigint), logger with redaction, fake clock + seeded rng, stock picker.
- Acceptance: install + typecheck + tests green in CI; config rejects bad values; secrets never logged; lamports round trip exact; guard script fails if `sendRawTransaction`/`sendTransaction` appears outside the chain sender.

### WS02 Contract
- Owns: `packages/contract/**`.
- Outputs: types + zod schemas for the 3 responses, `computeRatView`, `tierFor`, `sizeScaleFor`, `rankRats`, `summarizeStocks`, solscan helpers.
- Acceptance: mock JSON validates; unit tests for pnl, tier boundaries, rank ties, size clamp, frozen rats; only `zod` as dependency.

### WS03 Database
- Owns: `packages/db/**`.
- Outputs: schema (settings, stocks, stock_prices, rats, key_pool, ledger_entries, claims, burns, tx_attempts, events, heartbeats, seen_signatures), migrations, repositories implementing the core stores, single-worker advisory lock.
- Acceptance: migrations run on PGlite; ledger exact to the lamport; one rat per wallet; paper and live rows never mix; roster of 6,000 rats under 200ms.

### WS04 Keys
- Owns: `packages/keys/**`.
- Outputs: AES-256-GCM vault (random IV, auth tag, key version), vanity grinder (Node worker threads), key store (creator, fund, rat keys).
- Acceptance: round trip; tamper and wrong key fail; every pool key ends with the suffix and matches its secret; no plaintext secret in DB or logs.

### WS05 Chain
- Owns: `packages/chain/**`.
- Outputs: RPC chain reader (balances, mint states incl. Pausable + Scaled UI, token accounts, signatures, tx records), `RpcTxSender` (the only send path, refuses without live confirmation), `SimChain` + `SimTxSender` for tests (failure injection: drop, fail, land-but-timeout).
- Acceptance: mint parsing on synthetic Token-2022 mints; expiry classified; send blocked unless live-confirmed.

### WS06 Pump
- Owns: `packages/pump/**`.
- Outputs: PDAs, `getClaimable`, claim instructions (exact account order from the IDL), burn instruction for both token programs, external claim parser, direct buy fallback via `@pump-fun/pump-sdk`, mock pump client.
- Acceptance: account lists and discriminators match the IDL [4]; unwrap only when needed; burn picks the right program; external claim parser finds our vault delta and ignores other creators.

### WS07 Jupiter
- Owns: `packages/jupiter/**`.
- Outputs: Price v3 client (batched), Swap v2 `/build` client with `payer`, rate limiter, mocks, scaled UI check script (not run).
- Acceptance: never exceeds the limit under load; >50 ids split; missing price = stale; `/build` response parsed into instructions + lookup tables.

### WS08 Safety + CLI
- Owns: `packages/safety/**`, `apps/cli/**`.
- Outputs: spend guard (ledger bucket, per-bucket hourly cap, smoke lifetime cap, wallet reserve, 50% alerts), kill switch (env or DB), guarded sender (kill switch + dry run + reservation required + attempt log), Telegram alerts, mint verifier, CLI incl. emergency sweep (typed confirmation).
- Acceptance: spending fails when the bucket is short even if the wallet has SOL; cap exact per bucket; alert once at 50%; kill switch blocks; sweep refuses without the typed phrase and in dry run only prints the plan.

### WS09 Worker
- Owns: `apps/worker/**`.
- Outputs: executors (claim, hire single/two-step, burn), steps (claim, creator watch, hire, burn, prices, freeze, reconcile, mint verify, key pool), scheduler (no overlap, single instance lock, heartbeats), dry run paper accounting.
- Acceptance: on mocks + PGlite + fake clock: correct hires, exact ledger, no hires into paused/unverified stocks, restart mid-hire never double funds, max 20 hires per loop.

### WS10 API
- Owns: `apps/api/**`.
- Outputs: Hono server with the 4 endpoints, 3s cache, gzip, CORS, per-IP rate limit.
- Acceptance: responses validate against the contract schemas; 6,000 rats served fast; no extra fields leak.

### WS11 Tests
- Owns: `tests/**`.
- Outputs: e2e scenarios (launch surge 50 SOL/h in DRY RUN, caps, expiry retry, land-but-timeout, pause/unpause, kill switch, burn skip, external claim, 6,000 rats, restart, two workers), smoke script + runbook (not run).
- Acceptance: all scenarios green in CI.

### WS12 Deploy
- Owns: `infra/**`, `docs/runbooks/**`.
- Outputs: Dockerfile (one image for worker and API), Railway config per service, read-only Supabase role, runbooks: deploy, go-live, kill switch, keys (incl. rotation), backup/restore, incident.
- Acceptance: files lint as valid JSON/YAML; runbooks reference only real commands.

## 7. Safety

- **Keys**: AES-256-GCM in the database. Env holds only the master key. Keys decrypted in memory only to sign.
- **Ledger-only spending**: hires spend only the hire bucket, burns only the burn bucket, the creator reserve and the fund's pending share are never spent. Unexplained SOL is never spent.
- **Caps**: 30 SOL per rolling hour per bucket. At the cap, spending pauses (budget carries over). Alerts at 50% and 100%.
- **Kill switch**: env, database flag or CLI. Checked in the guarded sender before every send.
- **DRY RUN** default on. Live needs `DRY_RUN=false` and the exact `LIVE_CONFIRM` phrase. The RPC sender refuses to send otherwise.
- **One worker**: Postgres advisory lock.
- **Mint verification** before any hire. **No holder payouts**: there is no code path that pays holders.

## 8. Testing

- Unit tests per package on mocks, DB tests on PGlite.
- E2E on SimChain + mock Jupiter + mock pump + fake clock, including a 50 SOL hour in DRY RUN (paper accounting) and the live state machine against SimChain (in-memory, no network).
- Mainnet smoke test: written in `tests/smoke`, 0.1 SOL lifetime cap enforced in code. **Not run by agents.**

## 9. What Miguel does

- Animations against `packages/contract/mock/*.json`.
- Provide: Helius RPC URL (+ backup), Jupiter API key, Supabase project, Railway project, Telegram bot token + chat id, domain.
- Create fresh creator, fund and cold wallets. Import creator and fund with the CLI on the server. Back up `KEY_ENCRYPTION_KEY`.
- Verify the stock mints on xstocks.fi and set `approved: true` in `config/stocks.json`.
- Run the smoke test yourself (0.1 SOL + launch cost).
- Launch the coin on pump.fun in normal mode: no holder rewards, no fee sharing (either breaks our claims, VERIFIED [1][3]). Never click claim on pump.fun (the bot auto-handles it anyway).
- Review and merge the integration PR into `main`.

## 10. Launch-day checklist

See `STATUS.md` for exact commands.

- T-1 day: CI green, smoke report reviewed, stocks approved and mint-verified, worker + API deployed in DRY RUN, dry run rehearsal done and reset, key pool >= 2,000, keys imported, alerts tested, kill switch tested.
- T-1h: creator funded with 0.05 SOL reserve + launch cost, fund with 0.01 SOL, coin launched in normal mode, `COIN_MINT` set, still DRY RUN, claimable reads correctly.
- T-0: `DRY_RUN=false` + `LIVE_CONFIRM`. Watch the first claim, hire, burn on Solscan.
- T+1h: `rat status`, ledger vs wallets, failed tx count, key pool, Jupiter 429s. If in doubt: `rat kill`.

## Sources

1. pump.fun: [COLLECT_CREATOR_FEE.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md) VERIFIED
2. pump.fun: [COIN_CREATION.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md) VERIFIED (create_v2 mints are Token-2022, decimals 6)
3. pump.fun: [README](https://github.com/pump-fun/pump-public-docs) VERIFIED (sharing_config mandatory for buys/sells, holder rewards mode, `@pump-fun/pump-sdk`)
4. pump.fun IDLs: [idl/pump.json, idl/pump_amm.json](https://github.com/pump-fun/pump-public-docs/tree/main/idl) VERIFIED (program ids, discriminators, account order)
5. Jupiter: [price/index.mdx](https://github.com/jup-ag/docs/blob/main/price/index.mdx) VERIFIED
6. Jupiter: [swap/build/index.mdx](https://github.com/jup-ag/docs/blob/main/swap/build/index.mdx) VERIFIED
7. Jupiter: [pricing](https://developers.jup.ag/pricing) REPORTED (free tier 60 requests/min)
8. xStocks: [solana.com case study](https://solana.com/news/case-study-xstocks) REPORTED (Token-2022 extensions)
9. Token-2022 Pausable: [solana.com docs](https://solana.com/docs/tokens/extensions/pausable) REPORTED
10. xStocks mints: [kdai03/xpaper js/tokens.js](https://github.com/kdai03/xpaper) REPORTED (third party)
