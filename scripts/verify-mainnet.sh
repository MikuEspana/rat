#!/bin/bash
# READ-ONLY mainnet check (docs/runbooks/verify-mainnet.md): the public Solana RPC and Jupiter, no keys, no Railway,
# no database. Nothing is signed or sent: the claim and the swap are only simulated (signature checks off).
#   scripts/verify-mainnet.sh                                    programs, every stock mint, a 0.03 SOL quote into each
#   scripts/verify-mainnet.sh --sample <any pump.fun coin mint>  + the fee vault derivation and the claim, on live data
#   scripts/verify-mainnet.sh --payer <your wallet address>      + one simulated swap (that wallet needs ~0.05 SOL)
# A private RPC only through the environment, never on the command line: VERIFY_RPC_URL=... scripts/verify-mainnet.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PNPM="pnpm@$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"
die() {
  printf 'verify-mainnet: %s\n' "$1" >&2
  shift
  for l in "$@"; do printf '                %s\n' "$l" >&2; done
  exit 1
}
command -v node >/dev/null 2>&1 || die "node is missing" "Run: brew install node"
[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 22')" = true ] || die "node 22 or newer is needed (this is $(node --version))" "Run: brew upgrade node"
# the same packages as scripts/rat-local.sh (the rat CLI and what it uses), installed once per lockfile
stamp="node_modules/.rat-local-$(shasum -a 256 pnpm-lock.yaml 2>/dev/null | cut -c1-16 || sha256sum pnpm-lock.yaml | cut -c1-16)"
if [ ! -f "$stamp" ]; then
  printf 'verify-mainnet: installing the rat CLI packages into %s (once, a few minutes)...\n' "$PWD" >&2
  npx --yes --prefer-offline "$PNPM" install --frozen-lockfile --filter '@rat/cli...' >/dev/null 2>"node_modules.rat-local.log" ||
    die "the install failed" "The reason is in $PWD/node_modules.rat-local.log"
  rm -f node_modules/.rat-local-* "node_modules.rat-local.log"
  touch "$stamp"
fi
exec npx --yes --prefer-offline "$PNPM" --silent --filter @rat/cli run verify-mainnet "$@"
