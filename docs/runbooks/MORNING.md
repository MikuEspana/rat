# Tomorrow morning: the fast rehearsal, then the launch

One box at a time. Minutes are yours (typing, clicking, waiting). B = one Railway build: about 5 minutes normally, 10 to 15 during a Railway incident.

## 0. Before anything (5 min)
- [ ] **status.railway.com is green AND the "Limited Access" banner is gone** from your Railway dashboard (it said "Deploys have been paused temporarily"). Not yet: wait. The rehearsal reads its settings from Railway, and the staging setup and the launch each need a Railway build.
- [ ] **Production after last night's merges.** When Railway deployed again, the production worker, api and admin rebuilt from `main`. That is safe (DRY RUN, nothing sent, the bot's behavior unchanged: `docs/runbooks/auto-deploy.md`, "Last night's merges"). Check:
  1. Railway dashboard, production project: worker, api and admin each show their latest deployment **Success**.
  2. `scripts/rat.sh status` (from `~/wallstreetrats`): mode **dry_run**, the loops a few seconds old.
  3. `scripts/rat.sh preflight`: only the expected "not yet" lines.
- [ ] Pull the latest scripts into both folders:
  ```
  git -C ~/wallstreetrats-staging pull
  git -C ~/wallstreetrats pull
  ```

## 1. Staging, in this order
- [ ] **Finish the staging setup** (skip if it already ended with the green checklist): `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/MikuEspana/rat/main/scripts/setup-staging.sh)"`. Finished steps are skipped. Keys only in its hidden prompts. 10 to 30 min, mostly Railway.
- [ ] **TCP proxy on the staging Postgres**: Railway dashboard, **staging project only**: Postgres > Settings > Networking > Public Networking > **TCP Proxy**, port 5432. 2 min. (Your Mac needs it for the fast rehearsal. Never on production.)
- [ ] **Approve the stocks**, with the staging bot already on your Mac so it needs no Railway build, from `~/wallstreetrats-staging`:
  ```
  scripts/staging-local.sh start
  scripts/approve-stocks.sh
  ```
  `start`: 5 min the first time (it installs the packages), then `OK worker, API and site run on this Mac`. `approve-stocks.sh`: check each mint on xstocks.fi, 3 min, ends with the preflight stocks line PASS.

## 2. The fast rehearsal on your Mac (about 15 min, no Railway builds)
All from `~/wallstreetrats-staging`. Every mainnet transaction waits for your **GO**. Details: `docs/runbooks/rehearsal.md`, "The fast rehearsal".

| # | Command | You do | Min | PASS looks like |
|---|---|---|---|---|
| a | `scripts/staging.sh check` | nothing | 1 | `phase 0: PASS separate project, test creator, own master key, STAGING on` |
| b | `scripts/staging.sh 1` | GO, launch TEST DO NOT BUY in Phantom (test creator, 0.1 SOL dev buy), confirm the mint, then 2 buys and 2 sells of 0.05 SOL from your trading wallet while it restarts | 5 | `preflight launch txs: PASS`, `preflight dev buy: PASS`, `phase 1: PASS coin ... live with the kill switch ON` |
| c | `scripts/staging.sh 2` | Enter, GO | 2 | `phase 2: PASS claimed ... SOL, every claim equals what left the fee vaults, to the lamport` |
| d | `scripts/staging.sh 3 --rats 3` | GO | 3 | every audit line PASS, `phase 3: PASS 3 rats hired, each paid once ...` |
| e | open `http://localhost:5173/?api=http://localhost:8080` | look | 2 | the 3 rats, their Solscan links, the building at FULL FLOOR (stage source about 2 SOL) |
| f | `scripts/staging.sh 6 --skip-watchdog` | GO, send 0.001 SOL from the test creator to yourself in Phantom, confirm the Telegram alert | 3 | `kill switch ON after ... s`, then `phase 6: PARTIAL ... (--skip-watchdog)` |
| g | `scripts/staging.sh report` | read | 1 | rows 1, 2, 3 PASS and 6 PARTIAL. It says **NO-GO** only because 4, 5, 7 and 8 were not run: expected |

- **Any FAIL or STOPPED: do not launch.** Send the output; nothing was sent that you did not GO.
- After the real launch: `scripts/staging.sh teardown` (sweeps the rats to the throwaway wallet, you sell in Phantom and send everything to your own wallet), then `scripts/staging-local.sh stop`.

## 3. Production, before the coin (about 25 min plus 1 build)
All from `~/wallstreetrats`.
- [ ] `scripts/verify-mainnet.sh --sample <any pump.fun coin mint> --payer <your wallet address>`: read-only, nothing signed or sent. Every stock mint, a Jupiter quote for 0.03 SOL into each, the claim and one swap simulated on live mainnet. Ends with `OK: no FAIL`; approve only stocks whose `mint` and `quote` lines PASS (`docs/runbooks/verify-mainnet.md`). 2.
- [ ] `scripts/approve-stocks.sh`: check each mint on xstocks.fi. 5 + B.
- [ ] `scripts/rat.sh preflight`: only the expected "not yet" lines (no `COIN_MINT` yet, the creator wallet not funded, the watch floor). 2.
- [ ] `scripts/site-go-live.sh`: two clicks on GitHub, then check the site on your phone (DRY RUN banner, 0 rats, "pre-launch"). 10.
- [ ] **Auto deploy OFF** on the production worker, api and admin until the bot has run live for a day, and no merges to `main` in that time (`docs/runbooks/auto-deploy.md`, "The clicks"). `scripts/launch.sh` still deploys. 3.
- [ ] Fund the creator wallet with about **0.3 SOL**. 2.

## 4. Launch (about 5 min plus 1 build)
- [ ] `scripts/launch.sh` from `~/wallstreetrats`, **before** you launch. Then launch on pump.fun from the creator wallet (normal mode, no holder rewards, no fee sharing, dev buy 0.1 SOL inside the launch), press Enter when Solscan shows it Finalized, confirm the mint, type **GO**. It ends with **LIVE**. Step by step: `LAUNCH-DAY.md`.
- [ ] Then: admin page LIVE, the first claim on Solscan, the first rats on the site. Post the video and the CA.
