# RAT RACE: Status

Updated 2026-09-28. Everything is in `main`: the backend (queue Q1 to Q12, log in `LOG.md`, [MikuEspana/rat#27](https://github.com/MikuEspana/rat/pull/27)), the pixel site and the in-browser launch simulator (live demo: https://theinuvestors.world). **Economics (owner decisions after legal advice): every claimed fee hires rats, and the rats hold their stocks forever. Buy and burn was removed completely on 2026-09-28 (no fund wallet, no coin buys, no burns). No dividends, no holder payouts. Hiring: at most 20 rats per 35 s loop and 60 SOL per hour.**

**Hard limits kept:**
- DRY RUN is on by default everywhere.
- No mainnet transaction was ever sent, Jito was never called (the Jito route is now removed), no smoke test was run.
- Test keypairs only, no secrets in the repo.
- Nothing was created on Railway, Vercel or any bucket provider (Supabase is no longer used).
- No holder payout code (a CI guard forbids it).
- No em dashes.

## 1. The queue

| Item | PR | Result | Anything Miguel must do |
|---|---|---|---|
| Q1 Remove vanity keys | [#34](https://github.com/MikuEspana/rat/pull/34) | Done. Every rat gets a fresh keypair, stored encrypted and read back before any SOL is sent. Grinder, key pool and `solana-keygen` removed. | Nothing. |
| Q2 Red-team every money path | [#35](https://github.com/MikuEspana/rat/pull/35) | 14 bugs fixed (3 High). A compromised Jupiter can no longer drain a wallet (every live tx is simulated and checked first); an RPC failure no longer re-credits spent money; crash windows, double claims, two workers, watcher blind spots closed. `SECURITY-REVIEW.md`. | Read the accepted risks (A1 to A6). Do the dev buy from a separate wallet. |
| Q3 Property tests | [#36](https://github.com/MikuEspana/rat/pull/36) | "SOL spent never exceeds SOL claimed, to the lamport" holds over 650+ random guard scenarios and 12 random live launches per run. 1 bug fixed (the fund could burn its own SOL). 5 deliberately broken guards all caught. | Nothing. |
| Q4 Chaos tests | [#37](https://github.com/MikuEspana/rat/pull/37) | Worker killed before each of 172 operations of a hire and a burn, RPC down at 29 points, database dropped at 138 points, a 20 minute Jupiter 429 storm: every lamport accounted for. 3 bugs fixed (1 High). | Nothing. |
| Q5 3-hour launch simulation | [#38](https://github.com/MikuEspana/rat/pull/38), defaults in [#46](https://github.com/MikuEspana/rat/pull/46) | 180 SOL of fees, 3,042 rats, all money spent, ledger = chain. Unpaced settings stopped hiring for 30 min (twice) and burning for 39 min. Your decision: `MAX_HIRES_PER_LOOP=10` and `BURN_ROUND_MAX_SOL=5` are now the defaults. | Nothing. |
| Q6 `rat preflight` | [#39](https://github.com/MikuEspana/rat/pull/39) | PASS / WARN / FAIL for every launch check, `--live` mode, exit code 1 on FAIL. | Run `rat preflight --live` right before going live. |
| Q7 LAUNCH-DAY.md | [#40](https://github.com/MikuEspana/rat/pull/40) | The short launch-day checklist. | Read it the night before. |
| Q8 Private admin page | [#41](https://github.com/MikuEspana/rat/pull/41) | Money, caps used, last txs, errors, worker loops, KILL / Resume (the CLI's own logic), hardened login. | Deploy the admin service with `ADMIN_PASSWORD` (16+ characters) and the Telegram settings. |
| Q9 Site shell | none | Skipped by you: the site is built in `apps/pixel-site` (never touched here). | Tell that session: `/api/rats` is 1.7 MB (410 KB gzipped) at 3,000 rats, fetch it once, then follow events (`CONTRACT.md`). |
| Q10 Site deploy docs | none | Skipped by you (Tier 3). | Nothing here. |
| Q11 Cleanup | [#42](https://github.com/MikuEspana/rat/pull/42) | Unused dependencies and exports, duplicate tests, stale numbers removed. | Nothing. |
| Q12 Launch-risk reduction | [#43](https://github.com/MikuEspana/rat/pull/43) | Worker-down watchdog, `rat keys backup` / `restore`, preflight checks every rat key decrypts, secrets redacted from alerts and stored errors. | Back up the rat keys during and after the launch; keep the file apart from `KEY_ENCRYPTION_KEY`. |
| Final STATUS | this PR | This file. | Review and merge [#27](https://github.com/MikuEspana/rat/pull/27) into `main`. |

## 2. Top 5 risks left

| # | Risk | Why it is still there | What limits it / what to do |
|---|---|---|---|
| 1 | **Nothing has run on mainnet yet.** Jupiter routes into xStocks, the 1-tx hire with a `payer`, pump.fun claims after graduation, real fees and rent. | By rule, no mainnet transaction was sent. Everything is proven on SimChain and against official docs only. | Run the smoke test (`tests/smoke`, 0.1 SOL cap) before launch. If the 1-tx hire fails there: `HIRE_MODE=two_step`. The effects check refuses any tx that would cost more than reserved. |
| 2 | **Outside parties can cost value inside our limits.** A wrong Jupiter quote or price; the xStocks issuer can pause, freeze or take back tokens (permanent delegate). | We cannot control them. | Worst case per tx: one salary (0.03 SOL). The 60 SOL/h hire cap stops a long bleed. Reconcile freezes and alerts on issuer actions. |
| 3 | **One worker, one database, one RPC.** | A small project on one host. | Restarts are safe at every step (chaos tests), the watchdog alerts if the worker dies, a backup RPC is supported. Losing the database without a key backup loses every rat wallet: turn on Railway backups and the nightly encrypted offsite dump (`docs/runbooks/backup-restore.md`), and run `rat keys backup`. |
| 4 | **Launch-day operator mistakes.** A tx from a bot wallet (trips the kill switch), a wrong `WATCH_FROM_SLOT`, DRY RUN flipped back and forth, the dev buy left in the creator wallet. | People get tired. | `rat preflight --live`, `LAUNCH-DAY.md`, the admin page. Every mistake above stops the bot instead of losing money. |
| 5 | **A bigger or faster launch than planned.** | The 60 SOL/h hire cap makes money wait during a big rush (180 SOL of fees takes about 3 hours to spend). We stay on Jupiter's Free tier: a hard budget of 40 calls a minute (prices + builds + retries) caps hiring at about 38 rats a minute (about 57 SOL/h in a long rush, a little under the 60 SOL/h cap). In the 3-hour simulation every fee was still spent by minute 189. | Nothing is lost, only delayed: hires wait in line for the next loop. A 429 backs off and alerts. |

## 3. Now

- **Tests**: 249 in the main suite (guards, typecheck, unit, e2e, property), plus the long suite (16 chaos tests running about 500 kill / outage scenarios, and the 3-hour launch simulation twice). All green in CI.
- **Money-path review**: 18 findings fixed (RT-01 to RT-18: 4 High, 8 Medium, 6 Low), accepted risks listed. `SECURITY-REVIEW.md`.
- **Docs**: `LAUNCH-DAY.md` (short), `docs/runbooks/go-live.md` (full), `SECURITY-REVIEW.md`, `SIMULATION.md`, `LOG.md` (every item), `CONTRACT.md` (for the site).

## 4. What is built

| Area | Where | What it does |
|---|---|---|
| Foundation | `packages/core` | types, ports, config (DRY RUN default, live needs `LIVE_CONFIRM`), lamports math, redacting logger |
| Frontend contract | `packages/contract`, `CONTRACT.md` | zod schemas + display math (PnL, tier, rank, size) + mock JSON for your animations |
| Database | `packages/db` | 12 tables, migrations, ledger, paper vs live separation, lease lock |
| Keys | `packages/keys` | AES-256-GCM vault; key store: every rat gets a fresh keypair at hire time, encrypted, stored and read back before any SOL is sent; creator key import |
| Chain | `packages/chain` | RPC reader, the only transaction sender, SimChain (in-memory Solana for tests) |
| pump.fun | `packages/pump` | claim instructions from the official IDL, external claim parser |
| Jupiter | `packages/jupiter` | Price v3 (one batched call), Swap v2 `/build` (taker + payer), rate limiter, mocks |
| Safety | `packages/safety` | spend guard (ledger only, one hire bucket, 60 SOL/h, exactly-once settle), kill switch, guarded sender (effects check before every live send, lease fence), Telegram alerts (secrets redacted), xStocks mint verifier |
| Operator CLI | `apps/cli` | status, **preflight** (PASS / WARN / FAIL launch checklist), kill/resume, key import/rotate/**backup/restore**, ledger, dry-run reset, stocks sync, alert test, emergency sweep |
| Admin page | `apps/admin` | private page: money, caps used, last transactions, errors, worker loops, KILL / Resume; worker-down watchdog (Telegram) |
| The bot | `apps/worker` | prices, mint checks, claim + wallet watch + hire (every claimed lamport hires rats, at most 20 per loop and 60 SOL/h), reconcile; tick scheduler; single-worker lease. No buy and burn. |
| State API | `apps/api` | `/api/state`, `/api/rats`, `/api/events`, `/health` exactly per `CONTRACT.md` |
| Live mock API | `apps/api/src/mock`, `pnpm mock:api` | the same 4 endpoints with live-changing mock data (hires, price drift, tier changes, claims, a stock pausing and resuming) for building the site |
| Tests | `tests/` | e2e + property tests, chaos suite (`tests/chaos`), 3-hour launch simulation (`tests/sim`, `SIMULATION.md`), smoke script (not run), docs checks |
| Deploy | `infra/`, `docs/runbooks/`, `LAUNCH-DAY.md` | Dockerfile, Railway config (worker, api, admin), read-only DB role, runbooks, launch-day checklist |


## 5. Your decisions and how they are built

| # | Decision | Built as |
|---|---|---|
| 1 | Cap 30 SOL/h per bucket, alert at 50%; raised to 60 SOL/h for hires on 2026-09-28 (every fee hires) | `SPEND_CAP_SOL_PER_HOUR_HIRE=60`, `MAX_HIRES_PER_LOOP=20`. The only bucket left is hires. |
| 2 | Skip HOODx / CRCLx | Not in `config/stocks.json`. |
| 3 | 1-tx hire, 2-tx fallback flag | `HIRE_MODE=single` (default) / `two_step`, both tested. |
| 4 | Direct pump.fun buy fallback | Removed with buy and burn (2026-09-28). |
| 5 | Coin token program at runtime | Read from the mint account owner. |
| 6 | Scaled UI vs price | Script `check:scaled-ui` ready. Current valuation: scaled amount x price (display only). |
| 7 | External claims | Our vault claimed by anyone: booked to hires like our own claims. Any other SOL: alert, never spent. A tx signed by our wallets that the bot did not send: kill switch, except before `WATCH_FROM_SLOT` (the coin launch) or listed in `KNOWN_OWNER_TX_SIGS`. |
| 8 | Tier names | intern, analyst, associate, vp, partner. |
| 10 | Jupiter free tier, limit in config; stay on Free (2026-09-28) | `JUPITER_MAX_RPM=40`, a hard maximum: one shared budget for every worker call (prices every 45 s + one build per hire + retries). Hires wait when it is used up; a 429 backs off 5 s doubling to 5 min and alerts. |
| 11 | Emergency sweep | `rat sweep`, CLI only, exact typed phrase, never called by the bot. |
| 12 | Mint verification | Token-2022 + expected mint authority (config or majority of at least 3), else rejected. Runs at startup and every 35s. |
| review | Live readiness | The worker refuses to start LIVE with 0 approved stocks or none passing the mint check (exact reasons in the logs + Telegram). `hire_idle` alert when no rat is hired for 30 min while more than 0.1 SOL waits. |
| 13 | No cloud resources | Config and runbooks only. |

## 6. Mocked vs real

| Piece | In tests | In production | Verified against real? |
|---|---|---|---|
| Solana | SimChain (real System/ATA/Token semantics) | `RpcChainReader` + `RpcTxSender` | Sender/reader unit-tested with fake connections. Never sent a real tx (by rule). |
| pump.fun claims | real instruction builders executed by SimChain handlers | same builders on mainnet | Builders match the official IDL. Not executed on mainnet. |
| Jupiter prices / swaps | `MockPriceSource`, `MockSwapBuilder` | Price v3 + Swap v2 `/build` | Request/response shapes from Jupiter's docs repo. Not called (no network, no key). |
| Database | PGlite (in-process Postgres) | Railway Postgres 18 (`${{Postgres.DATABASE_URL}}` reference) | Same migrations. The backup self-test runs them on a real Postgres 18, then dumps, encrypts, uploads (local S3 server), restores and compares every table (CI `backup` job). |
| xStocks mints | synthetic mints | the 13 mints in `config/stocks.json` | Not checked on-chain (mainnet RPC blocked here). Run `check:stocks`. |
| Telegram | recorded alerts | Telegram Bot API | Not called. |
| Docker image | not built here (no daemon) | Railway | Built and started by the CI `docker` job. |
| Live mock API | n/a | `pnpm mock:api` for the site | It is a mock: exaggerated prices, random wallets and signatures. |

## 7. PRs, in merge order

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
| 15 | [MikuEspana/rat#28](https://github.com/MikuEspana/rat/pull/28) | Review fix 1: key pool sized for launch day |
| 16 | [MikuEspana/rat#29](https://github.com/MikuEspana/rat/pull/29) | Review fix 2: burns vs MEV |
| 17 | [MikuEspana/rat#30](https://github.com/MikuEspana/rat/pull/30) | Review fix 3: coin launch vs the kill switch |
| 18 | [MikuEspana/rat#31](https://github.com/MikuEspana/rat/pull/31) | Review fix 4: live readiness (preflight, idle alert) |
| 19 | [MikuEspana/rat#32](https://github.com/MikuEspana/rat/pull/32) | Review fix 5: live mock API |
| 20 | [MikuEspana/rat#33](https://github.com/MikuEspana/rat/pull/33) | This STATUS update |
| 21 | [MikuEspana/rat#34](https://github.com/MikuEspana/rat/pull/34) | Q1 Fresh keypair per rat (no vanity keys) |
| 22 | [MikuEspana/rat#35](https://github.com/MikuEspana/rat/pull/35) | Q2 Red-team every money path |
| 23 | [MikuEspana/rat#36](https://github.com/MikuEspana/rat/pull/36) | Q3 Property tests |
| 24 | [MikuEspana/rat#37](https://github.com/MikuEspana/rat/pull/37) | Q4 Chaos tests |
| 25 | [MikuEspana/rat#38](https://github.com/MikuEspana/rat/pull/38) | Q5 3-hour launch simulation |
| 26 | [MikuEspana/rat#39](https://github.com/MikuEspana/rat/pull/39) | Q6 `rat preflight` |
| 27 | [MikuEspana/rat#40](https://github.com/MikuEspana/rat/pull/40) | Q7 LAUNCH-DAY.md |
| 28 | [MikuEspana/rat#41](https://github.com/MikuEspana/rat/pull/41) | Q8 Admin page |
| 29 | [MikuEspana/rat#42](https://github.com/MikuEspana/rat/pull/42) | Q11 Cleanup |
| 30 | [MikuEspana/rat#43](https://github.com/MikuEspana/rat/pull/43) | Q12 Launch-risk reduction |
| 31 | this PR | Final STATUS |
| Final | [MikuEspana/rat#27](https://github.com/MikuEspana/rat/pull/27) | integration branch into `main` (**open, for you to review and merge**) |

Issues #1 to #12 close when the final PR merges into `main`.

## 8. What you need to provide

| Item | Where it goes |
|---|---|
| Helius (or similar) mainnet RPC URL + a backup | `RPC_URL`, `RPC_URL_BACKUP` |
| Jupiter API key (free, portal.jup.ag) | `JUPITER_API_KEY` |
| Railway Postgres in the same project (references, no copied password) + read-only user | `DATABASE_URL`, `DATABASE_URL_READONLY` (`docs/runbooks/deploy.md` step 1) |
| Railway project (services: worker, api, admin, backup, Postgres) | see `docs/runbooks/deploy.md` |
| Admin page password (at least 16 characters) | `ADMIN_PASSWORD` on the admin service (plus the Telegram settings for its watchdog) |
| Railway backups on, the nightly encrypted dump to a bucket outside Railway (age key pair, bucket key), one restore drill, plus `rat keys backup` files kept apart from the master key | `docs/runbooks/backup-restore.md`; the rat wallets' keys exist only in the database |
| Telegram bot token + chat id | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Master key (32 random bytes, base64), backed up | `KEY_ENCRYPTION_KEY` |
| Fresh creator and cold wallets | `CREATOR_PUBKEY`; import the creator key with `rat keys import --role creator` |
| Stock approvals | verify mints on xstocks.fi, set `approved: true` in `config/stocks.json` |
| Optional: confirmed xStocks mint authority | `XSTOCKS_MINT_AUTHORITY` |
| Funding | creator: 0.05 SOL reserve + launch cost; smoke test: ~0.1 SOL on a throwaway wallet |
| At launch: the launch transaction's signature and slot | `WATCH_FROM_SLOT` (slot + 1), `KNOWN_OWNER_TX_SIGS` |
| Jupiter plan for launch day | **Free** is enough: the worker never makes more than 40 calls in any minute (hard budget), leaving 20 of the Free tier's 60 for your own checks (`SIMULATION.md`) |
| Launch pacing | on by default: `MAX_HIRES_PER_LOOP=20`, `SPEND_CAP_SOL_PER_HOUR_HIRE=60` (`SIMULATION.md`) |
| Decisions left | `OPEN-QUESTIONS.md` |

## 9. Sources for external behavior

| Claim | Tag | Source |
|---|---|---|
| Claim instructions `collect_creator_fee_v2` / `collect_coin_creator_fee`, account order, PDA seeds, program ids, discriminators | VERIFIED | [pump-public-docs COLLECT_CREATOR_FEE.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md), [idl/pump.json, idl/pump_amm.json](https://github.com/pump-fun/pump-public-docs/tree/main/idl) |
| Creator vault is per creator wallet, claims are permissionless, bonding claims pay native SOL, AMM claims pay WSOL | VERIFIED | same doc |
| Fee sharing breaks direct claims | VERIFIED | [CREATOR_FEE_SHARING.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md) |
| `create_v2` coins are Token-2022 with 6 decimals | VERIFIED | [COIN_CREATION.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md) |
| Holder rewards mode exists | VERIFIED | [pump-public-docs README](https://github.com/pump-fun/pump-public-docs) |
| Creator fee rates (0.05% to 0.95% by market cap) | UNCLEAR | [soltokencreator.io](https://www.soltokencreator.io/blog/pump-fun-fees-explained), [smithii.io](https://smithii.io/en/project-ascend-update/). Irrelevant to the code: all math uses what is actually claimed |
| PumpSwap claim works for SOL-quoted pools with WSOL | VERIFIED (docs) / UNCLEAR (mainnet) | COLLECT_CREATOR_FEE.md; to be proven by the smoke test after graduation |
| Price v3: `api.jup.ag/price/v3`, `x-api-key`, max 50 ids, `priceChange24h` in %, unreliable tokens omitted | VERIFIED | [jup-ag/docs price/index.mdx](https://github.com/jup-ag/docs/blob/main/price/index.mdx) |
| Swap v2 `/build`: quote + instructions in one call, `taker`, `payer`, lookup tables, no price impact field | VERIFIED | [jup-ag/docs swap/build/index.mdx](https://github.com/jup-ag/docs/blob/main/swap/build/index.mdx) |
| Tiers: Keyless 0.5 RPS, Free 1 RPS (60/min), Developer 10 RPS ($25/month), Launch 50 RPS ($100), Pro 150 RPS ($500); 60s sliding window, per organisation; Swap, Price and Token requests share one bucket; `x-ratelimit-reset` | VERIFIED (2026-09-21 docs) | [jup-ag/docs portal/rate-limits.mdx](https://github.com/jup-ag/docs/blob/main/portal/rate-limits.mdx), [portal/plans.mdx](https://github.com/jup-ag/docs/blob/main/portal/plans.mdx) |
| `/build` works with an unfunded taker + `payer` in one tx | UNCLEAR | smoke test decides (fallback: `HIRE_MODE=two_step`) |
| xStocks are Token-2022 with PermanentDelegate, Pausable, Scaled UI Amount, transfer hook disabled | REPORTED | [solana.com xStocks case study](https://solana.com/news/case-study-xstocks) |
| Pausable blocks transfers, mints and burns | REPORTED | [solana.com Pausable docs](https://solana.com/docs/tokens/extensions/pausable); parsing VERIFIED against `@solana/spl-token` layouts |
| xStocks mint addresses | REPORTED | [kdai03/xpaper js/tokens.js](https://github.com/kdai03/xpaper) (third party); verify on xstocks.fi |
| Whether `usdPrice` is per scaled UI unit | UNCLEAR | `check:scaled-ui` script |
| `simulateTransaction` with `accounts` returns post-simulation account state; `minContextSlot` | VERIFIED | [solana.com simulateTransaction](https://solana.com/docs/rpc/http/simulatetransaction) |
| `getSignaturesForAddress`: newest first, max 1,000 per call, `before` / `until` paging | VERIFIED | [solana.com getSignaturesForAddress](https://solana.com/docs/rpc/http/getsignaturesforaddress) |
| Token account layout: amount (u64) at byte 64 | VERIFIED | `AccountLayout` in `@solana/spl-token` ([solana-program/token](https://github.com/solana-program/token)) |
| `otherAmountThreshold` = minimum output after `slippageBps` on `outAmount` | VERIFIED | [jup-ag/docs swap/v1/get-quote.mdx](https://github.com/jup-ag/docs/blob/main/swap/v1/get-quote.mdx) |
| `x-ratelimit-reset` is an absolute Unix time in seconds | VERIFIED | [jup-ag/docs portal/rate-limits.mdx](https://github.com/jup-ag/docs/blob/main/portal/rate-limits.mdx) |
| With an integrator `payer`, the temporary WSOL account rent is paid by and returned to the payer | REPORTED | [jup-ag/docs ultra/gasless.mdx](https://github.com/jup-ag/docs/blob/main/ultra/gasless.mdx) (stated for Ultra; the effects check enforces the salary limit either way) |
| Creator fee rate depends on the coin's market cap tier, set on-chain | VERIFIED (mechanism) / UNCLEAR (values) | [pump-public-docs FEE_PROGRAM_README.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_PROGRAM_README.md) |

## 10. Problems found and fixed along the way

| Found by | Problem | Fix |
|---|---|---|
| CI | `.gitignore` rule `keys/` hid `packages/keys`: WS04's source was never committed | anchored the rule to the repo root, committed the package ([#24](https://github.com/MikuEspana/rat/pull/24)) |
| worker tests | the burn paid its tx fee from the fund wallet's own SOL (bucket went negative) | the burn swaps the bucket minus the overhead allowance |
| worker tests | on a wallet with no history, the first external claim was skipped | empty-history cursor marker |
| simulation B | a burn that would cross the cap was skipped entirely | burns use the room left under the cap and alert |
| final review | RPC indexing lag could make the wallet watch skip a signature forever | the cursor only advances when every signature was examined ([#26](https://github.com/MikuEspana/rat/pull/26)) |
| pump SDK | `@pump-fun/pump-sdk` ESM build does not import under Node | loaded lazily through its CommonJS build |
| review fix 1 (CI) | `solana-keygen` was not in the Docker image, and once added it ground `RAT` keys ~3x slower than the built-in grinder (it skips 44-character addresses, Agave `keygen.rs` `skip_len_44_pubkeys`) | later made moot: vanity keys were dropped (fresh keypair per hire), `solana-keygen` removed from the image |
| review fix 2 | publishing the exact next burn time in `/api/state` would undo the random timing | `nextBurnAt` is now only the earliest possible start |
| review fix 2 (resilience test) | a rat can legitimately wait in `hiring` when its only attempt was rejected before broadcast and the budget is under one salary; the old test only passed by luck of the random path | the test now checks the real invariant: nothing can still land, no reservation held |
| autonomous run (Q2 to Q4) | 18 findings on the money paths (RT-01 to RT-18: 4 High, 8 Medium, 6 Low) | all fixed with tests: `SECURITY-REVIEW.md` |
| Q5 simulation | unpaced settings pause hiring 30 min and burns 39 min at launch | `MAX_HIRES_PER_LOOP=10`, `BURN_ROUND_MAX_SOL=5` made the defaults ([#46](https://github.com/MikuEspana/rat/pull/46)) |
| Q12 | a dead worker is silent; rat keys exist only in the database; secrets could ride in error texts | watchdog, key backup/restore, preflight key check, redaction |
| all fees to rats | `HIRE_SPLIT_BPS` was applied as the FUND's share in the claim step (the name, the docs and the simulator all mean the hires' share). At 50/50 the two are the same, so no test saw it; setting 100% for hires would have sent every fee to burns | `fundShareOf()` in `@rat/core` (the complement of the split) in all four places, with tests; default now 10000: every fee hires rats, burns off |

## 11. Important while live

- Never send a transaction from the creator or fund wallet yourself while the bot is live: it trips the kill switch (a transaction signed by a bot wallet that the bot did not send looks like a key leak). Sending SOL to them is fine. If you must: `rat kill`, send it, add its signature to `KNOWN_OWNER_TX_SIGS`, redeploy, `rat resume`.
- Profits never leave to holders: every fee hires rats and the fund holds (burns are off by default). There is no code path that pays holders.
