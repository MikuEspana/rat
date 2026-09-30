#!/bin/bash
# Right after the launch: the public site shows the coin's CA in seconds, before the bot is live. From ~/wallstreetrats:
#   scripts/announce-ca.sh <coin mint>
# It runs `rat announce-ca` in the worker: only a pump.fun coin created by the creator wallet is accepted (read on
# chain), else nothing changes. It sends nothing, changes no Railway setting and restarts nothing: the bot goes live
# with scripts/launch.sh, which also runs this step by itself once you confirm the mint.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/wsr.sh
. scripts/lib/wsr.sh
[ $# -eq 1 ] || die "usage: scripts/announce-ca.sh <coin mint (the CA from pump.fun)>"
rat announce-ca "$1" || die "the site was not told about $1 (the line above says why)" "Check the CA on pump.fun: it must be the coin you launched from the creator wallet."
