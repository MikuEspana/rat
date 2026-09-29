# One image for every service. Railway picks the start command per service (infra/railway.*.json).
#   worker: pnpm --filter @rat/worker start
#   api:    pnpm --filter @rat/api start
#   admin:  pnpm --filter @rat/admin start

FROM node:22-slim

ENV CI=true
# pnpm installed globally so the non-root runtime user never needs the network to fetch it
RUN npm install -g pnpm@10.33.0

WORKDIR /app
# Install first, then copy the source: a merge that changes no package.json or the lockfile reuses the install layer.
# Only what the services run (--prod): tsx is a dependency of each app, the test and build tools stay out (about 80 MB
# less). The site (apps/pixel-site, served by GitHub Pages), the tests and the docs are not in the image
# (.dockerignore); pnpm skips the workspace packages that are not here.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/keys/package.json packages/keys/
COPY packages/chain/package.json packages/chain/
COPY packages/pump/package.json packages/pump/
COPY packages/jupiter/package.json packages/jupiter/
COPY packages/safety/package.json packages/safety/
COPY apps/worker/package.json apps/worker/
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile --prod

COPY . .

# Safe default: even if the host forgets to set it, the image starts in DRY RUN.
ENV NODE_ENV=production \
    DRY_RUN=true
USER node
CMD ["pnpm", "--filter", "@rat/worker", "start"]
