#!/bin/bash
# scripts/staging-local.sh (the fast rehearsal) with a fake `railway` and stand-in apps run by the real launcher
# (scripts/local-app.cjs, node --import tsx): the staging guards, the settings each app receives (the worker through
# Postgres's public address, the API with its read-only user and never the master key, nothing from this shell), no
# secret on any command line, restart with changed settings, scripts/staging.sh using the local apps instead of
# Railway, and stop. Run: bash tests/scripts/staging-local-test.sh (after pnpm install: tsx from the repo)
# shellcheck disable=SC2016,SC2034 # each check is a string evaluated later (check), rc is read there
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
W=$(mktemp -d)
T="$W/repo" # a copy of the scripts with stand-in apps
FAILS=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; FAILS=$((FAILS + 1)); fi; }
cleanup() {
  local f
  for f in "$W"/home/rat-secrets-staging/local/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
  sleep 1
  rm -rf "$W"
}
trap cleanup EXIT

mkdir -p "$T/scripts/lib" "$T/apps/worker/src" "$T/apps/api/src" "$T/apps/pixel-site/node_modules/vite/bin" "$T/out" \
  "$W/bin" "$W/fake" "$W/home/rat-secrets-staging" "$W/home/rat-secrets"
cp "$REPO/scripts/staging-local.sh" "$REPO/scripts/staging.sh" "$REPO/scripts/local-app.cjs" "$T/scripts/"
cp "$REPO/scripts/lib/"*.sh "$T/scripts/lib/"
cp "$REPO/package.json" "$REPO/pnpm-lock.yaml" "$T/"
ln -s "$REPO/node_modules" "$T/node_modules" # tsx
# the stand-in apps report the settings they got: names, and values only where they are not secret (hashes otherwise)
cat >"$T/apps/worker/src/main.ts" <<'EOF'
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const e = process.env;
const h = (v?: string) => (v ? createHash('sha256').update(v).digest('hex') : '');
writeFileSync('../../out/worker.json', JSON.stringify({ names: Object.keys(e).sort(), db: (e.DATABASE_URL ?? '').replace(/:[^:@/]+@/, ':***@'), kek: h(e.KEY_ENCRYPTION_KEY), coin: e.COIN_MINT ?? '', pid: process.pid }));
console.log('{"msg":"starting in DRY RUN: nothing will be sent"}');
process.on('SIGTERM', () => { console.log('{"msg":"stopping after the current tick"}'); process.exit(0); });
setInterval(() => {}, 1000);
EOF
cat >"$T/apps/api/src/main.ts" <<'EOF'
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const e = process.env;
writeFileSync('../../out/api.json', JSON.stringify({ names: Object.keys(e).sort(), ro: (e.DATABASE_URL_READONLY ?? '').replace(/:[^:@/]+@/, ':***@'), cors: e.CORS_ORIGIN, scale: e.STAGING_STAGE_SCALE, port: e.PORT }));
createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end('{"bot":{"mode":"dry_run"},"treasury":{"totalClaimedSol":0,"stageSol":0}}'); }).listen(Number(e.PORT));
process.on('SIGTERM', () => process.exit(0));
EOF
cat >"$T/apps/pixel-site/node_modules/vite/bin/vite.js" <<'EOF'
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
require('node:http').createServer((_q, r) => r.end('<html>site</html>')).listen(port);
process.on('SIGTERM', () => process.exit(0));
EOF

TEST_CREATOR=CCtCZryKG3cdEFUAYPd5S1kFVhJ3mpEy2ciDqu59CvWT
SECRETS_LIST="staging-master-key-secret apisecret9 pgsecret7 rpcsecret5"
API_PORT=$((20000 + RANDOM % 20000))
SITE_PORT=$((API_PORT + 1))
# fake railway: every argv logged; variables per service from files the test changes
cat >"$W/bin/railway" <<'EOF'
#!/bin/bash
F="$FAKE_DIR"
printf '%s\n' "$*" >>"$F/argv.log"
svc=""; prev=""; for a in "$@"; do [ "$prev" = --service ] && svc="$a"; prev="$a"; done
case "$1 ${2:-}" in
  "status --json") cat "$F/linked" ;;
  "variable list") [ -f "$F/vars-$svc.json" ] || exit 1; cat "$F/vars-$svc.json" ;;
  "service list") echo '[{"name":"Postgres"},{"name":"worker"},{"name":"api"}]' ;;
  "service status") printf '{"status":"%s","deploymentId":"d1"}\n' "$(cat "$F/status-$svc" 2>/dev/null || echo SUCCESS)" ;;
  "down --service") echo REMOVED >"$F/status-$svc"; echo "down $svc" >>"$F/railway.log" ;;
  *) echo "railway $*" >>"$F/railway.log" ;;
esac
EOF
# fake ps: while ps-lag holds N > 0, the next N process lookups see the forked shell, not node yet (the moment
# between fork and exec right after an app starts, which a slow machine makes seconds long)
cat >"$W/bin/ps" <<EOF
#!/bin/bash
n=\$(cat "\$FAKE_DIR/ps-lag" 2>/dev/null || echo 0)
if [ "\$n" -gt 0 ]; then
  echo \$((n - 1)) >"\$FAKE_DIR/ps-lag"
  echo "bash scripts/staging-local.sh start"
  exit 0
fi
exec $(command -v ps) "\$@"
EOF
# fake rat for scripts/staging.sh: a kill switch the bot trips by itself (trip file), loops a few seconds old
cat >"$W/bin/fake-rat" <<'EOF'
#!/bin/bash
F="$FAKE_DIR"
kill=$(cat "$F/kill")
case "$1" in
  status)
    if [ "$kill" = off ] && [ -f "$F/trip" ]; then echo on >"$F/kill"; kill=on; fi
    printf '{"mode":"live","staging":true,"killSwitch":{"on":%s,"reason":"watch: unknown tx"},"claims":1,"openReservations":0,"loops":[{"loop":"claim","ageSec":5}],"hireBudgetSol":"0"}\n' \
      "$([ "$kill" = on ] && echo true || echo false)" ;;
  kill) echo on >"$F/kill" ;;
  resume) echo off >"$F/kill" ;;
esac
EOF
chmod +x "$W/bin/"*
reset() {
  echo '{"id":"proj-staging","name":"wall-street-rats-staging"}' >"$W/fake/linked"
  printf '{"CREATOR_PUBKEY":"%s","STAGING":"true","KEY_ENCRYPTION_KEY":"staging-master-key-secret","DATABASE_URL":"postgresql://postgres:pgsecret7@postgres.railway.internal:5432/railway","RPC_URL":"https://rpc.example/?api-key=rpcsecret5","DRY_RUN":"true"}\n' "$TEST_CREATOR" >"$W/fake/vars-worker.json"
  printf '{"DATABASE_URL_READONLY":"postgresql://rat_api:apisecret9@postgres.railway.internal:5432/railway","STAGING":"true","CREATOR_PUBKEY":"%s","CORS_ORIGIN":"https://idleinu.world","DRY_RUN":"true"}\n' "$TEST_CREATOR" >"$W/fake/vars-api.json"
  echo '{"DATABASE_PUBLIC_URL":"postgresql://postgres:pgsecret7@shinkansen.proxy.rlwy.net:41234/railway"}' >"$W/fake/vars-Postgres.json"
  rm -f "$W/fake/status-"* "$W/fake/railway.log" "$W/fake/trip" "$T/out/"*
  echo on >"$W/fake/kill"
  printf 'PROFILE=staging\nRAILWAY_PROJECT_ID=proj-staging\n' >"$W/home/rat-secrets-staging/setup-state.env"
  printf 'RAILWAY_PROJECT_ID=proj-production\n' >"$W/home/rat-secrets/setup-state.env"
  printf 'production-master-key\n' >"$W/home/rat-secrets/KEY_ENCRYPTION_KEY.txt"
}
run() { # run "<stdin>" script args...: with the fakes; FROM_SHELL must never reach an app
  local input="$1" script="$2"
  shift 2
  printf '%s' "$input" | env -i PATH="$W/bin:$PATH" HOME="$W/home" FAKE_DIR="$W/fake" FROM_SHELL=leak WSR_RAILWAY=railway \
    WSR_RETRY_SEC=0 WSR_POLL_SEC=0 WSR_DOWN_SEC=1 WSR_LOCAL_SKIP_INSTALL=1 WSR_LOCAL_API_PORT="$API_PORT" WSR_LOCAL_SITE_PORT="$SITE_PORT" \
    ${RUN_RAT:+WSR_RAT="$RUN_RAT"} bash "$T/scripts/$script" "$@" >"$W/out.txt" 2>&1
}
pid() { cat "$W/home/rat-secrets-staging/local/$1.pid" 2>/dev/null; }
alive() { local p; p=$(pid "$1"); [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
wj() { jq -r "$2" "$T/out/$1.json" 2>/dev/null; }
sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

echo "== guards"
reset
echo '{"id":"proj-production","name":"wall-street-rats"}' >"$W/fake/linked"
run "" staging-local.sh start; rc=$?
check "linked to production: refused, nothing started or stopped" '[ $rc = 1 ] && ! alive worker && ! grep -q "^down" "$W/fake/railway.log" 2>/dev/null'
reset
printf '{"CREATOR_PUBKEY":"%s","STAGING":"true","KEY_ENCRYPTION_KEY":"production-master-key"}\n' "$TEST_CREATOR" >"$W/fake/vars-worker.json"
run "" staging-local.sh start; rc=$?
check "the production master key: refused" '[ $rc = 1 ] && grep -q "PRODUCTION master key" "$W/out.txt" && ! alive worker'
reset
echo '{}' >"$W/fake/vars-Postgres.json"
run "" staging-local.sh start; rc=$?
check "no public database address: refused with the fix, the Railway worker left running" '[ $rc = 1 ] && grep -q "TCP Proxy, port 5432" "$W/out.txt" && ! grep -q "^down" "$W/fake/railway.log" 2>/dev/null && ! alive worker'

echo "== start"
reset
run "" staging-local.sh start; rc=$?
check "starts: the Railway staging worker stopped first, then worker, API and site here" '[ $rc = 0 ] && grep -q "^down worker" "$W/fake/railway.log" && alive worker && alive api && alive site'
check "the worker reaches the database through the public address (TLS)" '[ "$(wj worker .db)" = "postgresql://postgres:***@shinkansen.proxy.rlwy.net:41234/railway?sslmode=no-verify" ]'
check "the worker gets its own master key and settings, nothing from this shell" '[ "$(wj worker .kek)" = "$(sha staging-master-key-secret)" ] && wj worker ".names | index(\"RPC_URL\")" | grep -q "[0-9]" && [ "$(wj worker ".names | index(\"FROM_SHELL\")")" = null ]'
check "the API: its read-only user through the public address, never the master key" '[ "$(wj api .ro)" = "postgresql://rat_api:***@shinkansen.proxy.rlwy.net:41234/railway?sslmode=no-verify" ] && [ "$(wj api ".names | index(\"KEY_ENCRYPTION_KEY\")")" = null ] && [ "$(wj api ".names | index(\"FROM_SHELL\")")" = null ]'
check "the API: this Mac only (port, the local site allowed) and the stage scale" '[ "$(wj api .port)" = "$API_PORT" ] && [ "$(wj api .cors)" = "http://localhost:$SITE_PORT" ] && [ "$(wj api .scale)" = 20 ]'
check "the site answers" 'curl -fsS -m 5 "http://localhost:$SITE_PORT/" | grep -q site'
check "staging.sh is told: LOCAL=1 with the ports and scale" 'grep -q "^LOCAL=1$" "$W/home/rat-secrets-staging/setup-state.env" && grep -q "^LOCAL_API_PORT=$API_PORT$" "$W/home/rat-secrets-staging/setup-state.env"'
leaks=""
for s in $SECRETS_LIST; do
  pgrep -f -- "$s" >/dev/null && leaks="$leaks ps:$s"
  grep -qF "$s" "$W/fake/argv.log" "$W/out.txt" "$W/home/rat-secrets-staging/local/"*.log && leaks="$leaks file:$s"
done
check "no secret on any command line, in any log or on screen" '[ -z "$leaks" ]'
run "" staging-local.sh start; rc=$?
check "start again: refused while running" '[ $rc = 1 ] && grep -q "already running" "$W/out.txt"'

echo "== restart with changed settings"
old=$(wj worker .pid)
jq -c '.COIN_MINT = "MintTest111"' "$W/fake/vars-worker.json" >"$W/fake/w.tmp" && mv "$W/fake/w.tmp" "$W/fake/vars-worker.json"
run "" staging-local.sh restart worker; rc=$?
check "the worker restarts with the new settings (seconds, no build)" '[ $rc = 0 ] && [ "$(wj worker .coin)" = MintTest111 ] && [ "$(wj worker .pid)" != "$old" ] && alive worker && grep -q "stopping after the current tick" "$W/home/rat-secrets-staging/local/worker.log"'

echo "== scripts/staging.sh uses the local apps"
printf 'PHASE_1=PASS|t|live\n' >"$W/home/rat-secrets-staging/rehearsal-results.env"
touch "$W/fake/trip"
old=$(wj worker .pid)
: >"$W/fake/railway.log"
RUN_RAT=fake-rat run $'GO\n\ny\ny\ny\n' staging.sh 6; rc=$?
check "phase 6 in full: the local worker stopped and started again (no Railway down, no build)" '[ $rc = 0 ] && grep -q "^PHASE_6=PASS" "$W/home/rat-secrets-staging/rehearsal-results.env" && [ "$(wj worker .pid)" != "$old" ] && alive worker && ! grep -q "down\|redeploy" "$W/fake/railway.log"'
check "and the kill switch is ON" '[ "$(cat "$W/fake/kill")" = on ]'
echo '{"id":"proj-other","name":"something-else"}' >"$W/fake/linked"
env -i PATH="$W/bin:$PATH" FAKE_DIR="$W/fake" WSR_RAILWAY=railway bash -c ". '$T/scripts/lib/wsr.sh'; local_mode '$W/home/rat-secrets-staging/setup-state.env'"; rc=$?
check "another linked project is never in local mode (production folder: Railway only)" '[ $rc = 1 ]'
echo '{"id":"proj-staging","name":"wall-street-rats-staging"}' >"$W/fake/linked"

echo "== stop"
run "" staging-local.sh stop; rc=$?
sleep 1
check "stop: all three gone, staging.sh back on Railway" '[ $rc = 0 ] && ! alive worker && ! alive api && ! alive site && grep -q "^LOCAL=0$" "$W/home/rat-secrets-staging/setup-state.env"'
check "no stand-in app left running" '! pgrep -f "$T/apps" >/dev/null && ! pgrep -f "vite.js --port $SITE_PORT" >/dev/null'

echo "== a slow start: an app not node yet right after it starts is starting, not stopped"
reset
echo 3 >"$W/fake/ps-lag"
run "" staging-local.sh start; rc=$?
check "start waits for it: all three run" '[ $rc = 0 ] && alive worker && alive api && alive site && ! grep -q "stopped right after it started" "$W/out.txt"'
rm -f "$W/fake/ps-lag"
run "" staging-local.sh stop
sleep 1

echo "staging-local-test: $FAILS failed"
[ "$FAILS" = 0 ]
