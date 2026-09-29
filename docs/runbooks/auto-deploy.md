# Production auto-deploy: what happens on a merge to main

A read-only check (nothing on Railway was changed). The part only Railway's dashboard can show (whether auto deploy is switched on) is marked **CONFIRM**.

## What the repo proves

| Fact | Where |
|---|---|
| Setup connects the production worker, api, admin and backup services to GitHub `MikuEspana/rat`, branch `main` | `scripts/setup-mac.sh`: the repo slug `MikuEspana/rat` and the branch `main` (lines 32 to 34); `connect_source` runs `railway service source connect --repo ... --branch ...` with them (lines 250 to 255) for worker (852), api and admin (940, 941) and backup (1001) |
| The staging services are connected the same way (same script, staging profile) | `scripts/setup-staging.sh` runs `scripts/setup-mac.sh` |
| Worker, api and admin have **no watch paths**: every commit to `main` rebuilds all three, even one that only changes a doc or a script | `infra/railway.worker.json`, `infra/railway.api.json`, `infra/railway.admin.json` (no `build.watchPatterns`) |
| Backup rebuilds only when `infra/backup/**` or its own file changes | `infra/railway.backup.json` (`watchPatterns`) |
| CI runs on every push to `main` | `.github/workflows/ci.yml` (`on: push: branches: [main, 'claude/**']`) |

## What Railway's docs say

- "Services linked to a GitHub repository automatically deploy when new commits are pushed to the connected branch." ([docs.railway.com/deployments/github-autodeploys](https://docs.railway.com/deployments/github-autodeploys))
- Auto deploy can be switched off per service (Service Settings: **Disable**); "Deploy Latest Commit" then deploys by hand. Same page.
- **Wait for CI**: the deployment waits until every GitHub Actions workflow on the commit has finished; a failed workflow skips the deployment. It needs a workflow that runs on push to the branch, which `ci.yml` has. Same page, "Wait for CI".
- "If you trigger a new deploy, the previous version will be stopped and removed after the new version deploys." So a build that fails leaves the running bot as it was. ([docs.railway.com/deployments/deployment-teardown](https://docs.railway.com/deployments/deployment-teardown))

## So

- **CONFIRM** (Railway dashboard, production project > worker > Settings > Source): the connected repo and branch, whether auto deploy is on, whether "Wait for CI" is on. Unless it was switched off, auto deploy is on (it is the default for a service connected to a repo).
- If it is on: every merge to `main` rebuilds and restarts the production worker, api and admin. Before launch that is harmless (DRY RUN, and restarts are safe at any moment: LAUNCH-DAY.md). **During the launch it is a risk:** a merge would restart the live bot mid-launch, and a merge with a bug would go live without anyone pressing a button.

## Last night's merges, when Railway deploys again
Railway paused all deploys during its incident. When it resumes, the production worker, api and admin (and the staging services, also connected to `main`) rebuild from the latest `main`, which now holds every merge of last night. That is safe:
- **Nothing can be sent.** `DRY_RUN=true` is set on the worker, admin and api (`scripts/setup-mac.sh` lines 841 to 848), and sending needs `DRY_RUN=false` AND the exact `LIVE_CONFIRM` phrase (`apps/worker/src/main.ts` lines 1 to 2, `packages/core/src/config.ts` line 279). No merge changed a Railway variable.
- **The bot's behavior does not change.** Since #82 only two runtime files changed: `packages/core/src/config.ts` (`STAGING_STAGE_SCALE`: 1 by default, refused above 1 without STAGING, lines 92, 272 to 273, 285) and `apps/api/src/state-service.ts` (the stage source is sent only on a marked staging database, line 128). Production has neither. Everything else was scripts and docs.
- **The backup service does not rebuild** (nothing under `infra/backup/` changed), and nothing under `infra/` changed at all.
- **A failed build changes nothing**: the running version stays until a new one deploys (Railway docs above). Restarts are safe at any moment (LAUNCH-DAY.md, "What normal looks like").

### What to check on production in the morning (5 minutes)
1. Railway dashboard, production project: worker, api and admin each show their latest deployment **Success**, built from the latest `main` commit (Deployments tab). A failed or queued one: Deployments > the three dots > Redeploy, or wait for Railway.
2. `scripts/rat.sh status`: mode **dry_run**, the loops a few seconds old.
3. `scripts/rat.sh preflight`: only the expected "not yet" lines (no `COIN_MINT` yet, the creator wallet not funded, the watch floor).
4. The admin page opens with your password; the API answers (`scripts/site-go-live.sh` checks it).
5. Telegram: a "WORKER DOWN" then "Worker is back" pair during the night is expected if Railway restarted things; a "WORKER DOWN" with no "back" is not: check the worker's logs.

## Proposal (nothing is changed until you decide)

| # | Change | Where | Effort | Why |
|---|---|---|---|---|
| 1 | **No merges to `main` from T-1 hour until the bot has run live for an hour** | LAUNCH-DAY.md, "The night before" | a rule | Zero risk, zero setup. The simplest protection for launch day. |
| 2 | **Turn on "Wait for CI"** on production worker, api and admin | Railway dashboard (clicks below) | 2 minutes | A merge whose CI fails never deploys. Keeps auto deploy for everything else. Best after the launch. |
| 3 | Later, after launch: **watch paths** for worker, api and admin (`apps/**`, `packages/**`, `config/**`, `infra/Dockerfile`, their own `infra/railway.*.json`, `package.json`, `pnpm-lock.yaml`) | `infra/railway.*.json` | a PR | Docs and script merges stop rebuilding the bot. Not before launch: it changes the production build settings. |
| 4 | **Disable auto deploy** on the production worker, api and admin, from the night before the launch until the bot has run live for a day | Railway dashboard (clicks below) | 2 minutes | Nothing deploys unless you (or `scripts/launch.sh`, which uses "Deploy Latest Commit") do it. The only way a merge can never restart the live bot mid-launch. |

**For launch day, recommended: 1, and turn auto deploy OFF on the production worker, api and admin (4) from the night before until the bot has run live for a day.** "Wait for CI" (2) alone would still deploy any green merge in the middle of the launch and restart the live bot. `scripts/launch.sh` does not need auto deploy: it deploys with "Deploy Latest Commit", which works with auto deploy off. After launch: turn auto deploy back on with "Wait for CI" (2), then add watch paths (3).

## The clicks (you do these; nothing here changes production by itself)
Railway's docs name the settings "Disable" / "Enable" and "Wait for CI" in the service settings, next to the connected GitHub branch ([github-autodeploys](https://docs.railway.com/deployments/github-autodeploys)). The exact place on the page can move between Railway versions.

**Turn auto deploy off (launch day):**
1. railway.com, open the production project **wall-street-rats** (not `-staging`).
2. Click the **worker** service, then **Settings**.
3. Find the source part: the GitHub repo `MikuEspana/rat` and the branch `main` it deploys from.
4. Click **Disable** (automatic deployments).
5. If Railway shows a banner with changes to apply, hold **Option** (Alt) while clicking **Deploy**: that saves the change without a redeploy ([staged-changes](https://docs.railway.com/deployments/staged-changes)).
6. Repeat 2 to 5 for **api** and **admin**.
7. To deploy by hand later: Cmd + K, **Deploy Latest Commit** (or `scripts/launch.sh`, which does the same).

**Or turn "Wait for CI" on (after launch, with auto deploy back on):**
1. to 3. as above.
4. Turn on **Wait for CI**. It only shows when a GitHub workflow runs on push to the branch; `.github/workflows/ci.yml` does.
5. and 6. as above.
