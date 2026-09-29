#!/bin/bash
# Runs a rat CLI command on THIS Mac against the Railway database: the route that does not use `railway ssh`.
# Run it from the repo folder that scripts/setup-mac.sh set up (~/wallstreetrats).
#   scripts/rat-local.sh keys import --role creator     (asks for the key in a hidden prompt)
#   scripts/rat-local.sh preflight
#   scripts/rat-local.sh status
#
# How the settings travel: the worker's variables and Postgres's public URL (Railway's TCP proxy) are read with
# `railway variable list` into this script's memory and handed to the command on stdin as one JSON line
# (scripts/in-worker.cjs), never on a command line, never printed. The command runs with a clean environment, so
# nothing from this Mac's own shell can point it at another database. The database connection uses TLS
# (sslmode=no-verify: encrypted, Railway's certificate is self-signed). A key import encrypts the key with the master
# key HERE, before anything goes over the network.
#
# The first run installs the rat CLI's packages into this folder (a few minutes, once).
set -euo pipefail
cd "$(dirname "$0")/.."
PNPM="pnpm@$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"

die() {
  printf 'rat-local: %s\n' "$1" >&2
  shift
  for l in "$@"; do printf '           %s\n' "$l" >&2; done
  exit 1
}
for t in node jq; do command -v "$t" >/dev/null 2>&1 || die "$t is missing" "Run: brew install $t"; done
RW="${WSR_RAILWAY:-railway}"
command -v "$RW" >/dev/null 2>&1 || die "the railway CLI is missing" "Run: brew install railway"
[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 22')" = true ] || die "node 22 or newer is needed (this is $(node --version))" "Run: brew upgrade node"
[ $# -gt 0 ] || die "which rat command? For example: scripts/rat-local.sh preflight"

# the packages of the rat CLI (and only those), installed once and again when the lockfile changes
stamp="node_modules/.rat-local-$(shasum -a 256 pnpm-lock.yaml | cut -c1-16)"
if [ ! -f "$stamp" ]; then
  printf 'rat-local: installing the rat CLI packages into %s (once, a few minutes)...\n' "$PWD" >&2
  npx --yes --prefer-offline "$PNPM" install --frozen-lockfile --filter '@rat/cli...' >/dev/null 2>"node_modules.rat-local.log" ||
    die "the install failed" "The reason is in $PWD/node_modules.rat-local.log"
  rm -f node_modules/.rat-local-* "node_modules.rat-local.log"
  touch "$stamp"
fi
shim=$(mktemp -d)
trap 'rm -rf "$shim"' EXIT
printf '#!/bin/sh\nexec npx --yes --prefer-offline %s "$@"\n' "$PNPM" >"$shim/pnpm" # scripts/in-worker.cjs runs pnpm
chmod +x "$shim/pnpm"

# the settings: values stay in this shell's memory and in a pipe (printf is a shell builtin: no command line)
worker=$("$RW" variable list --service worker --json 2>/dev/null) || worker=""
printf '%s' "$worker" | jq -e 'type == "object" and has("KEY_ENCRYPTION_KEY")' >/dev/null 2>&1 ||
  die "could not read the worker's variables (or KEY_ENCRYPTION_KEY is not set)" "Is this folder linked to the project? Run: railway status"
pg_name=$("$RW" service list --json 2>/dev/null | jq -r 'map(select(.name | test("^Postgres"))) | .[0].name // empty' 2>/dev/null) || pg_name=""
[ -n "$pg_name" ] || die "no Postgres service found in this project" "Run: railway status"
pg=$("$RW" variable list --service "$pg_name" --json 2>/dev/null) || pg=""
settings=$(printf '%s\n%s\n' "$worker" "$pg" | jq -sc '
  (.[1].DATABASE_PUBLIC_URL // "") as $u
  | if ($u | test("^postgres(ql)?://[^@]+@[^:/@]+:[0-9]+/")) | not then error("no public URL") else . end
  | (.[0] | with_entries(select(.value | type == "string")))
    + {DATABASE_URL: ($u + (if ($u | contains("?")) then "&" else "?" end) + "sslmode=no-verify")}' 2>/dev/null) ||
  die "Postgres has no public address (DATABASE_PUBLIC_URL), so this Mac cannot reach it" \
    "Railway dashboard: $pg_name > Settings > Networking > Public Networking: add a TCP Proxy on port 5432." \
    "Then run this again."
unset worker pg

run() { # run <rat args>: stdin of this function follows the settings line
  { printf '%s\n' "$settings"; cat; } | env -i RAT_SETTINGS_FROM=stdin PATH="$shim:$PATH" HOME="$HOME" LANG="${LANG:-en_US.UTF-8}" node scripts/in-worker.cjs "$@"
}

if [ "$1" = keys ] && [ "${2:-}" = import ] && [ -t 0 ]; then
  printf '  Private key (hidden, paste then press Enter): ' >&2
  IFS= read -rs key || die "no keyboard input"
  printf '\n' >&2
  key=$(printf '%s' "$key" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  [ -n "$key" ] || die "nothing was pasted"
  status=0
  printf '%s' "$key" | run "$@" || status=$?
  unset key
  ${WSR_PBCOPY:-pbcopy} </dev/null 2>/dev/null || true # clear the clipboard: the key may be on it
  exit "$status"
fi
if [ -t 0 ]; then run "$@" </dev/null; else run "$@"; fi
