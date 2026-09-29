#!/bin/bash
# The fast rehearsal: the staging worker, API and site run on THIS Mac, against mainnet and the staging database, with
# the test creator. A settings change is then a restart in seconds instead of a Railway build. From the staging folder:
#   scripts/staging-local.sh start                 stops the Railway staging worker (one worker at a time), starts all three
#   scripts/staging-local.sh restart worker api    after a settings change (scripts/staging.sh does this by itself)
#   scripts/staging-local.sh stop [worker|api|site]   no name: all three, and scripts/staging.sh goes back to Railway
#   scripts/staging-local.sh status
#
# The same guards as scripts/staging.sh (scripts/lib/staging-guard.sh): only the staging project, STAGING=true, the
# test creator, a master key that is not production's. The worker still refuses an unmarked database, and the config
# still refuses STAGING next to the production creator. The settings are the staging services' own Railway variables:
# read into this script's memory and handed to each app on stdin (scripts/local-app.cjs), never on a command line,
# never printed, never written to disk. The worker reaches the staging database through Postgres's public address
# (TLS); the API through the same address with its own read-only user. Only these differ from Railway: the API
# listens on this Mac (PORT), allows the local site (CORS_ORIGIN), and multiplies the stage source by
# STAGING_STAGE_SCALE (default 20) so a test of a few hundredths of a SOL crosses a stage on the site. The config
# refuses STAGING_STAGE_SCALE without STAGING=true, and the API applies it only on a marked staging database.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/wsr.sh
. scripts/lib/wsr.sh
# shellcheck source=scripts/lib/staging-guard.sh
. scripts/lib/staging-guard.sh
RUN="$SECRETS/local" # process ids and logs, in the private secrets folder
API_PORT="${WSR_LOCAL_API_PORT:-8080}"
SITE_PORT="${WSR_LOCAL_SITE_PORT:-5173}"
STAGE_SCALE="${WSR_STAGE_SCALE:-20}"
case "$STAGE_SCALE" in '' | 0 | *[!0-9]*) die "WSR_STAGE_SCALE must be a whole number from 1 to 1000" ;; esac
[ "$STAGE_SCALE" -le 1000 ] || die "WSR_STAGE_SCALE must be a whole number from 1 to 1000"
ALL="worker api site"

pid_of() { # the app's process id ("" = none recorded)
  local p
  p=$(cat "$RUN/$1.pid" 2>/dev/null || true)
  case "$p" in '' | *[!0-9]*) ;; *) printf '%s' "$p" ;; esac
}
running() { # the recorded process is alive AND is that app's launcher (a reused process id after a reboot is not)
  local p
  p=$(pid_of "$1")
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null && ps -p "$p" -o args= 2>/dev/null | grep -qF "scripts/local-app.cjs $1"
}
known_app() { case "$1" in worker | api | site) return 0 ;; esac; die "which app? worker, api or site (not '$1')"; }

install_once() { # the worker, API, site and rat CLI packages, installed once and again when the lockfile changes
  local stamp pnpm
  [ -z "${WSR_LOCAL_SKIP_INSTALL:-}" ] || return 0
  command -v node >/dev/null 2>&1 || die "node is missing" "Run: brew install node"
  [ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 22')" = true ] || die "node 22 or newer is needed (this is $(node --version))" "Run: brew upgrade node"
  stamp="node_modules/.staging-local-$(shasum -a 256 pnpm-lock.yaml | cut -c1-16)"
  [ -f "$stamp" ] && return 0
  pnpm="pnpm@$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"
  say "Installing the worker, API and site packages into $PWD (once, a few minutes)..."
  npx --yes --prefer-offline "$pnpm" install --frozen-lockfile >/dev/null 2>"$RUN/install.log" || die "the install failed" "The reason is in $RUN/install.log"
  rm -f node_modules/.staging-local-*
  touch "$stamp"
}

postgres_name() {
  local l
  l=$(rw_read_list) || exit 1
  printf '%s' "$l" | jq -r 'map(select(.name | test("^Postgres"))) | .[0].name // empty'
}
rw_read_list() { # the service list (3 tries)
  local out i
  for i in 1 2 3; do
    if out=$(rw service list --json 2>/dev/null) && printf '%s' "$out" | jq -e 'type == "array"' >/dev/null 2>&1; then printf '%s\n' "$out"; return 0; fi
    [ "$i" = "$TRIES" ] || retry_pause "$i"
  done
  die "Railway did not list the services ($TRIES tries)" "$API_HINT"
}
NO_PUBLIC_DB="the staging Postgres has no public address (DATABASE_PUBLIC_URL), so this Mac cannot reach it"
PUBLIC_DB_FIX="Railway dashboard, STAGING project only: Postgres > Settings > Networking > Public Networking > TCP Proxy, port 5432. Then run this again."

settings_json() { # settings_json app: the one JSON line that app runs with (values stay in memory and in this pipe)
  local pg app_vars pg_vars
  case "$1" in site) printf '{}\n'; return 0 ;; esac
  pg=$(postgres_name) || exit 1
  [ -n "$pg" ] || die "no Postgres service in the staging project"
  app_vars=$(rw_vars "$1") || die "Railway did not list the $1 service's variables" "$API_HINT"
  pg_vars=$(rw_vars "$pg") || die "Railway did not list $pg's variables" "$API_HINT"
  case "$1" in
    worker)
      printf '%s\n%s\n' "$app_vars" "$pg_vars" | jq -sc '
        (.[1].DATABASE_PUBLIC_URL // "") as $u
        | if ($u | test("^postgres(ql)?://[^@]+@[^:/@]+:[0-9]+/")) then . else error("no public address") end
        | (.[0] | with_entries(select(.value | type == "string")))
          + {DATABASE_URL: ($u + (if ($u | contains("?")) then "&" else "?" end) + "sslmode=no-verify")}' 2>/dev/null ||
        die "$NO_PUBLIC_DB" "$PUBLIC_DB_FIX"
      ;;
    api) # its own read-only user and password, through the public address; never the master key
      printf '%s\n%s\n' "$app_vars" "$pg_vars" | jq -sc --arg port "$API_PORT" --arg cors "http://localhost:$SITE_PORT" --arg scale "$STAGE_SCALE" '
        ((.[1].DATABASE_PUBLIC_URL // "" | capture("^postgres(ql)?://[^@/]+@(?<hp>[^:/@]+:[0-9]+)/") | .hp) // error("no public address")) as $hp
        | ((.[0].DATABASE_URL_READONLY // "") | if test("^postgres(ql)?://rat_api:[^@/]+@[^/@]+/") then . else error("no read-only address") end) as $ro
        | (.[0] | with_entries(select(.value | type == "string")) | del(.DATABASE_URL, .KEY_ENCRYPTION_KEY, .KEY_ENCRYPTION_KEY_PREVIOUS))
          + {DATABASE_URL_READONLY: (($ro | sub("@[^/@]+/"; "@" + $hp + "/")) + (if ($ro | contains("?")) then "&" else "?" end) + "sslmode=no-verify"),
             PORT: $port, CORS_ORIGIN: $cors, STAGING_STAGE_SCALE: $scale}' 2>/dev/null ||
        die "the API's settings could not be built: $NO_PUBLIC_DB, or the api service has no read-only DATABASE_URL_READONLY" "$PUBLIC_DB_FIX" \
          "If Postgres has a public address: run scripts/setup-staging.sh again (it sets DATABASE_URL_READONLY)."
      ;;
  esac
}

start_app() { # start_app app settings-json: in the background, detached from this terminal, logs in $RUN
  local a="$1" args=""
  [ "$a" = site ] && args="--port $SITE_PORT --strictPort"
  printf '\n== %s %s start\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$a" >>"$RUN/$a.log"
  # shellcheck disable=SC2086 # the site's arguments are words
  printf '%s\n' "$2" | nohup node scripts/local-app.cjs "$a" $args >>"$RUN/$a.log" 2>&1 &
  echo $! >"$RUN/$a.pid"
  # keep this Mac awake while the worker runs (macOS)
  if [ "$a" = worker ] && command -v caffeinate >/dev/null 2>&1; then nohup caffeinate -i -w "$!" >/dev/null 2>&1 & fi
}
since_start() { awk -v a="== " -v b=" $1 start" 'index($0, a) == 1 && index($0, b) { buf = ""; next } { buf = buf $0 "\n" } END { printf "%s", buf }' "$RUN/$1.log"; }
wait_ready() { # wait_ready app: running and answering, or stop with its last log lines
  local a="$1" i p
  for i in $(seq 1 90); do
    if ! running "$a"; then
      # right after the start the process can still be the forked shell, not node yet (fork before exec): alive is
      # enough for the first seconds. Only a process that is gone, or never becomes the app, stopped.
      p=$(pid_of "$a")
      if [ "$i" -le 5 ] && [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
        sleep 1
        continue
      fi
      die "the local $a stopped right after it started" "Its last lines ($RUN/$a.log):" "$(since_start "$a" | tail -5 | tr '\n' ' ')"
    fi
    case "$a" in
      worker) since_start worker | grep -q 'starting' && [ "$i" -ge 5 ] && return 0 ;;
      api) curl -fsS -m 3 "http://localhost:$API_PORT/api/state" >/dev/null 2>&1 && return 0 ;;
      site) curl -fsS -m 3 "http://localhost:$SITE_PORT/" >/dev/null 2>&1 && return 0 ;;
    esac
    sleep 1
  done
  die "the local $a did not answer within 90 seconds" "Its last lines ($RUN/$a.log):" "$(since_start "$a" | tail -5 | tr '\n' ' ')"
}
stop_app() { # stop_app app: SIGTERM, then wait (the worker finishes its tick and releases its lock); never a hard kill
  local a="$1" p i
  p=$(pid_of "$a")
  if running "$a"; then
    kill -TERM "$p" 2>/dev/null || true
    for i in $(seq 1 120); do
      kill -0 "$p" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$p" 2>/dev/null && die "the local $a is still finishing its work after 2 minutes" "Run the same command again in a minute."
  fi
  rm -f "$RUN/$a.pid"
}
stop_railway_worker() { # only one worker may run: the Railway staging worker holds the single-worker lock
  local s i down=""
  s=$(service_status worker)
  [ "$s" = REMOVED ] && { ok "the Railway staging worker is not running"; return 0; }
  for i in 1 2 3; do
    rw down --service worker --yes >/dev/null 2>&1 && { down=1; break; }
    [ "$i" = "$TRIES" ] || retry_pause "$i"
  done
  if [ -z "$down" ]; then
    # no deployment to remove is fine; a running one that would not stop is not (the local worker would wait forever)
    [ "$s" = NONE ] && { note "Railway shows no staging worker deployment to stop"; return 0; }
    die "could not stop the Railway staging worker ($TRIES tries)" "Railway dashboard, staging project: worker > Deployments > Remove. $API_HINT"
  fi
  for i in $(seq 1 30); do
    [ "$(service_status worker)" = REMOVED ] && break
    sleep "${WSR_POLL_SEC:-2}"
  done
  ok "the Railway staging worker is stopped (the one on this Mac takes over; only one worker ever runs, by its lock)"
}

cmd_start() {
  local a worker_s api_s
  guard
  mkdir -p "$RUN"
  chmod 700 "$RUN"
  for a in $ALL; do ! running "$a" || die "the local $a is already running" "See: scripts/staging-local.sh status. To start over: scripts/staging-local.sh stop"; done
  install_once
  # every setting first: a missing public address stops here, before anything changes
  worker_s=$(settings_json worker) || exit 1
  api_s=$(settings_json api) || exit 1
  stop_railway_worker
  start_app worker "$worker_s"
  start_app api "$api_s"
  start_app site "$(settings_json site)"
  unset worker_s api_s
  for a in $ALL; do wait_ready "$a"; done
  state_set "$STATE" LOCAL 1
  state_set "$STATE" LOCAL_API_PORT "$API_PORT"
  state_set "$STATE" LOCAL_SITE_PORT "$SITE_PORT"
  state_set "$STATE" LOCAL_STAGE_SCALE "$STAGE_SCALE"
  ok "worker, API and site run on this Mac (logs: $RUN)"
  say "The site: http://localhost:$SITE_PORT/?api=http://localhost:$API_PORT  (stage source x$STAGE_SCALE)"
  say "scripts/staging.sh and scripts/approve-stocks.sh now restart these instead of building on Railway."
  say "Next: scripts/staging.sh check, then the phases (docs/runbooks/rehearsal.md, \"The fast rehearsal\")."
}
cmd_restart() {
  local a s
  [ $# -gt 0 ] || set -- worker api
  for a in "$@"; do known_app "$a"; done
  guard
  mkdir -p "$RUN"
  for a in "$@"; do stop_app "$a"; done
  for a in "$@"; do
    s=$(settings_json "$a") || exit 1
    start_app "$a" "$s"
  done
  unset s
  for a in "$@"; do wait_ready "$a"; done
  ok "restarted on this Mac with the current settings: $*"
}
cmd_stop() {
  local a
  # shellcheck disable=SC2086 # the app names are words
  [ $# -gt 0 ] || set -- $ALL
  for a in "$@"; do known_app "$a"; done
  for a in "$@"; do stop_app "$a"; done
  if [ "$*" = "$ALL" ]; then
    state_set "$STATE" LOCAL 0
    ok "the worker, API and site on this Mac are stopped; scripts/staging.sh uses Railway again"
    say "The Railway staging worker stays stopped. To run it on Railway again (a build): railway redeploy --service worker --from-source --yes"
  else
    ok "stopped on this Mac: $*"
  fi
}
cmd_status() {
  local a
  for a in $ALL; do
    if running "$a"; then ok "$a runs on this Mac (process $(pid_of "$a"), log $RUN/$a.log)"; else note "$a is not running on this Mac"; fi
  done
  if [ "$(state_get "$STATE" LOCAL)" = 1 ]; then
    say "Fast rehearsal ON: http://localhost:$(state_get "$STATE" LOCAL_SITE_PORT)/?api=http://localhost:$(state_get "$STATE" LOCAL_API_PORT)"
  else
    say "Fast rehearsal OFF: scripts/staging.sh uses Railway."
  fi
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  start) cmd_start ;;
  restart) cmd_restart "$@" ;;
  stop) cmd_stop "$@" ;;
  status) cmd_status ;;
  *) die "scripts/staging-local.sh start | restart [worker] [api] [site] | stop [worker] [api] [site] | status" ;;
esac
