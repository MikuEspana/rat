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
| 1 | `scripts/staging.sh 1` | GO, then YOU launch the coin in Phantom (0.1 SOL dev buy). The script finds the launch, sets `COIN_MINT` / `WATCH_FROM_SLOT` / `KNOWN_OWNER_TX_SIGS`, then goes LIVE with the kill switch ON | `launch txs` and `dev buy` PASS; `preflight --live` READY except the kill switch; 0 claims |
| 2 | `scripts/staging.sh 2` | You trade 2 x 0.05 SOL from your trading wallet; GO; the bot claims | `rat audit`: each claim equals what left the fee vaults, to the lamport |
| 3 | `scripts/staging.sh 3` | GO: seed 0.165 SOL, 5 hires at 0.03 SOL | Audit PASS (each rat paid once, holds what the database says, creator SOL equals the ledger); the API's claimed figure excludes the seed; `stageSol` is claimed plus seeded |
| 4 and 5 | `scripts/staging.sh 4` | GO: salary 0.01, a small hourly cap, seed 0.125. The worker kills itself right after hire 6 is broadcast | The crash fires once and the worker comes back; hiring stops at the cap with budget waiting; the job-fair line (`waitingSol`) equals that budget; the rest go after the cap is raised; audit PASS; no Jupiter 429 |
| 6 | `scripts/staging.sh 6` | GO: kill switch off, YOU send 0.001 SOL from the test creator; then the worker is stopped for 4 minutes | The kill switch turns itself ON; critical alert; "worker down" and "Worker is back" alerts |
| 7 | `scripts/staging.sh 7` | Opens `wallstreetrats.world/?api=<staging API>` | Every rat listed, Solscan links right, Vault value within 1% of token amounts x Jupiter prices; on your phone: rats clickable, stage SMALL OFFICE, the Company Roadmap |
| 8 | `scripts/staging.sh 8` | One backup, then a restore drill on your Mac | `restore-check` PASS; restored rats and claims equal the staging database |
| Teardown | `scripts/staging.sh teardown` | GO: sweep the rats to the throwaway wallet. You sell the xStocks and the test coin in Phantom, then empty both wallets to your own | SOL started with vs got back, in the report |
| Report | `scripts/staging.sh report` | `rehearsal-report.md` | **GO** only if phases 0 to 8 and the production site check PASS |

Each phase can be run again. The results are kept in `~/rat-secrets-staging/rehearsal-results.env`, with no secrets.

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
