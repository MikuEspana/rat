#!/bin/bash
# The mainnet rehearsal's setup (docs/runbooks/rehearsal.md): scripts/setup-mac.sh with the staging profile.
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/MikuEspana/rat/main/scripts/setup-staging.sh)"
#
# Everything is separate from production and can never point at it:
#   - its own Railway project "wall-street-rats-staging", linked from its own folder ~/wallstreetrats-staging
#     (the Railway CLI links per folder); it refuses the production project
#   - its own secrets and master key in ~/rat-secrets-staging, its own Postgres, its own R2 bucket
#   - a TEST creator wallet you make in Phantom (never 4VYW...Kiot, refused here and by the config)
#   - a throwaway sweep wallet this script makes (never DX7R...): its key is saved to ~/rat-secrets-staging only,
#     never printed, and you only need it at teardown
#   - STAGING=true (only staging scripts may set it: scripts/check-guards.mjs) and MIN_CLAIM_SOL=0.0003 so the
#     tiny test volume makes a claim; then `rat staging-init` marks the database and the kill switch goes ON
# DRY RUN like production. Every mainnet transaction waits for your GO in scripts/staging.sh.
set -euo pipefail

REPO_URL="https://github.com/MikuEspana/rat.git"
BRANCH="main"
STG_DIR="${WSR_STAGING_DIR:-$HOME/wallstreetrats-staging}"
STG_SECRETS="${WSR_STAGING_SECRETS:-$HOME/rat-secrets-staging}"
PROD_SECRETS="${WSR_PROD_SECRETS:-$HOME/rat-secrets}"
PRODUCTION_CREATOR="DMCYiQzy5QoaARhVxFp9uwShBwm1BwbGX564neFvvZs1"
PRODUCTION_COLD="DX7RpxyhbcGeiBQh76ed2wZHw8WZ2CdMoDibpWmX9ajj"
STATE="$STG_SECRETS/setup-state.env"

if [ -t 1 ]; then B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; N=$'\033[0m'; else B=; R=; G=; N=; fi
die() {
  printf '\n  %sSTOPPED%s  %s\n' "$R" "$N" "$1" >&2
  shift
  for l in "$@"; do printf '           %s\n' "$l" >&2; done
  exit 1
}
say() { printf '        %s\n' "$1"; }
state_get() { if [ -f "$STATE" ]; then sed -n "s/^$1=//p" "$STATE" | tail -1; fi; }
state_set() {
  touch "$STATE"
  grep -v "^$1=" "$STATE" >"$STATE.tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}
is_pubkey() { printf '%s' "$1" | grep -Eq '^[1-9A-HJ-NP-Za-km-z]{32,44}$'; }

printf '%s\n' "${B}IDLE INU rehearsal setup (staging)${N}  (DRY RUN. Nothing here can send a mainnet transaction.)"
umask 077
mkdir -p "$STG_SECRETS"
chmod 700 "$STG_SECRETS"
if [ -d "$PROD_SECRETS" ] && [ "$(cd "$STG_SECRETS" && pwd -P)" = "$(cd "$PROD_SECRETS" && pwd -P)" ]; then
  die "the staging secrets folder is the production one ($PROD_SECRETS)"
fi
state_set PROFILE staging

# the repo, in its own folder
if [ -z "${WSR_SKIP_CLONE:-}" ]; then
  if [ -d "$STG_DIR/.git" ]; then
    git -C "$STG_DIR" pull --ff-only -q origin "$BRANCH" >/dev/null 2>&1 || say "could not update $STG_DIR (local changes?), using it as it is"
  else
    git clone -q --branch "$BRANCH" "$REPO_URL" "$STG_DIR" || die "could not download the repo to $STG_DIR"
  fi
fi
[ -f "$STG_DIR/scripts/setup-mac.sh" ] || die "$STG_DIR has no scripts/setup-mac.sh"

# the test creator: a NEW Phantom account, never the real creator
TEST_CREATOR=$(state_get TEST_CREATOR)
if [ -z "$TEST_CREATOR" ]; then
  say "In Phantom, add a NEW account named \"test creator\" (Add / Connect Wallet > Create new account)."
  say "Fund it with 0.47 SOL from a wallet that has nothing to do with the real launch (docs/runbooks/rehearsal.md)."
  while :; do
    printf '  Its PUBLIC address (Phantom > the account > Copy address): '
    IFS= read -r TEST_CREATOR || die "no keyboard input (end of input)"
    TEST_CREATOR=$(printf '%s' "$TEST_CREATOR" | tr -d '[:space:]')
    if ! is_pubkey "$TEST_CREATOR"; then say "that is not a Solana address, try again"; continue; fi
    if [ "$TEST_CREATOR" = "$PRODUCTION_CREATOR" ] || [ "$TEST_CREATOR" = "$PRODUCTION_COLD" ]; then
      say "that is a production wallet: the rehearsal must use a NEW test account"
      continue
    fi
    break
  done
  state_set TEST_CREATOR "$TEST_CREATOR"
fi
[ "$TEST_CREATOR" != "$PRODUCTION_CREATOR" ] || die "the test creator is the production creator"

# the throwaway sweep wallet: made here, key saved in the staging secrets only, never printed
if [ ! -s "$STG_SECRETS/throwaway-wallet.key" ]; then
  command -v node >/dev/null 2>&1 || die "node is missing" "Run: brew install node"
  node -e '
    const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
    const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const b58 = (buf) => { let n = BigInt("0x" + (buf.toString("hex") || "0")), s = "";
      while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
      for (const b of buf) { if (b !== 0) break; s = "1" + s; } return s; };
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
    const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const dir = process.argv[1];
    fs.writeFileSync(path.join(dir, "throwaway-wallet.key"), b58(Buffer.concat([seed, pub])) + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "throwaway-wallet.pub"), b58(pub) + "\n", { mode: 0o600 });
  ' "$STG_SECRETS"
fi
THROWAWAY=$(tr -d '[:space:]' <"$STG_SECRETS/throwaway-wallet.pub")
is_pubkey "$THROWAWAY" || die "$STG_SECRETS/throwaway-wallet.pub is not a Solana address"
printf '  %sOK%s    test creator %s, throwaway sweep wallet %s (key in %s)\n' "$G" "$N" "$TEST_CREATOR" "$THROWAWAY" "$STG_SECRETS/throwaway-wallet.key"

# the production project id (if production is set up on this Mac): the staging setup refuses to link to it
PROD_PROJECT=""
[ -f "$PROD_SECRETS/setup-state.env" ] && PROD_PROJECT=$(sed -n 's/^RAILWAY_PROJECT_ID=//p' "$PROD_SECRETS/setup-state.env" | tail -1)

# setup-mac.sh does the rest, with the staging profile. STAGING=true is set only here and in scripts/staging.sh.
WSR_PROFILE=staging \
  WSR_DIR="$STG_DIR" \
  WSR_SECRETS="$STG_SECRETS" \
  WSR_SKIP_CLONE=1 \
  WSR_PROJECT_NAME=wall-street-rats-staging \
  WSR_CREATOR_PUBKEY="$TEST_CREATOR" \
  WSR_CREATOR_LABEL="test creator" \
  WSR_COLD_WALLET="$THROWAWAY" \
  WSR_BUCKET_PREFIX=wsr-staging-backups \
  WSR_EXTRA_VARS="STAGING=true MIN_CLAIM_SOL=0.0003" \
  WSR_FORBIDDEN_PROJECT_ID="$PROD_PROJECT" \
  exec /bin/bash "$STG_DIR/scripts/setup-mac.sh"
