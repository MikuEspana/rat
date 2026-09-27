# RAT RACE: Status

Built on 2026-09-27 in one session, workstream by workstream (WS01 to WS12), each on its own branch and PR, merged into the integration branch `claude/rat-race-planning-1qouxa`. The integration branch has one PR into `main`, left open for your review.

**Hard limits kept:**
- DRY RUN is on by default everywhere.
- No mainnet transaction was ever sent. No smoke test was run.
- Test keypairs only, no secrets in the repo.
- Nothing was created on Supabase, Railway or Vercel.
- No holder payout code (a CI guard forbids it).

## 1. What is built

| Area | Where | What it does |
|---|---|---|
| Foundation | `packages/core` | types, ports, config (DRY RUN default, live needs `LIVE_CONFIRM`), lamports math, redacting logger |
| Frontend contract | `packages/contract`, `CONTRACT.md` | zod schemas + display math (PnL, tier, rank, size) + mock JSON for your animations |
| Database | `packages/db` | 13 tables, migrations, ledger, paper vs live separation, lease lock |
| Keys | `packages/keys` | AES-256-GCM vault, vanity grinder, solana-keygen importer, key store |
| Chain | `packages/chain` | RPC reader, the only transaction sender, SimChain (in-memory Solana for tests) |
| pump.fun | `packages/pump` | claim instructions from the official IDL, external claim parser, burn, direct buy fallback |
| Jupiter | `packages/jupiter` | Price v3 (one batched call), Swap v2 `/build` (taker + payer), rate limiter, mocks |
| Safety | `packages/safety` | spend guard (ledger only, 30 SOL/h per bucket, alerts), kill switch, guarded sender, Telegram alerts, xStocks mint verifier |
| Operator CLI | `apps/cli` | status, kill/resume, key import/grind/rotate, ledger, dry-run reset, stocks sync, alert test, emergency sweep |
| The bot | `apps/worker` | prices, mint checks, claim + wallet watch + hire, buy + burn, reconcile, key pool; tick scheduler; single-worker lease |
| State API | `apps/api` | `/api/state`, `/api/rats`, `/api/events`, `/health` exactly per `CONTRACT.md` |
| Tests | `tests/` | e2e simulations (`SIMULATION.md`), smoke script (not run), runbook checks |
| Deploy | `infra/`, `docs/runbooks/` | Dockerfile, Railway config, read-only DB role, runbooks |

Your answers, as built:

| # | Decision | Built as |
|---|---|---|
| 1 | Cap 30 SOL/h per bucket, alert at 50% | `SPEND_CAP_SOL_PER_HOUR_HIRE` / `_BURN`. Burns use the room left under the cap instead of skipping. |
| 2 | Skip HOODx / CRCLx | Not in `config/stocks.json`. |
| 3 | 1-tx hire, 2-tx fallback flag | `HIRE_MODE=single` (default) / `two_step`, both tested. |
| 4 | Direct pump.fun buy fallback | `PumpDirectBuyBuilder` (official SDK), used when Jupiter has no route. |
| 5 | Coin token program at runtime | Read from the mint account owner. |
| 6 | Scaled UI vs price | Script `check:scaled-ui` ready. Current valuation: scaled amount x price (display only). |
| 7 | External claims | Our vault claimed by anyone: split 50/50 automatically (fund share rides in the next claim tx). Any other SOL: alert, never spent. A tx signed by our wallets that the bot did not send: kill switch. |
| 8 | Tier names | intern, analyst, associate, vp, partner. |
| 10 | Jupiter free tier, limit in config | `JUPITER_MAX_RPM=55`. |
| 11 | Emergency sweep | `rat sweep`, CLI only, exact typed phrase, never called by the bot. |
| 12 | Mint verification | Token-2022 + expected mint authority (config or majority of at least 3), else rejected. Runs at startup and every 35s. |
| 13 | No cloud resources | Config and runbooks only. |

## 2. Test results

**157 tests: 156 passed, 1 skipped (opt-in slow grind), 0 failed.** GitHub Actions CI (guards, typecheck, tests, Docker build + start) is green.

| Workstream | Tests | Highlights |
|---|---|---|
| WS01 core | 26 | DRY RUN default, live needs the exact phrase, secrets never logged, lamports exact |
| WS02 contract | 12 | mock files validate, display math, strict schemas (nothing extra leaks) |
| WS03 db | 12 | ledger exact to the lamport, paper/live isolation, unique key hand-out, lease lock |
| WS04 keys | 12 + 1 opt-in | encryption round trip, tamper/wrong key fail, case-sensitive suffix, no plaintext in DB/logs, rotation |
| WS05 chain | 17 | Token-2022 Pausable / Scaled UI / Permanent Delegate parsing, sender refuses without live confirm, expiry, SimChain |
| WS06 pump | 13 | discriminators, account order and PDA seeds match the official IDL, external claim parser |
| WS07 jupiter | 8 | never over 55 calls/min under 1,000 queued, 50-id batching, `/build` parsing |
| WS08 safety + CLI | 14 + 7 | ledger-only spending, exact per-bucket caps, one 50% alert, kill switch, mint verifier, sweep needs the typed phrase |
| WS09 worker | 17 | restart mid-hire never double funds, external claim split, unknown signed tx kills, paused/unverified stocks skipped, RPC lag never skips a signature |
| WS10 api | 4 | contract-exact responses, 6,000 rats (14ms cached), rate limit |
| WS11 e2e | 7 + 3 smoke preflight | see below |
| WS12 docs/infra | 4 | runbooks only reference real commands and env vars |

**The requested simulation** (DRY RUN, fake clock, mocked chain/price/swap, 50 SOL of fees in one hour; full tables in `SIMULATION.md`):

| Check | Result |
|---|---|
| Fees claimed | 50 SOL of 50, every lamport once |
| Hires | 833 rats, 24.99 SOL, less than one salary left over |
| Burns | 8 buy + burns, 24.999999974 SOL, burn budget fully used |
| Limits | max 16 hires per loop (limit 20), max 35 Jupiter calls per minute (limit 55) |
| Caps | 50% alert once per bucket, cap not reached |
| Transactions sent | 0 |

Other scenarios:
- **100 SOL hour**: both buckets stopped at exactly 30 SOL, alerts fired, 19.85 SOL carried over and was spent in hour 2.
- **Live execution on SimChain**: wallet balances equal the ledger to the lamport. Real cost per rat 0.02958 SOL.
- **12% random tx failures**: 0 double-funded rats, nothing left in flight, ledger exact.
- **Kill switch, paused stock, outside actors, 6,000 rats**: all pass.

## 3. Mocked vs real

| Piece | In tests | In production | Verified against real? |
|---|---|---|---|
| Solana | SimChain (real System/ATA/Token semantics) | `RpcChainReader` + `RpcTxSender` | Sender/reader unit-tested with fake connections. Never sent a real tx (by rule). |
| pump.fun claims | real instruction builders executed by SimChain handlers | same builders on mainnet | Builders match the official IDL. Not executed on mainnet. |
| Jupiter prices / swaps | `MockPriceSource`, `MockSwapBuilder` | Price v3 + Swap v2 `/build` | Request/response shapes from Jupiter's docs repo. Not called (no network, no key). |
| pump.fun direct buy | stubbed API | `@pump-fun/pump-sdk` | SDK loads; not executed. |
| Database | PGlite (in-process Postgres) | Supabase Postgres | Same migrations; Postgres itself not run here. |
| xStocks mints | synthetic mints | the 13 mints in `config/stocks.json` | Not checked on-chain (mainnet RPC blocked here). Run `check:stocks`. |
| Telegram | recorded alerts | Telegram Bot API | Not called. |
| Docker image | not built here (no daemon) | Railway | Built and started by the CI `docker` job. |

## 4. PRs, in merge order

| # | PR | Workstream |
|---|---|---|
| 1 | [MikuEspana/rat#13](https://github.com/MikuEspana/rat/pull/13) | WS01 Foundation |
| 2 | [MikuEspana/rat#14](https://github.com/MikuEspana/rat/pull/14) | WS02 Contract |
| 3 | [MikuEspana/rat#15](https://github.com/MikuEspana/rat/pull/15) | WS03 Database |
| 4 | [MikuEspana/rat#16](https://github.com/MikuEspana/rat/pull/16) | WS04 Keys (source was hidden by `.gitignore`, see #24) |
| 5 | [MikuEspana/rat#17](https://github.com/MikuEspana/rat/pull/17) | WS05 Chain |
| 6 | [MikuEspana/rat#18](https://github.com/MikuEspana/rat/pull/18) | WS06 Pump |
| 7 | [MikuEspana/rat#19](https://github.com/MikuEspana/rat/pull/19) | WS07 Jupiter |
| 8 | [MikuEspana/rat#20](https://github.com/MikuEspana/rat/pull/20) | WS08 Safety + CLI |
| 9 | [MikuEspana/rat#21](https://github.com/MikuEspana/rat/pull/21) | WS09 Worker |
| 10 | [MikuEspana/rat#22](https://github.com/MikuEspana/rat/pull/22) | WS10 API |
| 11 | [MikuEspana/rat#23](https://github.com/MikuEspana/rat/pull/23) | WS11 Tests + simulation |
| 12 | [MikuEspana/rat#24](https://github.com/MikuEspana/rat/pull/24) | WS04 fix: commit `packages/keys` |
| 13 | [MikuEspana/rat#25](https://github.com/MikuEspana/rat/pull/25) | WS12 Deploy |
| 14 | [MikuEspana/rat#26](https://github.com/MikuEspana/rat/pull/26) | WS09 fix: wallet watch never skips a signature during RPC lag |
| Final | [MikuEspana/rat#27](https://github.com/MikuEspana/rat/pull/27) | integration branch into `main` (**open, for you to review and merge**) |

Issues #1 to #12 close when the final PR merges into `main`.

## 5. What you need to provide

| Item | Where it goes |
|---|---|
| Helius (or similar) mainnet RPC URL + a backup | `RPC_URL`, `RPC_URL_BACKUP` |
| Jupiter API key (free, portal.jup.ag) | `JUPITER_API_KEY` |
| Supabase project (direct connection + read-only user) | `DATABASE_URL`, `DATABASE_URL_READONLY` |
| Railway project (2 services) and Vercel (your site) | see `docs/runbooks/deploy.md` |
| Telegram bot token + chat id | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Master key (32 random bytes, base64), backed up | `KEY_ENCRYPTION_KEY` |
| Fresh creator, fund and cold wallets | `CREATOR_PUBKEY`, `FUND_PUBKEY`; import keys with `rat keys import` |
| 3,000 pre-ground `RAT` keys | `solana-keygen grind --ends-with RAT:3000` then `rat keys import-dir` |
| Stock approvals | verify mints on xstocks.fi, set `approved: true` in `config/stocks.json` |
| Optional: confirmed xStocks mint authority | `XSTOCKS_MINT_AUTHORITY` |
| Funding | creator: 0.05 SOL reserve + launch cost; fund: 0.01 SOL; smoke test: ~0.12 SOL on throwaway wallets |
| Decisions left | `OPEN-QUESTIONS.md` |

## 6. Go live, step by step

Details in `docs/runbooks/go-live.md`.

1. Review and merge the integration PR into `main`.
2. Set up Supabase, Railway and Vercel with `docs/runbooks/deploy.md`. Keep `DRY_RUN=true`.
3. Import keys and fill the key pool: `docs/runbooks/keys.md`.
4. `pnpm --filter @rat/jupiter check:stocks` and `check:scaled-ui`. Approve stocks, then `rat stocks-sync`.
5. Run the smoke test on a throwaway coin: `tests/smoke/README.md`. Read `tests/smoke/REPORT.md`. If the 1-tx hire failed, set `HIRE_MODE=two_step`.
6. Rehearse in DRY RUN with `DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR=20` for 30 minutes, then set it back to `0` and run `rat dry-run-reset --yes`.
7. `rat alert-test`, then test `rat kill` / `rat resume`.
8. Launch the coin on pump.fun from the creator wallet: normal mode, **no holder rewards, no fee sharing**. Set `COIN_MINT`, redeploy (still DRY RUN), check the site.
9. Go live: `DRY_RUN=false` and `LIVE_CONFIRM=I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS` on the worker, `DRY_RUN=false` on the API. Watch the first claim, hires and burn on Solscan.
10. First hour: `rat status`. Any doubt: `rat kill`.

## 7. Sources for external behavior

| Claim | Tag | Source |
|---|---|---|
| Claim instructions `collect_creator_fee_v2` / `collect_coin_creator_fee`, account order, PDA seeds, program ids, discriminators | VERIFIED | [pump-public-docs COLLECT_CREATOR_FEE.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md), [idl/pump.json, idl/pump_amm.json](https://github.com/pump-fun/pump-public-docs/tree/main/idl) |
| Creator vault is per creator wallet, claims are permissionless, bonding claims pay native SOL, AMM claims pay WSOL | VERIFIED | same doc |
| Fee sharing breaks direct claims | VERIFIED | [CREATOR_FEE_SHARING.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md) |
| `create_v2` coins are Token-2022 with 6 decimals | VERIFIED | [COIN_CREATION.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md) |
| Holder rewards mode exists; `sharing_config` mandatory for buys; `@pump-fun/pump-sdk` | VERIFIED | [pump-public-docs README](https://github.com/pump-fun/pump-public-docs) |
| `@pump-fun/pump-sdk@2.0.0` ESM build does not import under Node (loaded via CommonJS) | VERIFIED | reproduced in this repo (`packages/pump`) |
| Creator fee rates (0.05% to 0.95% by market cap) | UNCLEAR | [soltokencreator.io](https://www.soltokencreator.io/blog/pump-fun-fees-explained), [smithii.io](https://smithii.io/en/project-ascend-update/). Irrelevant to the code: all math uses what is actually claimed |
| PumpSwap claim works for SOL-quoted pools with WSOL | VERIFIED (docs) / UNCLEAR (mainnet) | COLLECT_CREATOR_FEE.md; to be proven by the smoke test after graduation |
| Price v3: `api.jup.ag/price/v3`, `x-api-key`, max 50 ids, `priceChange24h` in %, unreliable tokens omitted | VERIFIED | [jup-ag/docs price/index.mdx](https://github.com/jup-ag/docs/blob/main/price/index.mdx) |
| Swap v2 `/build`: quote + instructions in one call, `taker`, `payer`, lookup tables, no price impact field | VERIFIED | [jup-ag/docs swap/build/index.mdx](https://github.com/jup-ag/docs/blob/main/swap/build/index.mdx) |
| Free tier 60 req/min, 60s sliding window, per organisation, `x-ratelimit-reset` | VERIFIED | [jup-ag/docs portal/rate-limits.mdx](https://github.com/jup-ag/docs/blob/main/portal/rate-limits.mdx) |
| `/build` works with an unfunded taker + `payer` in one tx | UNCLEAR | smoke test decides (fallback: `HIRE_MODE=two_step`) |
| Jupiter routes pump.fun bonding curve buys | UNCLEAR | direct pump.fun buy fallback built |
| xStocks are Token-2022 with PermanentDelegate, Pausable, Scaled UI Amount, transfer hook disabled | REPORTED | [solana.com xStocks case study](https://solana.com/news/case-study-xstocks) |
| Pausable blocks transfers, mints and burns | REPORTED | [solana.com Pausable docs](https://solana.com/docs/tokens/extensions/pausable); parsing VERIFIED against `@solana/spl-token` layouts |
| xStocks mint addresses | REPORTED | [kdai03/xpaper js/tokens.js](https://github.com/kdai03/xpaper) (third party); verify on xstocks.fi |
| Whether `usdPrice` is per scaled UI unit | UNCLEAR | `check:scaled-ui` script |

## 8. Problems found and fixed along the way

| Found by | Problem | Fix |
|---|---|---|
| CI | `.gitignore` rule `keys/` hid `packages/keys`: WS04's source was never committed | anchored the rule to the repo root, committed the package ([#24](https://github.com/MikuEspana/rat/pull/24)) |
| fresh clone | a test that ground a real `RAT` key could exceed 60s under load | deterministic 2-character suffix tests; the real grind is opt-in |
| worker tests | the burn paid its tx fee from the fund wallet's own SOL (bucket went negative) | the burn swaps the bucket minus the overhead allowance |
| worker tests | on a wallet with no history, the first external claim was skipped | empty-history cursor marker |
| simulation B | a burn that would cross the cap was skipped entirely | burns use the room left under the cap and alert |
| final review | RPC indexing lag could make the wallet watch skip a signature forever | the cursor only advances when every signature was examined ([#26](https://github.com/MikuEspana/rat/pull/26)) |
| pump SDK | `@pump-fun/pump-sdk` ESM build does not import under Node | loaded lazily through its CommonJS build |

## 9. Important while live

- Never send a transaction from the creator or fund wallet yourself while the bot is live: it trips the kill switch (a transaction signed by a bot wallet that the bot did not send looks like a key leak). Sending SOL to them is fine.
- The fund's buy + burn is the only way profits leave. There is no code path that pays holders.
