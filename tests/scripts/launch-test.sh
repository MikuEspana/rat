#!/bin/bash
# scripts/launch.sh (launch day in one build) with a fake `railway`, `rat` and Solana RPC: only production, never a
# live worker, the live preflight checked WITH the coin's settings before anything changes, nothing without the exact
# word GO, then every setting in one change per service and one redeploy of both side by side. Also the read-only
# `rat --with ... preflight` in scripts/in-worker.cjs. Run: bash tests/scripts/launch-test.sh
# shellcheck disable=SC2016,SC2034 # each check is a string evaluated later (check), rc is read there
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
FAILS=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; FAILS=$((FAILS + 1)); fi; }
CREATOR=4VYWcTTDYyMVic58AcUC7Nodt6vNQwjKhA9UphaAKiot
PHRASE=I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS
mkdir -p "$W/bin" "$W/fake" "$W/home/rat-secrets"

# fake railway: variables per service in files; a redeploy starts the bot in the mode its variables say
cat >"$W/bin/railway" <<'EOF'
#!/bin/bash
F="$FAKE_DIR"
svc=""; prev=""; for a in "$@"; do [ "$prev" = --service ] && svc="$a"; prev="$a"; done
case "$1 ${2:-}" in
  "status --json") cat "$F/linked" ;;
  "variable list") cat "$F/vars-$svc.json" ;;
  "variable set")
    keys=""
    shift 2
    for a in "$@"; do
      case "$a" in --*) break ;; *=*) keys="$keys ${a%%=*}"; jq -c --arg k "${a%%=*}" --arg v "${a#*=}" '.[$k] = $v' "$F/vars-$svc.json" >"$F/v.tmp" && mv "$F/v.tmp" "$F/vars-$svc.json" ;; esac
    done
    echo "set $svc$keys" >>"$F/order.log" ;;
  "redeploy --service")
    case " $* " in *" --from-source "*) echo "redeploy $svc" >>"$F/order.log" ;; *) echo "restart $svc" >>"$F/order.log" ;; esac
    echo $(($(cat "$F/dep-$svc" 2>/dev/null || echo 0) + 1)) >"$F/dep-$svc"
    if [ "$svc" = worker ]; then
      if [ "$(jq -r .DRY_RUN "$F/vars-worker.json")" = false ]; then echo live >"$F/mode"; else echo dry_run >"$F/mode"; fi
    fi ;;
  "deployment list") [ -f "$F/commit-$svc" ] && printf '[{"status":"SUCCESS","meta":{"commitHash":"%s"}}]\n' "$(cat "$F/commit-$svc")" || echo '[]' ;;
  "service status") printf '{"status":"SUCCESS","deploymentId":"d%s"}\n' "$(cat "$F/dep-$svc" 2>/dev/null || echo 0)" ;;
  *) echo "railway $*" >>"$F/order.log" ;;
esac
EOF
# fake rat: preflight answers from files (the one with --with logged with its settings), status from the mode file
cat >"$W/bin/fake-rat" <<'EOF'
#!/bin/bash
F="$FAKE_DIR"
w=""
while [ "${1:-}" = --with ]; do w="$w $2"; shift 2; done
case "$1" in
  status) printf '{"mode":"%s","killSwitch":{"on":false}}\n' "$(cat "$F/mode")" ;;
  preflight) if [ -n "$w" ]; then echo "preflight-with$w" >>"$F/order.log"; cat "$F/pre-with.json"; else cat "$F/pre-live.json"; fi ;;
  dry-run-reset) echo "dry-run-reset" >>"$F/order.log" ;;
  *) echo "rat $*" >>"$F/order.log" ;;
esac
EOF
# fake Solana RPC behind curl (scripts/lib/wsr.sh rpc): the launch is the one signature after "sigBefore"
cat >"$W/bin/curl" <<'EOF'
#!/bin/bash
F="$FAKE_DIR"
d=""; prev=""; for a in "$@"; do [ "$prev" = -d ] && d="$a"; prev="$a"; done
cat >/dev/null # the config (the RPC URL) comes on stdin
case "$d" in
  *getBalance*) echo '{"result":{"value":300000000}}' ;;
  *getSignaturesForAddress*'"limit":1}'*) echo '{"result":[{"signature":"sigBefore","slot":900,"err":null}]}' ;;
  *getSignaturesForAddress*) cat "$F/sigs.json" ;;
  *getTransaction*'"sigRetry"'*) echo '{"result":{"meta":{"err":{"InstructionError":[0,"Custom"]},"postTokenBalances":[]}}}' ;;
  *getTransaction*) printf '{"result":{"meta":{"postTokenBalances":[{"owner":"%s","mint":"MintLaunch","uiTokenAmount":{"amount":"3500000000000"}}]}}}\n' "$CREATOR_FAKE" ;;
  *) echo '{}' ;;
esac
EOF
chmod +x "$W/bin/"*
PASS_LINES='{"lines":[{"status":"PASS","check":"launch txs","detail":"listed"},{"status":"PASS","check":"dev buy","detail":"held"},{"status":"PASS","check":"kill switch","detail":"off"}]}'
reset() {
  echo '{"id":"proj-production","name":"wall-street-rats"}' >"$W/fake/linked"
  printf 'PROFILE=production\nRAILWAY_PROJECT_ID=proj-production\n' >"$W/home/rat-secrets/setup-state.env"
  printf '{"CREATOR_PUBKEY":"%s","DRY_RUN":"true","RPC_URL":"https://rpc.invalid/?api-key=x"}\n' "$CREATOR" >"$W/fake/vars-worker.json"
  echo '{"DRY_RUN":"true"}' >"$W/fake/vars-api.json"
  echo dry_run >"$W/fake/mode"
  echo '{"result":[{"signature":"sigLaunch","slot":1000,"err":null,"blockTime":1700000000},{"signature":"sigBefore","slot":900,"err":null}]}' >"$W/fake/sigs.json"
  echo "$PASS_LINES" >"$W/fake/pre-with.json"
  echo "$PASS_LINES" >"$W/fake/pre-live.json"
  rm -f "$W/fake/order.log" "$W/fake/dep-"* "$W/fake/commit-"*
}
run() { # run "<stdin>": scripts/launch.sh with the fakes
  printf '%s' "$1" | env -i PATH="$W/bin:/usr/bin:/bin" HOME="$W/home" FAKE_DIR="$W/fake" CREATOR_FAKE="$CREATOR" WSR_RAILWAY=railway WSR_RAT=fake-rat \
    WSR_POLL_SEC=0 WSR_RETRY_SEC=0 bash "$REPO/scripts/launch.sh" >"$W/out.txt" 2>&1
}
changed() { grep -qE "^(set|redeploy|restart|dry-run-reset)" "$W/fake/order.log" 2>/dev/null; }
line() { grep -n "^$1" "$W/fake/order.log" | head -1 | cut -d: -f1; }

echo "== only production, only once"
reset
printf '\ny\nGO\n' | env -i PATH="$W/bin:/usr/bin:/bin" HOME="$W/home" FAKE_DIR="$W/fake" CREATOR_FAKE="$CREATOR" WSR_RAILWAY=railway WSR_RAT=fake-rat WSR_POLL_SEC=0 WSR_RETRY_SEC=0 bash "$REPO/scripts/launch.sh" --rehearsal >"$W/out.txt" 2>&1; rc=$?
check "--rehearsal on the production project: refused (staging guards), nothing changed" '[ $rc = 1 ] && grep -q "the rehearsal runs only on the staging project" "$W/out.txt" && ! changed'
reset
echo '{"id":"proj-staging","name":"wall-street-rats-staging"}' >"$W/fake/linked"
run $'\ny\nGO\n'; rc=$?
check "another project: refused, nothing changed" '[ $rc = 1 ] && ! changed'
reset
jq -c '.DRY_RUN = "false"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
run $'\ny\nGO\n'; rc=$?
check "a worker set to LIVE without a coin (not a launch this script started): refused" '[ $rc = 1 ] && grep -q "is set to LIVE (DRY_RUN is not true) but has no COIN_MINT" "$W/out.txt" && ! changed'
reset
jq -c '.DRY_RUN = "false" | .COIN_MINT = "MintLaunch"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
echo live >"$W/fake/mode"
run $'n\n'; rc=$?
check "a bot already running LIVE: nothing to launch, nothing changed" '[ $rc = 0 ] && grep -q "already runs LIVE" "$W/out.txt" && ! changed'
reset
jq -c '.CREATOR_PUBKEY = "CCtCZryKG3cdEFUAYPd5S1kFVhJ3mpEy2ciDqu59CvWT"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
run $'\ny\nGO\n'; rc=$?
check "another creator wallet: refused" '[ $rc = 1 ] && grep -q "not the creator wallet" "$W/out.txt" && ! changed'
reset
jq -c '.STAGING = "true"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
run $'\ny\nGO\n'; rc=$?
check "STAGING on the worker: refused" '[ $rc = 1 ] && grep -q "STAGING is on" "$W/out.txt" && ! changed'

echo "== the live preflight with the coin's settings, before anything changes"
reset
echo '{"lines":[{"status":"FAIL","check":"launch txs","detail":"1 unlisted"},{"status":"PASS","check":"dev buy","detail":"held"}]}' >"$W/fake/pre-with.json"
run $'\ny\nGO\n'; rc=$?
check "launch txs not PASS: stops before the GO, nothing changed" '[ $rc = 1 ] && grep -q "preflight launch txs is not PASS" "$W/out.txt" && ! grep -q "Type GO" "$W/out.txt" && ! changed'
reset
echo '{"lines":[{"status":"PASS","check":"launch txs","detail":"ok"},{"status":"PASS","check":"dev buy","detail":"ok"},{"status":"FAIL","check":"stocks","detail":"none approved"}]}' >"$W/fake/pre-with.json"
run $'\ny\nGO\n'; rc=$?
check "any other FAIL: stops, nothing changed" '[ $rc = 1 ] && grep -q "stocks: none approved" "$W/out.txt" && ! changed'
reset
run $'\ny\ngo\n'; rc=$?
check "anything but GO: nothing changed, still DRY RUN" '[ $rc = 1 ] && grep -q "no GO" "$W/out.txt" && ! changed && [ "$(jq -r .DRY_RUN "$W/fake/vars-worker.json")" = true ]'

echo "== GO: one change, one build"
reset
run $'\ny\nGO\n'; rc=$?
check "LIVE" '[ $rc = 0 ] && grep -q "LIVE.*the bot runs" "$W/out.txt" && [ "$(cat "$W/fake/mode")" = live ]'
check "the site is told the coin (announce-ca) right after the mint is confirmed, before any setting changes" 'grep -q "^rat announce-ca MintLaunch$" "$W/fake/order.log" && [ "$(line "rat announce-ca")" -lt "$(line "set worker")" ]'
check "the preflight saw exactly the coin's settings" 'grep -q "^preflight-with COIN_MINT=MintLaunch WATCH_FROM_SLOT=1001 KNOWN_OWNER_TX_SIGS=sigLaunch DRY_RUN=false LIVE_CONFIRM=$PHRASE$" "$W/fake/order.log"'
check "order: preflight, then the reset, then the settings, then the redeploys" '[ "$(line preflight-with)" -lt "$(line dry-run-reset)" ] && [ "$(line dry-run-reset)" -lt "$(line "set worker")" ] && [ "$(line "set api")" -lt "$(line "redeploy worker")" ]'
check "one change per service with every launch setting" '[ "$(grep -c "^set worker" "$W/fake/order.log")" = 1 ] && grep -q "^set worker COIN_MINT WATCH_FROM_SLOT KNOWN_OWNER_TX_SIGS DRY_RUN LIVE_CONFIRM CLAIM_INTERVAL_SEC$" "$W/fake/order.log" && grep -q "^set api COIN_MINT DRY_RUN LIVE_CONFIRM CLAIM_INTERVAL_SEC$" "$W/fake/order.log"'
check "one redeploy each, both started before any wait" '[ "$(grep -c "^redeploy" "$W/fake/order.log")" = 2 ] && [ "$(sed -n "$(( $(line "redeploy worker") + 1 ))p" "$W/fake/order.log")" = "redeploy api" ]'
check "the worker holds the launch settings" '[ "$(jq -r .WATCH_FROM_SLOT "$W/fake/vars-worker.json")" = 1001 ] && [ "$(jq -r .LIVE_CONFIRM "$W/fake/vars-worker.json")" = "$PHRASE" ] && [ "$(jq -r .COIN_MINT "$W/fake/vars-api.json")" = MintLaunch ]'
check "founding rats: 5 booked right after LIVE (the bot runs its coin), with the exact phrase" 'grep -q "^rat founders-seed --rats 5 --confirm FOUNDERS 5 RATS$" "$W/fake/order.log" && [ "$(line "rat founders-seed")" -gt "$(line "redeploy worker")" ]'
check "the claim loop runs every 15 s from the launch, worker and API" '[ "$(jq -r .CLAIM_INTERVAL_SEC "$W/fake/vars-worker.json")" = 15 ] && [ "$(jq -r .CLAIM_INTERVAL_SEC "$W/fake/vars-api.json")" = 15 ]'
check "the API gets LIVE_CONFIRM with DRY_RUN=false (its config refuses to start without it)" '[ "$(jq -r .DRY_RUN "$W/fake/vars-api.json")" = false ] && [ "$(jq -r .LIVE_CONFIRM "$W/fake/vars-api.json")" = "$PHRASE" ]'
reset
head=$(git -C "$REPO" rev-parse HEAD)
echo "$head" >"$W/fake/commit-worker"
echo "$head" >"$W/fake/commit-api"
run $'\ny\nGO\n'; rc=$?
check "worker and API already built from this commit: restarted with the launch settings, no build" '[ $rc = 0 ] && grep -q "^restart worker$" "$W/fake/order.log" && grep -q "^restart api$" "$W/fake/order.log" && ! grep -q "^redeploy" "$W/fake/order.log" && [ "$(cat "$W/fake/mode")" = live ]'
reset
echo 0000000000000000000000000000000000000000 >"$W/fake/commit-worker"
echo "$head" >"$W/fake/commit-api"
run $'\ny\nGO\n'; rc=$?
check "a service built from another commit is rebuilt (never an old image), the current one restarts" '[ $rc = 0 ] && grep -q "^redeploy worker$" "$W/fake/order.log" && grep -q "^restart api$" "$W/fake/order.log" && [ "$(cat "$W/fake/mode")" = live ]'
reset
run $'MintLaunch\nGO\n'; rc=$?
check "the CA pasted right after the launch: the site is told at once, the found launch matches it, no question, LIVE" '[ $rc = 0 ] && [ "$(line "rat announce-ca MintLaunch")" -lt "$(line preflight-with)" ] && [ "$(grep -c "^rat announce-ca" "$W/fake/order.log")" = 1 ] && ! grep -q "Is that your coin" "$W/out.txt" && [ "$(cat "$W/fake/mode")" = live ]'
reset
run $'OtherMint\ny\nGO\n'; rc=$?
check "a pasted CA that is not the launch found on chain: said so, and asked" '[ $rc = 0 ] && grep -q "NOT the CA you pasted" "$W/out.txt" && grep -q "^preflight-with COIN_MINT=MintLaunch " "$W/fake/order.log"'
reset
echo '{"result":[{"signature":"sigBefore","slot":900,"err":null}]}' >"$W/fake/sigs.json"
run $'\nMintByHand\nsigA,sigB\n1234\nGO\n'; rc=$?
check "no launch found on chain: typed by hand, same checks, LIVE" '[ $rc = 0 ] && grep -q "^preflight-with COIN_MINT=MintByHand WATCH_FROM_SLOT=1235 KNOWN_OWNER_TX_SIGS=sigA,sigB " "$W/fake/order.log"'

reset
# a failed retry of the launch (Phantom resends in congestion) lands after the good one: it is still the owner's
# tx, signed by the creator. Left out, it sits past the watch floor: preflight FAIL, or the kill switch once live.
echo '{"result":[{"signature":"sigRetry","slot":1003,"err":{"InstructionError":[0,"Custom"]},"blockTime":1700000009},{"signature":"sigLaunch","slot":1000,"err":null,"blockTime":1700000000},{"signature":"sigBefore","slot":900,"err":null}]}' >"$W/fake/sigs.json"
run $'\ny\nGO\n'; rc=$?
check "a failed launch retry is listed and the watch floor is after it; the mint comes from the good tx" '[ $rc = 0 ] && grep -q "^preflight-with COIN_MINT=MintLaunch WATCH_FROM_SLOT=1004 KNOWN_OWNER_TX_SIGS=sigRetry,sigLaunch " "$W/fake/order.log"'
reset
echo '{"result":[{"signature":"sigRetry","slot":1003,"err":{"InstructionError":[0,"Custom"]}},{"signature":"sigBefore","slot":900,"err":null}]}' >"$W/fake/sigs.json"
run $'\nMintByHand\nsigA\n1234\nGO\n'; rc=$?
check "only a failed tx so far: it keeps waiting for the launch, then asks by hand" 'grep -q "^preflight-with COIN_MINT=MintByHand " "$W/fake/order.log"'

echo "== rat --with: preflight only, the launch settings only"
mkdir -p "$W/pnpm"
printf '#!/bin/sh\necho "COIN_MINT=$COIN_MINT DRY_RUN=$DRY_RUN args=$*"\n' >"$W/pnpm/pnpm" && chmod +x "$W/pnpm/pnpm"
NODE_DIR=$(dirname "$(command -v node)")
inw() { printf '{"DATABASE_URL":"postgres://x","KEY_ENCRYPTION_KEY":"k","DRY_RUN":"true"}\n' | env -i PATH="$W/pnpm:$NODE_DIR:/usr/bin:/bin" RAT_SETTINGS_FROM=stdin node "$REPO/scripts/in-worker.cjs" "$@" >"$W/inw.txt" 2>&1; }
inw --with COIN_MINT=abc --with DRY_RUN=false preflight --live; rc=$?
check "preflight runs with the launch settings; --with never reaches rat" '[ $rc = 0 ] && grep -q "^COIN_MINT=abc DRY_RUN=false args=--silent --filter @rat/cli rat preflight --live$" "$W/inw.txt"'
inw --with DATABASE_URL=postgres://elsewhere preflight; rc=$?
check "any other setting: refused" '[ $rc = 2 ] && grep -q "takes only" "$W/inw.txt"'
inw --with COIN_MINT=abc sweep --to x; rc=$?
check "any command but preflight: refused" '[ $rc = 2 ] && grep -q "only for .preflight." "$W/inw.txt"'
inw status; rc=$?
check "without --with: unchanged" '[ $rc = 0 ] && grep -q "^COIN_MINT= DRY_RUN=true args=--silent --filter @rat/cli rat status$" "$W/inw.txt"'

echo "launch-test: $FAILS failed"
[ "$FAILS" = 0 ]
