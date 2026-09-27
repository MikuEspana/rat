# One image for both services. Railway picks the start command per service (infra/railway.*.json).
#   worker: pnpm --filter @rat/worker start
#   api:    pnpm --filter @rat/api start

FROM node:22-slim

ENV CI=true
# pnpm installed globally so the non-root runtime user never needs the network to fetch it
RUN npm install -g pnpm@10.33.0

WORKDIR /app
# Install first (better layer caching), then copy the source. Dev dependencies are needed at runtime (tsx).
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
COPY tests/package.json tests/
RUN pnpm install --frozen-lockfile

COPY . .

# Safe default: even if the host forgets to set it, the image starts in DRY RUN.
ENV NODE_ENV=production \
    DRY_RUN=true
USER node
CMD ["pnpm", "--filter", "@rat/worker", "start"]
