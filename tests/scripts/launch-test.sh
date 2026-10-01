#!/bin/bash
# scripts/launch.sh (launch day, armed first) with a fake `railway`, `rat` and Solana RPC: only production, the bot
# ARMED before the coin exists (dry-run-reset, launch-arm, the live settings with the watch floor, one restart, the
# founding rats), nothing without the exact word GO, then the CA: launch-register with the coin found on chain, then
# the coin's settings and one more restart. Also resuming, and the read-only `rat --with ... preflight` in
# scripts/in-worker.cjs. Run: bash tests/scripts/launch-test.sh
# shellcheck disable=SC2016,SC2034 # each check is a string evaluated later (check), rc is read there
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
FAILS=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; FAILS=$((FAILS + 1)); fi; }
CREATOR=6MRpbXQruNeeXraMG3wQWodjnMYyHTrfMP3BpTLjvaeB
TEST_CREATOR=CCtCZryKG3cdEFUAYPd5S1kFVhJ3mpEy2ciDqu59CvWT
PHRASE=I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS
mkdir -p "$W/bin" "$W/fake" "$W/home/rat-secrets"

# fake railway: variables per service in files; a redeploy starts the bot in the mode its variables say
cat >"$W/bin/railway" <<'EOF2'
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
      jq -r '.COIN_MINT // ""' "$F/vars-worker.json" >"$F/loaded-coin"
    fi ;;
  "deployment list") [ -f "$F/commit-$svc" ] && printf '[{"status":"SUCCESS","meta":{"commitHash":"%s"}}]\n' "$(cat "$F/commit-$svc")" || echo '[]' ;;
  "service status") printf '{"status":"SUCCESS","deploymentId":"d%s"}\n' "$(cat "$F/dep-$svc" 2>/dev/null || echo 0)" ;;
  *) echo "railway $*" >>"$F/order.log" ;;
esac
EOF2
# fake rat: status from the mode and kill files; preflight answers from files (the one with --with logged with its
# settings; a "coin" line only once the running worker loaded COIN_MINT); the launch commands logged
cat >"$W/bin/fake-rat" <<'EOF2'
#!/bin/bash
F="$FAKE_DIR"
w=""
while [ "${1:-}" = --with ]; do w="$w $2"; shift 2; done
dec() { n=$(cat "$F/$1" 2>/dev/null || echo 0); [ "$n" -gt 0 ] || return 1; echo $((n - 1)) >"$F/$1"; }
case "$1" in
  status) printf '{"mode":"%s","killSwitch":{"on":%s}}\n' "$(cat "$F/mode")" "$(cat "$F/kill" 2>/dev/null || echo false)" ;;
  preflight)
    if [ -n "$w" ]; then
      echo "preflight-with$w" >>"$F/order.log"
      case "$w" in *COIN_MINT=*) cat "$F/pre-with.json" ;; *) cat "$F/pre-arm.json" ;; esac
    elif [ -s "$F/loaded-coin" ]; then jq -c '.lines += [{"status":"PASS","check":"coin","detail":"exists"}]' "$F/pre-live.json"
    else cat "$F/pre-live.json"; fi ;;
  dry-run-reset) echo "dry-run-reset" >>"$F/order.log" ;;
  launch-arm)
    echo "rat launch-arm" >>"$F/order.log"
    if [ -f "$F/arm_refuse" ]; then echo "launch-arm: refused: the kill switch is ON for another reason (manual)."; exit 1; fi
    [ -f "$F/arm_noop" ] || echo true >"$F/kill"
    echo "launch-arm: armed: the kill switch is ON until launch-register (30 minutes)." ;;
  launch-register)
    echo "rat $*" >>"$F/order.log"
    if dec register_fail; then echo "launch-register: refused: $2 is not readable on chain yet."; exit 1; fi
    if [ -f "$F/register_keepkill" ]; then echo "launch-register: registered $2; the kill switch stays ON (reason: manual): rat resume when ready."; exit 0; fi
    echo false >"$F/kill"
    echo "launch-register: registered $2; kill switch released: hires start in the next loop." ;;
  resume) echo "rat resume" >>"$F/order.log"; echo false >"$F/kill" ;;
  founders-seed) echo "rat $*" >>"$F/order.log"; [ ! -f "$F/founders_fail" ] || exit 1 ;;
  *) echo "rat $*" >>"$F/order.log" ;;
esac
EOF2
# fake Solana RPC behind curl (scripts/lib/wsr.sh rpc): the launch is the one signature after "sigBefore"
cat >"$W/bin/curl" <<'EOF2'
#!/bin/bash
F="$FAKE_DIR"
d=""; prev=""; for a in "$@"; do [ "$prev" = -d ] && d="$a"; prev="$a"; done
cat >/dev/null # the config (the RPC URL) comes on stdin
# "flaky-N": the next N answers are a rate limit page, not JSON
n=$(cat "$F/flaky" 2>/dev/null || echo 0)
if [ "$n" -gt 0 ]; then echo $((n - 1)) >"$F/flaky"; echo 'Too Many Requests'; exit 0; fi
case "$d" in
  *getSlot*) echo '{"result":5000}' ;;
  *getBalance*) echo '{"result":{"value":300000000}}' ;;
  *getSignaturesForAddress*'"limit":1}'*) echo '{"result":[{"signature":"sigBefore","slot":900,"err":null}]}' ;;
  *getSignaturesForAddress*) cat "$F/sigs.json" ;;
  *getTransaction*'"sigRetry"'*) echo '{"result":{"meta":{"err":{"InstructionError":[0,"Custom"]},"postTokenBalances":[]}}}' ;;
  *getTransaction*) printf '{"result":{"meta":{"postTokenBalances":[{"owner":"%s","mint":"MintLaunch","uiTokenAmount":{"amount":"3500000000000"}}]}}}\n' "$CREATOR_FAKE" ;;
  *) echo '{}' ;;
esac
EOF2
chmod +x "$W/bin/"*
PASS_LINES='{"lines":[{"status":"PASS","check":"launch txs","detail":"listed"},{"status":"PASS","check":"dev buy","detail":"held"},{"status":"PASS","check":"kill switch","detail":"off"}]}'
# before the coin: COIN_MINT missing, no watch floor, the kill switch ON (staging) are expected
ARM_LINES='{"lines":[{"status":"PASS","check":"mode","detail":"LIVE"},{"status":"FAIL","check":"settings","detail":"missing: COIN_MINT (see .env.example)."},{"status":"PASS","check":"stocks","detail":"3 approved"},{"status":"FAIL","check":"watch floor","detail":"WATCH_FROM_SLOT not set"},{"status":"FAIL","check":"kill switch","detail":"ON"}]}'
reset() {
  echo '{"id":"proj-production","name":"wall-street-rats"}' >"$W/fake/linked"
  rm -rf "$W/home/rat-secrets-staging"
  rm -f "$W/home/rat-secrets/"*
  printf 'PROFILE=production\nRAILWAY_PROJECT_ID=proj-production\n' >"$W/home/rat-secrets/setup-state.env"
  printf '{"CREATOR_PUBKEY":"%s","DRY_RUN":"true","RPC_URL":"https://rpc.invalid/?api-key=x"}\n' "$CREATOR" >"$W/fake/vars-worker.json"
  echo '{"DRY_RUN":"true"}' >"$W/fake/vars-api.json"
  echo dry_run >"$W/fake/mode"
  echo false >"$W/fake/kill"
  echo '{"result":[{"signature":"sigLaunch","slot":1000,"err":null,"blockTime":1700000000},{"signature":"sigBefore","slot":900,"err":null}]}' >"$W/fake/sigs.json"
  echo "$PASS_LINES" >"$W/fake/pre-with.json"
  echo "$PASS_LINES" >"$W/fake/pre-live.json"
  echo "$ARM_LINES" >"$W/fake/pre-arm.json"
  rm -f "$W/fake/order.log" "$W/fake/dep-"* "$W/fake/commit-"* "$W/fake/flaky" "$W/fake/register_fail" "$W/fake/founders_fail" "$W/fake/arm_noop" "$W/fake/loaded-coin" "$W/fake/arm_refuse" "$W/fake/register_keepkill"
}
armed() { # the worker as an earlier run left it: armed, LIVE, kill switch ON, no coin
  jq -c --arg p "$PHRASE" '.DRY_RUN = "false" | .LIVE_CONFIRM = $p | .CLAIM_INTERVAL_SEC = "15" | .WATCH_FROM_SLOT = "5001"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
  jq -c --arg p "$PHRASE" '.DRY_RUN = "false" | .LIVE_CONFIRM = $p | .CLAIM_INTERVAL_SEC = "15"' "$W/fake/vars-api.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-api.json"
  echo live >"$W/fake/mode"
  echo true >"$W/fake/kill"
}
run() { # run "<stdin>" [--rehearsal]: scripts/launch.sh with the fakes
  printf '%s' "$1" | env -i PATH="$W/bin:/usr/bin:/bin" HOME="$W/home" FAKE_DIR="$W/fake" CREATOR_FAKE="${CFAKE:-$CREATOR}" WSR_RAILWAY=railway WSR_RAT=fake-rat \
    WSR_POLL_SEC=0 WSR_RETRY_SEC=0 WSR_FOUNDING_RATS="${FOUNDERS:-5}" bash "$REPO/scripts/launch.sh" "${@:2}" >"$W/out.txt" 2>&1
}
changed() { grep -qE "^(set|redeploy|restart|dry-run-reset|rat launch-arm|rat launch-register|rat resume|rat founders-seed)" "$W/fake/order.log" 2>/dev/null; }
line() { grep -n "^$1" "$W/fake/order.log" | head -1 | cut -d: -f1; }
lastline() { grep -n "^$1" "$W/fake/order.log" | tail -1 | cut -d: -f1; }
outline() { grep -n "$1" "$W/out.txt" | head -1 | cut -d: -f1; }
ARM_SET="^set worker DRY_RUN LIVE_CONFIRM CLAIM_INTERVAL_SEC WATCH_FROM_SLOT$"

echo "== only production"
reset
CFAKE=$TEST_CREATOR run $'GO\nMintLaunch\n' --rehearsal; rc=$?
check "--rehearsal on the production project: refused (staging guards), nothing changed" '[ $rc = 1 ] && grep -q "the rehearsal runs only on the staging project" "$W/out.txt" && ! changed'
reset
echo '{"id":"proj-staging","name":"wall-street-rats-staging"}' >"$W/fake/linked"
run $'GO\nMintLaunch\n'; rc=$?
check "another project: refused, nothing changed" '[ $rc = 1 ] && ! changed'
reset
jq -c '.CREATOR_PUBKEY = "CCtCZryKG3cdEFUAYPd5S1kFVhJ3mpEy2ciDqu59CvWT"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
run $'GO\nMintLaunch\n'; rc=$?
check "another creator wallet: refused" '[ $rc = 1 ] && grep -q "not the creator wallet" "$W/out.txt" && ! changed'
reset
jq -c '.STAGING = "true"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
run $'GO\nMintLaunch\n'; rc=$?
check "STAGING on the worker: refused" '[ $rc = 1 ] && grep -q "STAGING is on" "$W/out.txt" && ! changed'
reset
jq -c '.DRY_RUN = "false"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
run $'GO\nMintLaunch\n'; rc=$?
check "a worker set to LIVE without a coin, not armed by this script: refused" '[ $rc = 1 ] && grep -q "is set to LIVE (DRY_RUN is not true) but has no COIN_MINT" "$W/out.txt" && ! changed'
reset
jq -c '.DRY_RUN = "false" | .COIN_MINT = "MintLaunch"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
echo live >"$W/fake/mode"
echo MintLaunch >"$W/fake/loaded-coin"
run $'n\n'; rc=$?
check "a bot already running LIVE with its coin: nothing to launch, nothing changed" '[ $rc = 0 ] && grep -q "already runs LIVE" "$W/out.txt" && ! changed'
rm -f "$W/fake/loaded-coin"
run $'y\n'; rc=$?
check "LIVE with COIN_MINT set but the running worker never loaded it: offers the last restart" '[ $rc = 0 ] && grep -q "has not loaded the coin yet" "$W/out.txt" && [ "$(grep -c "^redeploy" "$W/fake/order.log")" = 2 ] && ! grep -q "^rat launch" "$W/fake/order.log"'

echo "== the arm: preflight first, nothing without GO"
reset
echo '{"lines":[{"status":"FAIL","check":"settings","detail":"missing: COIN_MINT (see .env.example)."},{"status":"FAIL","check":"stocks","detail":"none approved"}]}' >"$W/fake/pre-arm.json"
run $'GO\nMintLaunch\n'; rc=$?
check "a FAIL not expected before the coin (stocks): stops before the GO, nothing changed" '[ $rc = 1 ] && grep -q "stocks: none approved" "$W/out.txt" && ! grep -q "Type GO" "$W/out.txt" && ! changed'
reset
echo '{"lines":[{"status":"FAIL","check":"settings","detail":"missing: COIN_MINT, JUPITER_API_KEY (see .env.example)."}]}' >"$W/fake/pre-arm.json"
run $'GO\nMintLaunch\n'; rc=$?
check "a missing setting other than COIN_MINT: stops, nothing changed" '[ $rc = 1 ] && grep -q "JUPITER_API_KEY" "$W/out.txt" && ! changed'
reset
run $'go\n'; rc=$?
check "anything but GO: nothing changed, still DRY RUN" '[ $rc = 1 ] && grep -q "no GO" "$W/out.txt" && grep -q "THIS ARMS THE BOT LIVE" "$W/out.txt" && ! changed && [ "$(jq -r .DRY_RUN "$W/fake/vars-worker.json")" = true ]'
check "the arm preflight is the live one, read-only, without a coin" 'grep -q "^preflight-with DRY_RUN=false LIVE_CONFIRM=$PHRASE$" "$W/fake/order.log"'
reset
echo 99 >"$W/fake/flaky"
run $'GO\nMintLaunch\n'; rc=$?
check "the RPC never answers: stops with a message, nothing changed" '[ $rc = 1 ] && grep -q "could not read the creator wallet" "$W/out.txt" && ! changed'

echo "== GO: armed, then the CA, then register, then the coin's settings"
reset
run $'GO\nMintLaunch\n'; rc=$?
check "LIVE with its coin" '[ $rc = 0 ] && grep -q "LIVE.*the bot runs" "$W/out.txt" && [ "$(cat "$W/fake/mode")" = live ] && [ "$(cat "$W/fake/kill")" = false ]'
check "the arm, in order: dry-run-reset, launch-arm, the worker, the API, the restart, the founding rats" '[ "$(line dry-run-reset)" -lt "$(line "rat launch-arm")" ] && [ "$(line "rat launch-arm")" -lt "$(line "set worker")" ] && [ "$(line "set worker")" -lt "$(line "set api")" ] && [ "$(line "set api")" -lt "$(line "redeploy worker")" ] && [ "$(line "redeploy worker")" -lt "$(line "rat founders-seed")" ]'
check "the worker armed in ONE change (DRY_RUN LIVE_CONFIRM CLAIM_INTERVAL_SEC WATCH_FROM_SLOT = current slot + 1), the API too" 'grep -q "$ARM_SET" "$W/fake/order.log" && [ "$(line "set worker")" = "$(grep -n "$ARM_SET" "$W/fake/order.log" | cut -d: -f1)" ] && grep -q "^set api DRY_RUN LIVE_CONFIRM CLAIM_INTERVAL_SEC$" "$W/fake/order.log" && [ "$(jq -r .WATCH_FROM_SLOT "$W/fake/vars-worker.json")" = 5001 ]'
check "both restarted side by side for the arm" '[ "$(sed -n "$(( $(line "redeploy worker") + 1 ))p" "$W/fake/order.log")" = "redeploy api" ]'
check "founding rats: 5, with the exact phrase, before the CA" 'grep -q "^rat founders-seed --rats 5 --confirm FOUNDERS 5 RATS$" "$W/fake/order.log" && [ "$(line "rat founders-seed")" -lt "$(line "rat launch-register")" ] && grep -q "ARMED.*kill switch on, 5 founding rats funded" "$W/out.txt"'
check "the arm happens BEFORE the CA prompt" '[ "$(outline "ARMED")" -lt "$(outline "Paste the CA")" ] && [ "$(outline "Type GO to arm")" -lt "$(outline "Paste the CA")" ]'
check "the pasted CA matches the launch found on chain: no question, registered with its sigs" '! grep -q "Is that your coin" "$W/out.txt" && grep -q "^rat launch-register MintLaunch --sigs sigLaunch$" "$W/fake/order.log" && [ "$(grep -c "^rat launch-register" "$W/fake/order.log")" = 1 ] && grep -q "LIVE: the CA is on the site" "$W/out.txt"'
check "after the register: the coin into the worker (COIN_MINT KNOWN_OWNER_TX_SIGS) and the API, then one restart" '[ "$(line "rat launch-register")" -lt "$(line "set worker COIN_MINT")" ] && grep -q "^set worker COIN_MINT KNOWN_OWNER_TX_SIGS$" "$W/fake/order.log" && grep -q "^set api COIN_MINT$" "$W/fake/order.log" && [ "$(lastline "redeploy worker")" -gt "$(line "set api COIN_MINT")" ] && [ "$(grep -c "^redeploy" "$W/fake/order.log")" = 4 ]'
check "the worker keeps the watch floor of the arm and holds the coin" '[ "$(jq -r .WATCH_FROM_SLOT "$W/fake/vars-worker.json")" = 5001 ] && [ "$(jq -r .KNOWN_OWNER_TX_SIGS "$W/fake/vars-worker.json")" = sigLaunch ] && [ "$(jq -r .COIN_MINT "$W/fake/vars-api.json")" = MintLaunch ] && [ "$(jq -r .LIVE_CONFIRM "$W/fake/vars-api.json")" = "$PHRASE" ] && [ "$(jq -r .CLAIM_INTERVAL_SEC "$W/fake/vars-api.json")" = 15 ]'
check "never the old one-shot path or the fallback announce-ca" '! grep -q "^preflight-with COIN_MINT" "$W/fake/order.log" && ! grep -q "^rat announce-ca" "$W/fake/order.log" && ! grep -q "^rat resume" "$W/fake/order.log"'
reset
run $'GO\nOtherMint\ny\n'; rc=$?
check "a pasted CA that is not the launch found on chain: said so, and asked" '[ $rc = 0 ] && grep -q "NOT the CA you pasted" "$W/out.txt" && grep -q "Is that your coin" "$W/out.txt" && grep -q "^rat launch-register MintLaunch --sigs sigLaunch$" "$W/fake/order.log"'
reset
run $'GO\nOtherMint\nn\nMintByHand\nsigA\n1234\n'; rc=$?
check "not your coin: typed by hand, registered with that" '[ $rc = 0 ] && grep -q "^rat launch-register MintByHand --sigs sigA$" "$W/fake/order.log"'
reset
echo '{"result":[{"signature":"sigBefore","slot":900,"err":null}]}' >"$W/fake/sigs.json"
run $'GO\n\nMintByHand\nsigA,sigB\n1234\n'; rc=$?
check "no launch found on chain: typed by hand, registered, LIVE" '[ $rc = 0 ] && grep -q "^rat launch-register MintByHand --sigs sigA,sigB$" "$W/fake/order.log" && [ "$(jq -r .KNOWN_OWNER_TX_SIGS "$W/fake/vars-worker.json")" = sigA,sigB ]'
reset
# a failed retry of the launch (Phantom resends in congestion) lands after the good one: it is still the owner's tx
echo '{"result":[{"signature":"sigRetry","slot":1003,"err":{"InstructionError":[0,"Custom"]},"blockTime":1700000009},{"signature":"sigLaunch","slot":1000,"err":null,"blockTime":1700000000},{"signature":"sigBefore","slot":900,"err":null}]}' >"$W/fake/sigs.json"
run $'GO\nMintLaunch\n'; rc=$?
check "a failed launch retry is registered and listed too; the mint comes from the good tx" '[ $rc = 0 ] && grep -q "^rat launch-register MintLaunch --sigs sigRetry,sigLaunch$" "$W/fake/order.log" && [ "$(jq -r .KNOWN_OWNER_TX_SIGS "$W/fake/vars-worker.json")" = sigRetry,sigLaunch ]'
reset
head=$(git -C "$REPO" rev-parse HEAD)
echo "$head" >"$W/fake/commit-worker"
echo "$head" >"$W/fake/commit-api"
run $'GO\nMintLaunch\n'; rc=$?
check "worker and API already built from this commit: restarted (no build), for the arm and the finish" '[ $rc = 0 ] && [ "$(grep -c "^restart worker$" "$W/fake/order.log")" = 2 ] && [ "$(grep -c "^restart api$" "$W/fake/order.log")" = 2 ] && ! grep -q "^redeploy" "$W/fake/order.log"'
reset
echo 2 >"$W/fake/flaky"
run $'GO\nMintLaunch\n'; rc=$?
check "the RPC answers a rate limit page twice: retried, the launch goes on (no silent stop)" '[ $rc = 0 ] && [ "$(cat "$W/fake/mode")" = live ] && grep -q "^rat launch-register MintLaunch" "$W/fake/order.log"'
reset
FOUNDERS=0 run $'GO\nMintLaunch\n'; rc=$?
check "WSR_FOUNDING_RATS=0: no founding rats, the rest as usual" '[ $rc = 0 ] && ! grep -q "^rat founders-seed" "$W/fake/order.log" && grep -q "0 founding rats funded" "$W/out.txt" && grep -q "^rat launch-register" "$W/fake/order.log"'
reset
touch "$W/fake/founders_fail"
run $'GO\nMintLaunch\n'; rc=$?
check "the founding rats refused: a note, never a stop" '[ $rc = 0 ] && grep -q "founding rats were not booked" "$W/out.txt" && grep -q "^rat launch-register" "$W/fake/order.log"'
reset
touch "$W/fake/arm_noop"
run $'GO\nMintLaunch\n'; rc=$?
check "LIVE but the kill switch is off before the coin: stops before the CA" '[ $rc = 1 ] && grep -q "kill switch is OFF before the coin exists" "$W/out.txt" && ! grep -q "Paste the CA" "$W/out.txt" && ! grep -q "^rat launch-register" "$W/fake/order.log"'

reset
touch "$W/fake/arm_refuse"
run $'GO\nMintLaunch\n'; rc=$?
check "launch-arm refused (the kill switch ON for another reason): stops with its message, nothing on Railway" '[ $rc = 1 ] && grep -q "launch-arm refused" "$W/out.txt" && grep -q "ON for another reason" "$W/out.txt" && ! grep -q "^set\|^redeploy\|^restart" "$W/fake/order.log"'
reset
run $'GO\nMintLaunch\n'; rc=$?
check "launch-arm's own line is shown" 'grep -q "launch-arm: armed:" "$W/out.txt"'

echo "== launch-register refused, and resuming"
reset
touch "$W/fake/register_keepkill"
run $'GO\nMintLaunch\n'; rc=$?
check "registered but the kill switch left ON: stops with that line and how to fix, never called LIVE, no coin settings" '[ $rc = 1 ] && grep -q "registered but the kill switch is still ON" "$W/out.txt" && grep -q "the kill switch stays ON (reason: manual)" "$W/out.txt" && grep -q "scripts/rat.sh resume" "$W/out.txt" && ! grep -q "LIVE: the CA is on the site" "$W/out.txt" && [ "$(grep -c "^rat launch-register" "$W/fake/order.log")" = 1 ] && ! grep -q "^set worker COIN_MINT" "$W/fake/order.log"' 
reset
echo 5 >"$W/fake/register_fail"
run $'GO\nMintLaunch\n'; rc=$?
check "launch-register refused 5 times: stops with how to retry, the bot stays armed, no coin settings" '[ $rc = 1 ] && [ "$(grep -c "^rat launch-register" "$W/fake/order.log")" = 5 ] && grep -q "launch-register refused the coin MintLaunch" "$W/out.txt" && grep -q "not readable on chain yet" "$W/out.txt" && grep -q "Run scripts/launch.sh again" "$W/out.txt" && ! grep -q "^set worker COIN_MINT" "$W/fake/order.log" && [ "$(cat "$W/fake/kill")" = true ]'
: >"$W/fake/order.log"
run $'y\n'; rc=$?
check "run again: it keeps the coin (asked), registers it, finishes; never arms or asks for the launch again" '[ $rc = 0 ] && grep -q "The last run found your coin MintLaunch" "$W/out.txt" && ! grep -q "Now create the coin" "$W/out.txt" && ! grep -q "^rat launch-arm\|^dry-run-reset" "$W/fake/order.log" && grep -q "^rat launch-register MintLaunch --sigs sigLaunch$" "$W/fake/order.log" && grep -q "^set worker COIN_MINT KNOWN_OWNER_TX_SIGS$" "$W/fake/order.log" && grep -q "LIVE.*the bot runs" "$W/out.txt"'
reset
echo 1 >"$W/fake/register_fail"
run $'GO\nMintLaunch\n'; rc=$?
check "launch-register refused once (the coin not readable yet): retried, LIVE" '[ $rc = 0 ] && [ "$(grep -c "^rat launch-register" "$W/fake/order.log")" = 2 ] && grep -q "LIVE.*the bot runs" "$W/out.txt"'
reset
armed
run $'n\nMintLaunch\n'; rc=$?
check "resume when armed, coin not created yet: armed again (a new window), the launch, register, finish; no new arm settings" '[ $rc = 0 ] && grep -q "already ARMED" "$W/out.txt" && [ "$(grep -c "^rat launch-arm" "$W/fake/order.log")" = 1 ] && ! grep -q "^dry-run-reset\|$ARM_SET\|^rat founders-seed" "$W/fake/order.log" && grep -q "^rat launch-register MintLaunch --sigs sigLaunch$" "$W/fake/order.log" && grep -q "^set worker COIN_MINT KNOWN_OWNER_TX_SIGS$" "$W/fake/order.log" && [ "$(jq -r .WATCH_FROM_SLOT "$W/fake/vars-worker.json")" = 5001 ]'
reset
armed
jq -c '.WATCH_FROM_SLOT = "950"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
run $'y\nMintLaunch\n'; rc=$?
check "resume when armed, coin already created: found from the watch floor on, registered, finished" '[ $rc = 0 ] && ! grep -q "^rat launch-arm" "$W/fake/order.log" && grep -q "^rat launch-register MintLaunch --sigs sigLaunch$" "$W/fake/order.log" && grep -q "LIVE.*the bot runs" "$W/out.txt"'
reset
armed
echo dry_run >"$W/fake/mode"
echo false >"$W/fake/kill"
run $'GO\nMintLaunch\n'; rc=$?
check "an arm that stopped before its restart (live settings, DRY RUN bot): armed again, then LIVE" '[ $rc = 0 ] && grep -q "arming again" "$W/out.txt" && grep -q "^rat launch-arm" "$W/fake/order.log" && grep -q "^rat launch-register MintLaunch" "$W/fake/order.log"'
reset
jq -c '.COIN_MINT = "MintLaunch" | .WATCH_FROM_SLOT = "1001" | .KNOWN_OWNER_TX_SIGS = "sigLaunch"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
run $'y\nGO\n'; rc=$?
check "a coin set on a DRY RUN worker by an older run: finished as before (preflight with the coin, GO, one change, LIVE)" '[ $rc = 0 ] && grep -q "^preflight-with COIN_MINT=MintLaunch WATCH_FROM_SLOT=1001 KNOWN_OWNER_TX_SIGS=sigLaunch DRY_RUN=false LIVE_CONFIRM=$PHRASE$" "$W/fake/order.log" && grep -q "^set worker COIN_MINT WATCH_FROM_SLOT KNOWN_OWNER_TX_SIGS DRY_RUN LIVE_CONFIRM CLAIM_INTERVAL_SEC$" "$W/fake/order.log" && [ "$(cat "$W/fake/mode")" = live ] && ! grep -q "^rat launch-arm" "$W/fake/order.log"'

echo "== --rehearsal on the staging project"
reset
echo '{"id":"proj-staging","name":"wall-street-rats-staging"}' >"$W/fake/linked"
mkdir -p "$W/home/rat-secrets-staging"
printf 'PROFILE=staging\nRAILWAY_PROJECT_ID=proj-staging\n' >"$W/home/rat-secrets-staging/setup-state.env"
jq -c --arg c "$TEST_CREATOR" '.CREATOR_PUBKEY = $c | .STAGING = "true"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
echo true >"$W/fake/kill"
CFAKE=$TEST_CREATOR run $'GO\nMintLaunch\n' --rehearsal; rc=$?
check "the same flow; the staging kill switch released right before launch-arm; launch-register releases the armed one" '[ $rc = 0 ] && [ "$(line "rat resume")" -lt "$(line "rat launch-arm")" ] && [ "$(line dry-run-reset)" -lt "$(line "rat resume")" ] && [ "$(grep -c "^rat resume" "$W/fake/order.log")" = 1 ] && grep -q "^rat launch-register MintLaunch" "$W/fake/order.log" && [ "$(cat "$W/fake/kill")" = false ] && grep -q "LIVE.*the bot runs" "$W/out.txt"'

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
