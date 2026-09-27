# One image for both services. Railway picks the start command per service (infra/railway.*.json).
#   worker: pnpm --filter @rat/worker start
#   api:    pnpm --filter @rat/api start

# ---- solana-keygen (Agave CLI) for the worker's background key grinder ----
# Only this one binary goes into the final image. Pinned release; set AGAVE_SHA256 to also verify the tarball
# (CI prints the hash of what it downloaded). On a non-x86_64 build it is skipped and the worker falls back to
# the built-in JS grinder (KEYPOOL_GRINDER=auto).
FROM debian:bookworm-slim AS keygen
ARG TARGETARCH
ARG AGAVE_VERSION=v2.3.13
ARG AGAVE_SHA256=
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl bzip2 libudev1 \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /out \
 && if [ "${TARGETARCH:-amd64}" = "amd64" ]; then \
      curl -fsSL --retry 3 -o /tmp/agave.tar.bz2 \
        "https://github.com/anza-xyz/agave/releases/download/${AGAVE_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" \
      && echo "agave ${AGAVE_VERSION} tarball sha256: $(sha256sum /tmp/agave.tar.bz2 | cut -d' ' -f1)" \
      && if [ -n "${AGAVE_SHA256}" ]; then echo "${AGAVE_SHA256}  /tmp/agave.tar.bz2" | sha256sum -c -; fi \
      && tar -xjf /tmp/agave.tar.bz2 -C /tmp solana-release/bin/solana-keygen \
      && install -m 0755 /tmp/solana-release/bin/solana-keygen /out/solana-keygen \
      && /out/solana-keygen --version \
      && rm -rf /tmp/agave.tar.bz2 /tmp/solana-release; \
    else echo "skipping solana-keygen on ${TARGETARCH}: the worker will use the built-in grinder"; fi

# ---- app ----
FROM node:22-slim

ENV CI=true
# libudev1: runtime dependency of the solana-keygen release binary
RUN apt-get update \
 && apt-get install -y --no-install-recommends libudev1 \
 && rm -rf /var/lib/apt/lists/*
# pnpm installed globally so the non-root runtime user never needs the network to fetch it
RUN npm install -g pnpm@10.33.0
COPY --from=keygen /out/ /usr/local/bin/

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
