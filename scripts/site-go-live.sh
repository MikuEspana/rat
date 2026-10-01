#!/bin/bash
# The production site go-live check, before launch. Run it from ~/wallstreetrats:
#   scripts/site-go-live.sh
# 1. The production API answers and lets https://wallstreetinu.world read it (CORS).
# 2. The published site is built against that API. If it is still the simulator demo, it shows the two clicks that
#    switch it (GitHub: the SITE_API_BASE variable, then the pages workflow), waits for the new site, and the
#    workflow's verify job checks it in a real browser (apps/pixel-site/tools/verify-live.mjs).
# 3. You look at it on your phone: before launch it must show the honest state ("The inus are clocking in..." banner, 0 inus, market cap
#    "pre-launch"), nothing simulated.
# The result goes to ~/rat-secrets/setup-state.env (SITE_GO_LIVE), which the rehearsal report reads. Only public data
# is read. Nothing is sent on chain.
set -euo pipefail
cd "$(dirname "$0")/.."
SITE="https://wallstreetinu.world"
REPO_WEB="https://github.com/MikuEspana/rat"
STATE="${WSR_SECRETS:-$HOME/rat-secrets}/setup-state.env"
if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; B=$'\033[1m'; N=$'\033[0m'; else G=; R=; B=; N=; fi
ok() { printf '  %sOK%s    %s\n' "$G" "$N" "$1"; }
say() { printf '        %s\n' "$1"; }
record() { # record PASS|FAIL "detail"
  touch "$STATE"
  grep -v '^SITE_GO_LIVE=' "$STATE" >"$STATE.tmp" || true
  printf 'SITE_GO_LIVE=%s|%s %s\n' "$1" "$(date -u +%Y-%m-%dT%H:%MZ)" "$2" >>"$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}
die() {
  printf '\n  %sSITE NOT READY%s  %s\n' "$R" "$N" "$1" >&2
  shift
  for l in "$@"; do printf '           %s\n' "$l" >&2; done
  record FAIL "$1"
  exit 1
}
yes_no() { local a; printf '  %s [Y/n] ' "$1"; read -r a || exit 1; case "$a" in "" | y | Y | yes) return 0 ;; esac; return 1; }
open_url() { say "Opening $1"; ${WSR_OPEN:-open} "$1" >/dev/null 2>&1 || say "(open it yourself: $1)"; }
bundle_has() { # bundle_has text: the published page's scripts contain it
  local html src js
  html=$(curl -fsS -m 20 "$SITE/?nocache=$(date +%s)" 2>/dev/null) || return 1
  for src in $(printf '%s' "$html" | sed -n 's/.*src="\([^"]*\.js\)".*/\1/p'); do
    case "$src" in http*) ;; *) src="$SITE/${src#/}" ;; esac
    # read the whole bundle first: with pipefail, grep -q closing the pipe early made curl (and the check) fail
    js=$(curl -fsS -m 30 "$src" 2>/dev/null) || continue
    case "$js" in *"$1"*) return 0 ;; esac
  done
  return 1
}

printf '%sProduction site go-live check%s (%s)\n' "$B" "$N" "$SITE"
domain=$(sed -n 's/^API_DOMAIN=//p' "$STATE" 2>/dev/null | tail -1)
[ -n "$domain" ] || die "no API_DOMAIN in $STATE" "Run scripts/setup-mac.sh first: it prints the public API address at the end."
API="https://$domain"

# 1. the API, and CORS for the site
state=$(curl -fsS -m 20 "$API/api/state" 2>/dev/null) || die "the production API does not answer: $API/api/state" "Check the api service in the Railway dashboard."
mode=$(printf '%s' "$state" | jq -r '.bot.mode')
rats=$(printf '%s' "$state" | jq -r '.portfolio.ratCount')
coin=$(printf '%s' "$state" | jq -r '.coin.mint // "none yet"')
ok "API $API answers: mode $mode, $rats rats, coin $coin"
allow=$(curl -sS -m 20 -D - -o /dev/null -H "Origin: $SITE" "$API/api/state" 2>/dev/null | tr -d '\r' | sed -n 's/^[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin: //p' | tail -1)
[ "$allow" = "$SITE" ] || [ "$allow" = "*" ] || die "the API does not let $SITE read it (CORS: ${allow:-none})" "Set CORS_ORIGIN=$SITE on the api service (setup-mac.sh does), then redeploy it."
ok "CORS allows $SITE"

# 2. the published site is built against this API
if bundle_has "$API"; then
  ok "$SITE is built against $API"
else
  say "$SITE is not built against $API yet (it is still the simulator demo or another API). Two clicks switch it:"
  say "1. GitHub > Settings > Secrets and variables > Actions > Variables > New repository variable:"
  say "   Name: SITE_API_BASE   Value: $API"
  open_url "$REPO_WEB/settings/variables/actions/new"
  say "2. Actions > pages > Run workflow (branch main)."
  open_url "$REPO_WEB/actions/workflows/pages.yml"
  printf '\n  Done both? Press Enter. '
  read -r _ || exit 1
  say "Waiting for the new site (up to 10 minutes; the workflow also checks it in a real browser)..."
  i=0
  until bundle_has "$API"; do
    i=$((i + 1))
    [ "$i" -gt 40 ] && die "after 10 minutes $SITE is still not built against $API" "Open $REPO_WEB/actions/workflows/pages.yml: the latest run says why."
    sleep 15
  done
  ok "$SITE is now built against $API"
fi
say "The workflow's verify job checked it in a real browser: $REPO_WEB/actions/workflows/pages.yml (latest run, verify)."

# 3. you, on your phone
say "Open $SITE on your phone."
case "$mode" in
  dry_run) want="the banner \"The inus are clocking in...\" at the top" ;;
  paused) want="the banner \"The inus are on a break\" at the top" ;;
  *) want="no banner at the top (live)" ;;
esac
[ "$coin" = "none yet" ] && want="$want, market cap \"pre-launch\""
yes_no "Does it show $want and INUS HIRED $rats, with nothing simulated?" || die "the site does not show the honest state" "Tell your engineer what it shows instead."
yes_no "Does ${SITE}/?sim still open the launch simulator (clearly marked SIMULATION)?" || die "the simulator at /?sim does not open"
record PASS "built against $API, mode $mode, $rats rats, checked on the phone"
printf '\n  %sSITE READY%s  %s shows the production API honestly.\n' "$B$G" "$N" "$SITE"
