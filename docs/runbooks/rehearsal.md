# The mainnet rehearsal

A small, real run of the bot on mainnet before launch day, in its own Railway project with a test creator and a test coin. It proves, with real transactions:
- the fee claim;
- hires into real xStocks;
- the hourly cap;
- a crash in the middle of a hire;
- the kill switch and the watchdog;
- the site;
- the backup.

Every phase ends with PASS or FAIL. **Any FAIL means NO-GO:** fix it, pass CI, run that phase again.

## Rules that never change
- **Separate from production:**
  - its own Railway project (`wall-street-rats-staging`), folder (`~/wallstreetrats-staging`), secrets (`~/rat-secrets-staging`), master key, Postgres and R2 bucket;
  - the scripts refuse the production project, creator wallet (`4VYW...Kiot`) and master key.
- **Test-only features only work in staging:**
  - `STAGING=true` is set only by `scripts/setup-staging.sh` and `scripts/staging.sh` (`scripts/check-guards.mjs`);
  - the config refuses it next to the production creator;
  - the seed, the crash test and `stageSol` also need a database marked by `rat staging-init`.
- **Every mainnet transaction waits for you:**
  - the staging worker runs with its kill switch ON;
  - a phase shows what will be sent and how much SOL, then waits until you type `GO`;
  - it turns the switch off only for that phase, and back on at the end, also on a FAIL or Ctrl-C.
- **The public claimed figure never includes seeded SOL.**
- **No link to the real launch:**
  - fund the test creator from a wallet unrelated to the real launch;
  - name the coin `TEST DO NOT BUY`, with no socials;
  - sweep to a throwaway wallet (never `DX7R...`).

## SOL
- **Test creator:** 0.47 SOL.
- **Your trading wallet:** 0.1 SOL for phase 2, used temporarily.
- **Net cost:** about 0.04 to 0.05 SOL (launch cost, fees, swap spreads).
- **Back at teardown:** about 0.42 SOL.

## What you run, in order
| # | Command | What happens | PASS |
|---|---|---|---|
| Setup | `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/MikuEspana/rat/main/scripts/setup-staging.sh)"` | Asks for the test creator's public address (a NEW Phantom account), makes the throwaway wallet, then the whole setup with the staging profile: `STAGING=true`, `MIN_CLAIM_SOL=0.0003`, DRY RUN, database marked, kill switch ON | The green checklist |
| Stocks | `~/wallstreetrats-staging/scripts/approve-stocks.sh` | For each enabled xStock: its mint, xstocks.fi opens, you confirm it matches. Sets `APPROVED_STOCKS`, redeploys, `rat stocks-sync` | The preflight stocks line PASS (on-chain mint check) |
| 0 | `scripts/staging.sh check` | Isolation checks | Not production, test creator, own master key, STAGING on |
| 1 | `scripts/staging.sh 1` | GO, then YOU launch the coin in Phantom (0.1 SOL dev buy). Exactly the launch-day steps (`scripts/lib/launch.sh`, as `scripts/launch.sh`): the script finds the launch, checks `rat preflight --live` with the coin's settings before anything changes, then sets every launch setting in one change and redeploys the worker and the API once, side by side: LIVE with the kill switch ON. Do phase 2's trades during that build | `launch txs` and `dev buy` PASS; `preflight --live` READY except the kill switch; 0 claims |
| 2 | `scripts/staging.sh 2` | You trade 2 x 0.05 SOL from your trading wallet; GO; the bot claims | `rat audit`: each claim equals what left the fee vaults, to the lamport |
| 3 | `scripts/staging.sh 3` | GO: seed 0.165 SOL, 5 hires at 0.03 SOL | Audit PASS (each rat paid once, holds what the database says, creator SOL equals the ledger); the API's claimed figure excludes the seed; `stageSol` is claimed plus seeded |
| 4 and 5 | `scripts/staging.sh 4` | GO: salary 0.01, a small hourly cap, seed 0.125. The worker kills itself right after hire 6 is broadcast | The crash fires once and the worker comes back; hiring stops at the cap with budget waiting; the job-fair line (`waitingSol`) equals that budget; the rest go after the cap is raised; audit PASS; no Jupiter 429 |
| 6 | `scripts/staging.sh 6` | GO: kill switch off, YOU send 0.001 SOL from the test creator; then the worker is stopped for 4 minutes | The kill switch turns itself ON; critical alert; "worker down" and "Worker is back" alerts. `scripts/staging.sh 6 --skip-watchdog` does the kill switch part only (about 5 minutes, no build) and is recorded as PARTIAL, never PASS |
| 7 | `scripts/staging.sh 7` | Opens `wallstreetinu.world/?api=<staging API>` | Every rat listed, Solscan links right, Vault value within 1% of token amounts x Jupiter prices; on your phone: rats clickable, stage SMALL OFFICE, the Company Roadmap |
| 8 | `scripts/staging.sh 8` | One backup, then a restore drill on your Mac | `restore-check` PASS; restored rats and claims equal the staging database |
| Teardown | `scripts/staging.sh teardown` | GO: sweep the rats to the throwaway wallet. You sell the xStocks and the test coin in Phantom, then empty both wallets to your own | SOL started with vs got back, in the report |
| Report | `scripts/staging.sh report` | `rehearsal-report.md` | **GO** only if phases 0 to 8 and the production site check PASS |

Each phase can be run again. The results are kept in `~/rat-secrets-staging/rehearsal-results.env`, with no secrets.

## The fast rehearsal (on your Mac, no Railway builds)
The staging worker, API and site run on your Mac, against mainnet and the staging database, with the test creator. A settings change is a restart in seconds instead of a Railway build. Every GO gate, the kill switch, every audit and the STAGING guards are the same (`scripts/staging-local.sh`, `scripts/local-app.cjs`).

| # | Command | What happens | Minutes |
|---|---|---|---|
| Once | Railway dashboard, **staging project only**: Postgres > Settings > Networking > Public Networking > TCP Proxy, port 5432 | Your Mac can reach the staging database (TLS) | 2 |
| Start | `scripts/staging-local.sh start` | Stops the Railway staging worker (only one worker ever runs, by its lock), then starts the worker, the API and the site here. The first time it installs the packages | 5 the first time, 1 after |
| Stocks | `scripts/approve-stocks.sh` | You check each mint on xstocks.fi; the local worker restarts | 3 |
| 0 | `scripts/staging.sh check` | The isolation checks | 1 |
| 1 | `scripts/staging.sh 1` | You launch the test coin and trade; it goes LIVE with the kill switch ON | 4 |
| 2 | `scripts/staging.sh 2` | GO: the real claim, audited | 1 |
| 3 | `scripts/staging.sh 3 --rats 3` | GO: 3 rats buy real xStocks, audited | 3 |
| Site | Open `http://localhost:5173/?api=http://localhost:8080` | The rats, their Solscan links, and a stage-up (below) | 2 |
| 6 | `scripts/staging.sh 6 --skip-watchdog` | GO: you send 0.001 SOL from the test creator; the kill switch turns itself on | 2 |
| Teardown | `scripts/staging.sh teardown` | GO: the rats are swept to the throwaway wallet; you sell in Phantom and send everything to your own wallet | 5 |
| Stop | `scripts/staging-local.sh stop` | Everything on your Mac stops; `staging.sh` uses Railway again | 1 |

- **The stage-up:** the local API multiplies the stage source (claimed plus seeded SOL) by `STAGING_STAGE_SCALE` (20). 3 rats seed about 0.1 SOL, so the stage source is about 2 SOL: the building passes SMALL OFFICE (0.25) and FULL FLOOR (1) (`apps/pixel-site/src/floor/plan.ts`). The public claimed figure is never scaled. The config refuses `STAGING_STAGE_SCALE` without STAGING, the API applies it only on a marked staging database, and `scripts/check-guards.mjs` fails any deploy file that sets it above 1.
- **Your Mac:** keep it on and online until you stop. It is kept awake while the worker runs; closing the Terminal window does not stop anything, `scripts/staging-local.sh stop` does.
- **The settings:** the staging services' own Railway variables, handed to each app on stdin, never on a command line, never printed, never written to disk. The API gets its read-only database user and never the master key.
- **Not tested this way** (the Railway version is): Railway's build, deploy and restart of the bot (production setup already proved them), `railway ssh`, the public https site on your phone.
- Phase 6 without `--skip-watchdog` also works here, with no build: the worker on your Mac stops for 4 minutes and the admin service on Railway must alert.

## The short version on Railway (the money mechanisms only)
Phases 1, 2 and 3, plus the kill switch part of 6: the launch, the real fee claim and real xStock hires, each audited.

| # | Command | Minutes (one build = B: about 5 normally, 10 to 15 during a Railway incident) |
|---|---|---|
| Stocks | `scripts/approve-stocks.sh` | 3 + B |
| 0 | `scripts/staging.sh check` | 1 |
| 1 | `scripts/staging.sh 1` (trade for phase 2 while it builds) | 9 + B |
| 2 | `scripts/staging.sh 2` | 3 |
| 3 | `scripts/staging.sh 3` | 5 |
| 6 | `scripts/staging.sh 6 --skip-watchdog` (optional) | 5 |
| Report | `scripts/staging.sh report` | 1 |

Either way, not tested then: the hourly cap and the crash after a hire (4, 5), the backup (8), and the worker-down watchdog with `--skip-watchdog`. The report says **NO-GO** because they are missing: judge the phases you ran by their rows in the report (or their lines in `~/rat-secrets-staging/rehearsal-results.env`): phases 1, 2 and 3 PASS, phase 6 PARTIAL.

## Time
About 3 hours:
- setup, 30 minutes;
- phases, about 2 hours (phase 4 is the longest: builds plus the cap window);
- teardown, 30 minutes.

## What it cannot prove
- 60 SOL an hour of volume or thousands of rats (the SimChain tests cover that: `tests/e2e/`).
- The real creator key (a different wallet by design).
- Claims after the coin graduates to PumpSwap: the code path exists (`packages/pump/src/client.ts`), but a test coin won't graduate.
- The exact pump.fun launch cost (about 0.02 SOL, REPORTED), and whether the launch is one transaction. Phase 1 reads whatever the chain shows.
