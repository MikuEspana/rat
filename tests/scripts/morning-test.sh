#!/bin/bash
# scripts/morning.sh (the morning checks, GO or WAIT) with a fake `railway`, `rat`, `git` and status page: GO only when
# every check passes; each problem is its own WAIT line with the fix; the wrong folder stops at once; it never changes
# anything on Railway. Run: bash tests/scripts/morning-test.sh
# shellcheck disable=SC2016,SC2034 # each check is a string evaluated later (check), rc is read there
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
FAILS=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; FAILS=$((FAILS + 1)); fi; }
CREATOR=DMCYiQzy5QoaARhVxFp9uwShBwm1BwbGX564neFvvZs1
mkdir -p "$W/bin" "$W/fake" "$W/home/rat-secrets"

# fake railway: read-only answers from files; anything else is logged (a write would show up in order.log)
cat >"$W/bin/railway" <<'EOF'
#!/bin/bash
F="$FAKE_DIR"
svc=""; prev=""; for a in "$@"; do [ "$prev" = --service ] && svc="$a"; prev="$a"; done
case "$1 ${2:-}" in
  "status --json") cat "$F/linked" ;;
  "variable list") cat "$F/vars-$svc.json" ;;
  "service status") printf '{"status":"%s","deploymentId":"d1"}\n' "$(cat "$F/svc-$svc" 2>/dev/null || echo SUCCESS)" ;;
  *) echo "railway $*" >>"$F/order.log" ;;
esac
EOF
cat >"$W/bin/fake-rat" <<'EOF'
#!/bin/bash
F="$FAKE_DIR"
case "$1" in
  status) cat "$F/status.json" ;;
  preflight) cat "$F/pre.json" ;;
  *) echo "rat $*" >>"$F/order.log" ;;
esac
EOF
cat >"$W/bin/fake-git" <<'EOF'
#!/bin/bash
case "$1" in
  fetch) [ "$(cat "$FAKE_DIR/git-fetch")" = ok ] ;;
  rev-list) cat "$FAKE_DIR/git-behind" ;;
  *) echo "git $*" >>"$FAKE_DIR/order.log" ;;
esac
EOF
chmod +x "$W/bin/"*
UP='{"page":{"name":"Railway","url":"https://status.railway.com","status":"UP"},"activeIncidents":[],"activeMaintenances":[]}'
PRE_OK='{"lines":[{"status":"FAIL","check":"settings","detail":"missing: COIN_MINT (see .env.example)."},{"status":"FAIL","check":"creator wallet","detail":"0.01 SOL, below the 0.05 SOL reserve"},{"status":"PASS","check":"stocks","detail":"10 approved"}]}'
reset() {
  echo '{"id":"proj-production","name":"wall-street-rats"}' >"$W/fake/linked"
  printf 'PROFILE=production\nRAILWAY_PROJECT_ID=proj-production\n' >"$W/home/rat-secrets/setup-state.env"
  printf '{"CREATOR_PUBKEY":"%s","DRY_RUN":"true","RPC_URL":"https://rpc.invalid/?api-key=secretkey"}\n' "$CREATOR" >"$W/fake/vars-worker.json"
  echo '{"DRY_RUN":"true"}' >"$W/fake/vars-api.json"
  echo '{"mode":"dry_run","killSwitch":{"on":false,"reason":null},"loops":[{"loop":"claim","ageSec":12},{"loop":"prices","ageSec":30}]}' >"$W/fake/status.json"
  echo "$PRE_OK" >"$W/fake/pre.json"
  echo "$UP" >"$W/fake/summary.json"
  echo ok >"$W/fake/git-fetch"
  echo 0 >"$W/fake/git-behind"
  rm -f "$W/fake/order.log" "$W/fake/svc-"*
}
run() { # run "<answer to the banner question>": scripts/morning.sh with the fakes
  printf '%s\n' "$1" | env -i PATH="$W/bin:/usr/bin:/bin" HOME="$W/home" FAKE_DIR="$W/fake" WSR_RAILWAY=railway WSR_RAT=fake-rat \
    WSR_GIT=fake-git WSR_STATUS_URL="file://$W/fake/summary.json" WSR_RETRY_SEC=0 bash "$REPO/scripts/morning.sh" >"$W/out.txt" 2>&1
}
waits() { grep -c "WAIT  " "$W/out.txt"; }
wrote() { [ -s "$W/fake/order.log" ]; }

echo "== GO"
reset
run y; rc=$?
check "everything fine (only the expected pre-launch FAILs): GO, exit 0" '[ $rc = 0 ] && grep -q "GO  Everything checked" "$W/out.txt" && [ "$(waits)" = 0 ]'
check "read-only: nothing written to Railway, nothing run in the worker but status and preflight" '! wrote'
check "the RPC key is never printed" '! grep -q secretkey "$W/out.txt"'

echo "== each problem is one WAIT line"
reset
echo '{"page":{"status":"HASISSUES"},"activeIncidents":[{"name":"Deploys delayed in us-west"}],"activeMaintenances":[]}' >"$W/fake/summary.json"
run y; rc=$?
check "a Railway incident: WAIT naming it, exit 1" '[ $rc = 1 ] && grep -q "status.railway.com: HASISSUES (Deploys delayed in us-west)" "$W/out.txt" && [ "$(waits)" = 2 ]'
reset
echo 'not json' >"$W/fake/summary.json"
run y; rc=$?
check "status page unreadable: WAIT, open it yourself" '[ $rc = 1 ] && grep -q "could not read status.railway.com" "$W/out.txt"'
reset
run n; rc=$?
check "the Limited Access banner still there: WAIT" '[ $rc = 1 ] && grep -q "deploys may still be paused" "$W/out.txt" && [ "$(waits)" = 2 ]'
reset
run ""; rc=$?
check "no answer to the banner question counts as not gone" '[ $rc = 1 ] && grep -q "deploys may still be paused" "$W/out.txt"'
reset
echo BUILDING >"$W/fake/svc-api"
run y; rc=$?
check "api still building: WAIT" '[ $rc = 1 ] && grep -q "api: not running yet (BUILDING)" "$W/out.txt"'
reset
echo CRASHED >"$W/fake/svc-worker"
run y; rc=$?
check "worker crashed: WAIT with where to look" '[ $rc = 1 ] && grep -q "worker: its latest deployment is CRASHED" "$W/out.txt"'
reset
jq -c '.DRY_RUN = "false"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
run y; rc=$?
check "production worker not in DRY RUN before the launch: WAIT" '[ $rc = 1 ] && grep -q "NOT in DRY RUN before the launch" "$W/out.txt"'
reset
jq -c '.LIVE_CONFIRM = "I_UNDERSTAND"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
run y; rc=$?
check "LIVE_CONFIRM set before the launch: WAIT" '[ $rc = 1 ] && grep -q "LIVE_CONFIRM set" "$W/out.txt"'
reset
echo '{"DRY_RUN":"false"}' >"$W/fake/vars-api.json"
run y; rc=$?
check "API set to live before the launch: WAIT" '[ $rc = 1 ] && grep -q "the API says DRY_RUN=false" "$W/out.txt"'
reset
echo '{"mode":"live","killSwitch":{"on":false},"loops":[{"loop":"claim","ageSec":3}]}' >"$W/fake/status.json"
run y; rc=$?
check "the running worker is live: WAIT" '[ $rc = 1 ] && grep -q "says mode live, not dry_run" "$W/out.txt"'
reset
echo '{"mode":"dry_run","killSwitch":{"on":false},"loops":[{"loop":"claim","ageSec":900},{"loop":"prices","ageSec":20}]}' >"$W/fake/status.json"
run y; rc=$?
check "a loop 15 minutes old: WAIT naming it" '[ $rc = 1 ] && grep -q "worker loops not running: claim 900s old" "$W/out.txt"'
reset
echo '{"mode":"dry_run","killSwitch":{"on":false},"loops":[{"loop":"claim","ageSec":8},{"loop":"coin","ageSec":548}]}' >"$W/fake/status.json"
run y; rc=$?
check "the coin check 548 s old (it runs every 10 min): on time, GO" '[ $rc = 0 ] && grep -q "GO  Everything checked" "$W/out.txt"'
reset
echo '{"mode":"dry_run","killSwitch":{"on":false},"loops":[{"loop":"claim","ageSec":8},{"loop":"coin","ageSec":1500}]}' >"$W/fake/status.json"
run y; rc=$?
check "the coin check 25 min old: WAIT naming it" '[ $rc = 1 ] && grep -q "worker loops not running: coin 1500s old" "$W/out.txt"'
reset
: >"$W/fake/status.json"
run y; rc=$?
check "the worker does not answer (railway ssh): WAIT" '[ $rc = 1 ] && grep -q "the running worker did not answer" "$W/out.txt"'
reset
echo '{"lines":[{"status":"FAIL","check":"settings","detail":"missing: COIN_MINT (see .env.example)."},{"status":"FAIL","check":"rpc","detail":"no answer from RPC_URL"}]}' >"$W/fake/pre.json"
run y; rc=$?
check "a real preflight FAIL: WAIT listing it (the expected pre-launch one is not)" '[ $rc = 1 ] && grep -q "rpc: no answer from RPC_URL" "$W/out.txt" && ! grep -q "settings: missing: COIN_MINT" "$W/out.txt"'
reset
echo 3 >"$W/fake/git-behind"
run y; rc=$?
check "scripts behind main: WAIT, git pull" '[ $rc = 1 ] && grep -q "3 commit(s) behind main" "$W/out.txt"'
reset
echo fail >"$W/fake/git-fetch"
run y; rc=$?
check "GitHub unreachable: only a note, still GO" '[ $rc = 0 ] && grep -q "could not reach GitHub" "$W/out.txt"'
reset
echo '{"mode":"dry_run","killSwitch":{"on":true,"reason":"manual"},"loops":[{"loop":"claim","ageSec":5}]}' >"$W/fake/status.json"
run y; rc=$?
check "kill switch on before the launch: a note, still GO" '[ $rc = 0 ] && grep -q "kill switch is ON (manual)" "$W/out.txt"'
reset
echo BUILDING >"$W/fake/svc-api"
run n; rc=$?
check "two problems: two WAIT lines and the count" '[ $rc = 1 ] && [ "$(waits)" = 3 ] && grep -q "2 item(s) above" "$W/out.txt"'

echo "== the wrong folder stops at once"
reset
echo '{"id":"proj-staging","name":"wall-street-rats-staging"}' >"$W/fake/linked"
run y; rc=$?
check "another project: stopped" '[ $rc = 1 ] && grep -q "STOPPED" "$W/out.txt" && ! grep -q "GO  " "$W/out.txt"'
reset
jq -c '.STAGING = "true"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
run y; rc=$?
check "a STAGING worker: stopped" '[ $rc = 1 ] && grep -q "STAGING is on" "$W/out.txt"'
reset
jq -c '.CREATOR_PUBKEY = "CCtCZryKG3cdEFUAYPd5S1kFVhJ3mpEy2ciDqu59CvWT"' "$W/fake/vars-worker.json" >"$W/fake/x" && mv "$W/fake/x" "$W/fake/vars-worker.json"
run y; rc=$?
check "another creator wallet: stopped" '[ $rc = 1 ] && grep -q "not the creator wallet" "$W/out.txt"'

echo
if [ "$FAILS" = 0 ]; then echo "morning-test: all passed"; else echo "morning-test: $FAILS failed"; exit 1; fi
