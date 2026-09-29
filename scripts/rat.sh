#!/bin/bash
# Runs a rat CLI command inside the Railway worker, where DATABASE_URL and the master key live (nothing is copied
# to this Mac). Run it from the repo folder that scripts/setup-mac.sh linked (~/wallstreetrats).
#   scripts/rat.sh status
#   scripts/rat.sh preflight --live
#   scripts/rat.sh sweep --confirm "SWEEP ALL RATS TO <cold wallet>"
set -euo pipefail
cd "$(dirname "$0")/.."
args=""
for a in "$@"; do args="$args $(printf '%q' "$a")"; done
key="$HOME/.ssh/railway_wsr_ed25519"
[ -f "$key" ] || key=""
exec railway ssh --service worker ${key:+-i "$key"} -- sh -c "cd /app && pnpm --silent --filter @rat/cli rat$args"
