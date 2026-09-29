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

## Proposal (nothing is changed until you decide)

| # | Change | Where | Effort | Why |
|---|---|---|---|---|
| 1 | **No merges to `main` from T-1 hour until the bot has run live for an hour** | LAUNCH-DAY.md, "The night before" | a rule | Zero risk, zero setup. The simplest protection for launch day. |
| 2 | **Turn on "Wait for CI"** on production worker, api and admin | Railway dashboard, each service > Settings > Source | 2 minutes | A merge whose CI fails never deploys. Keeps auto deploy for everything else. |
| 3 | Later, after launch: **watch paths** for worker, api and admin (`apps/**`, `packages/**`, `config/**`, `infra/Dockerfile`, their own `infra/railway.*.json`, `package.json`, `pnpm-lock.yaml`) | `infra/railway.*.json` | a PR | Docs and script merges stop rebuilding the bot. Not before launch: it changes the production build settings. |
| 4 | Only if you want full manual control: **disable auto deploy** on production | Railway dashboard | 2 minutes | Nothing deploys unless you (or `scripts/launch.sh`, which uses "Deploy Latest Commit") do it. Costs a manual step for every fix. |

**Recommended now: 1 and 2.** 3 after launch. 4 only if you prefer manual deploys.
