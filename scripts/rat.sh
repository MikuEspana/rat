#!/bin/bash
# Runs a rat CLI command inside the Railway worker, where the database and the master key live (nothing is copied
# to this Mac). Run it from the repo folder that scripts/setup-mac.sh set up (~/wallstreetrats).
#   scripts/rat.sh status
#   scripts/rat.sh preflight --live
#   scripts/rat.sh sweep --confirm "SWEEP ALL RATS TO <cold wallet>"
#   read -rs K && printf '%s' "$K" | scripts/rat.sh keys import --role creator; unset K
# A `railway ssh` session does not get the service's variables: scripts/in-worker.cjs runs the command with the
# running worker's settings, or with the service variables sent as the first line of stdin (never a command line).
set -euo pipefail
cd "$(dirname "$0")/.."
key="$HOME/.ssh/railway_wsr_ed25519"
[ -f "$key" ] || key=""
env_json=$(railway variable list --service worker --json 2>/dev/null | jq -c 'with_entries(select(.value | type == "string"))' 2>/dev/null) || env_json='{}'
[ -n "$env_json" ] || env_json='{}'
js=$(base64 <scripts/in-worker.cjs | tr -d '\n')
args=""
for a in "$@"; do args="$args $(printf '%q' "$a")"; done
{
  printf '%s\n' "$env_json"
  [ -t 0 ] || cat # piped input (a key for `keys import`) follows the settings line
} | railway ssh --service worker ${key:+-i "$key"} -- sh -c "cd /app && exec node -e 'eval(Buffer.from(\"$js\",\"base64\").toString())' --$args"
