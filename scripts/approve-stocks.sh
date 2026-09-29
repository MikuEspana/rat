#!/bin/bash
# Approve xStocks after YOU checked each mint on xstocks.fi. Run it from the project's folder:
#   ~/wallstreetrats/scripts/approve-stocks.sh            (production, still in DRY RUN before launch)
#   ~/wallstreetrats-staging/scripts/approve-stocks.sh    (the rehearsal)
# For every enabled stock in config/stocks.json it shows the mint, opens xstocks.fi and asks whether the Solana
# address there matches, character for character. Then it sets APPROVED_STOCKS on the worker (a comma list of
# symbols, loaded on top of the stocks file), redeploys the worker and runs `rat stocks-sync`. An approved stock is
# still hired into only after it passes the on-chain mint check (Token-2022, the xStocks mint authority): the
# preflight "stocks" line shows that check. No transaction is sent.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/wsr.sh
. scripts/lib/wsr.sh
for t in jq curl; do command -v "$t" >/dev/null 2>&1 || die "$t is missing" "Run: brew install $t"; done
command -v "${WSR_RAILWAY:-railway}" >/dev/null 2>&1 || die "the railway CLI is missing" "Run: brew install railway"

project=$(rw status --json 2>/dev/null | jq -r '.name // empty') || project=""
[ -n "$project" ] || die "this folder ($PWD) is not linked to a Railway project" "Run scripts/setup-mac.sh (or setup-staging.sh) first."
title "Approve xStocks for $project"
say "You check each mint yourself on xstocks.fi. Only the ones you confirm are approved."
current=$(rw_var worker APPROVED_STOCKS)

approved=""
n=0
while IFS=$'\t' read -r sym name mint <&3; do # the list on fd 3: the questions read the keyboard
  n=$((n + 1))
  printf '\n  %s%s%s  %s\n' "$B" "$sym" "$N" "$name"
  say "Mint in config/stocks.json: $mint"
  say "Compare the first 6 and last 6 characters: ${mint:0:6} ... ${mint: -6}"
  case ",$current," in *",$sym,"*) def=y ;; *) def=n ;; esac
  [ "$n" = 1 ] && open_url "https://xstocks.fi/"
  say "On xstocks.fi, open $name ($sym) and find its Solana address."
  if yes_no "Does the Solana address on xstocks.fi match exactly?" "$def"; then
    approved="${approved:+$approved,}$sym"
    ok "$sym approved"
  else
    note "$sym not approved (no rat is hired into it)"
  fi
done 3< <(jq -r '.stocks[] | select(.enabled) | [.symbol, .name, .mint] | @tsv' config/stocks.json)
[ "$n" -gt 0 ] || die "no enabled stock in config/stocks.json"

printf '\n'
if [ "$approved" = "$current" ]; then
  ok "APPROVED_STOCKS is already ${approved:-empty}: nothing to change"
else
  say "Approved: ${approved:-none}"
  yes_no "Set APPROVED_STOCKS=${approved:-(empty)} on the $project worker and redeploy it?" y || die "nothing was changed"
  if [ -n "$approved" ]; then
    rw variable set "APPROVED_STOCKS=$approved" --service worker --skip-deploys >/dev/null || die "could not set APPROVED_STOCKS"
  else
    rw variable delete APPROVED_STOCKS --service worker >/dev/null 2>&1 || true
  fi
  redeploy worker
fi
sync=$(rat stocks-sync 2>&1) || die "rat stocks-sync failed" "$(printf '%s' "$sync" | tail -2 | tr '\n' ' ')"
printf '%s\n' "$sync" | grep -E '^[A-Za-z]+x? +enabled=' | sed 's/^/        /' || true
pre=$(rat_json preflight --json)
line=$(printf '%s' "$pre" | jq -r '.lines[]? | select(.check == "stocks") | "\(.status)  \(.detail)"' 2>/dev/null || true)
case "$line" in
  PASS*) ok "on-chain mint check: ${line#PASS  }" ;;
  "") note "preflight did not report the stocks check; run: scripts/rat.sh preflight" ;;
  *) bad "on-chain mint check: $line" ;;
esac
