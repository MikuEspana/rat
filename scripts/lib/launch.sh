# The launch, shared by scripts/launch.sh (launch day) and scripts/staging.sh phase 1 (the rehearsal), so the
# rehearsal runs exactly what launch day runs:
#   1. find the launch on chain: the creator wallet's new signatures, the last slot, the coin's mint;
#   2. check the live preflight WITH the coin's settings before anything changes on Railway (`rat --with ...
#      preflight`, read-only: scripts/in-worker.cjs refuses --with for any other command);
#   3. every launch setting in one change (worker: COIN_MINT, WATCH_FROM_SLOT = last slot + 1, KNOWN_OWNER_TX_SIGS,
#      DRY_RUN=false, LIVE_CONFIRM; API: COIN_MINT, DRY_RUN=false), each read back, then ONE redeploy of the worker and
#      the API, side by side (scripts/lib/wsr.sh redeploy).
# Sourced after scripts/lib/wsr.sh. Every value here is public (addresses, signatures, a slot, a phrase).
# shellcheck shell=bash
LIVE_PHRASE="I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS"
LAUNCH_SIGS=""
LAUNCH_SLOT=""
LAUNCH_MINT=""
# shellcheck disable=SC2034 # read by scripts/launch.sh (minutes from the coin to the bot live)
LAUNCH_TIME=""

latest_signature() { rpc getSignaturesForAddress "[\"$1\",{\"limit\":1}]" | jq -r '.[0].signature // empty'; }

find_launch() { # find_launch creator signature-before-the-launch: sets LAUNCH_SIGS, LAUNCH_SLOT, LAUNCH_MINT, LAUNCH_TIME
  # Every tx the creator signed since, FAILED ones too (a wallet's resend in congestion can land after the launch):
  # all of them are the owner's, so all go into KNOWN_OWNER_TX_SIGS and the watch floor comes after the last one.
  # Only the mint lookup needs a tx that succeeded.
  local c="$1" before="$2" sigs="[]" i s
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do # up to about 2 minutes for the launch to be finalized
    sigs=$(rpc getSignaturesForAddress "[\"$c\",{\"limit\":20,\"commitment\":\"finalized\"}]" |
      jq -c --arg b "$before" '(map(.signature) | index($b)) as $i | if $i == null then . else .[:$i] end' 2>/dev/null || echo '[]')
    [ "$(printf '%s' "$sigs" | jq '[.[] | select(.err == null)] | length' 2>/dev/null || echo 0)" -gt 0 ] && break
    [ "$i" = 12 ] || sleep "${WSR_POLL_SEC:-10}"
  done
  [ "$(printf '%s' "$sigs" | jq '[.[] | select(.err == null)] | length' 2>/dev/null || echo 0)" -gt 0 ] || return 1
  LAUNCH_SLOT=$(printf '%s' "$sigs" | jq '[.[].slot] | max')
  # shellcheck disable=SC2034 # read by scripts/launch.sh
  LAUNCH_TIME=$(printf '%s' "$sigs" | jq -r '[.[].blockTime // empty] | min // empty')
  LAUNCH_SIGS=$(printf '%s' "$sigs" | jq -r '[.[].signature] | join(",")')
  LAUNCH_MINT=""
  for s in $(printf '%s' "$sigs" | jq -r '.[] | select(.err == null) | .signature'); do
    LAUNCH_MINT=$(rpc getTransaction "[\"$s\",{\"encoding\":\"jsonParsed\",\"maxSupportedTransactionVersion\":0,\"commitment\":\"finalized\"}]" |
      jq -r --arg c "$c" '[.meta.postTokenBalances[]? | select(.owner == $c and (.uiTokenAmount.amount | tonumber) > 0) | .mint] | first // empty' 2>/dev/null || true)
    [ -n "$LAUNCH_MINT" ] && break
  done
  return 0
}

ask_launch() { # the launch by hand (Solscan, the creator wallet's page): sets LAUNCH_MINT, LAUNCH_SIGS, LAUNCH_SLOT
  ask LAUNCH_MINT "Coin mint address (from pump.fun):"
  ask LAUNCH_SIGS "Launch signature(s), comma separated (Solscan, creator wallet page):"
  ask LAUNCH_SLOT "Slot of the last one:"
  case "$LAUNCH_SLOT" in '' | *[!0-9]*) die "the slot must be a number" ;; esac
  if [ -z "$LAUNCH_MINT" ] || [ -z "$LAUNCH_SIGS" ]; then die "the mint and the signature(s) are needed"; fi
}

preflight_launch() { # rat preflight --live --json with the launch settings, before anything changes (read-only)
  rat_json --with "COIN_MINT=$LAUNCH_MINT" --with "WATCH_FROM_SLOT=$((LAUNCH_SLOT + 1))" --with "KNOWN_OWNER_TX_SIGS=$LAUNCH_SIGS" \
    --with DRY_RUN=false --with "LIVE_CONFIRM=$LIVE_PHRASE" preflight --live --json
}
preflight_problems() { # preflight_problems json [allowed check...]: every FAIL line except the allowed checks ("" = ready)
  local j="$1"
  shift
  if [ -z "$j" ] || ! printf '%s' "$j" | jq -e '.lines | type == "array"' >/dev/null 2>&1; then
    echo "the preflight gave no answer"
    return 0
  fi
  printf '%s' "$j" | jq -r '.lines[] | select(.status == "FAIL") | select(.check as $c | $ARGS.positional | index($c) | not) | "\(.check): \(.detail)"' --args "$@"
}
preflight_pass() { # preflight_pass json check: that line is PASS
  printf '%s' "$1" | jq -e --arg k "$2" '.lines[] | select(.check == $k and .status == "PASS")' >/dev/null 2>&1
}
show_preflight() { printf '%s' "$1" | jq -r '.lines[]? | "        \(.status)  \(.check): \(.detail)"' 2>/dev/null || true; }

apply_launch() { # every launch setting in one change per service, each value read back
  set_vars worker "COIN_MINT=$LAUNCH_MINT" "WATCH_FROM_SLOT=$((LAUNCH_SLOT + 1))" "KNOWN_OWNER_TX_SIGS=$LAUNCH_SIGS" DRY_RUN=false "LIVE_CONFIRM=$LIVE_PHRASE"
  set_vars api "COIN_MINT=$LAUNCH_MINT" DRY_RUN=false
}
