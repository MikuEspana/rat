#!/bin/bash
# The morning checks in one command (docs/runbooks/MORNING.md step 0). Run it from ~/wallstreetrats:
#   scripts/morning.sh
# Read-only: it changes nothing on Railway, signs nothing, sends nothing, prints no secret. It ends with
#   GO    every check passed: go on with MORNING.md step 1
#   WAIT  the lines marked WAIT say what to wait for or fix; run it again after
# Checks: this folder is the production bot and up to date; status.railway.com has no incident; the "Limited Access"
# banner is gone (you answer, Railway shows it only on the dashboard); worker, api and admin each deployed; production
# in DRY RUN with no coin yet; the running worker answers in DRY RUN with fresh loops; preflight has nothing open but
# the expected pre-launch items (no coin yet, the creator wallet funded right before launch).
set -uo pipefail # no -e: every check runs and reports (die still stops at once on the wrong folder)
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=scripts/lib/wsr.sh
. scripts/lib/wsr.sh
# shellcheck source=scripts/lib/launch.sh
. scripts/lib/launch.sh
SECRETS="${WSR_SECRETS:-$HOME/rat-secrets}"
STATE="$SECRETS/setup-state.env"
PRODUCTION_CREATOR="4VYWcTTDYyMVic58AcUC7Nodt6vNQwjKhA9UphaAKiot"
STATUS_URL="${WSR_STATUS_URL:-https://status.railway.com/summary.json}"
# a worker loop older than this is not running (the admin watchdog uses the same 3 minutes, apps/admin/src/watchdog.ts)
LOOP_STALE_SEC=180
g() { ${WSR_GIT:-git} "$@"; }
WAITS=0
wait_on() { # wait_on "what" "fix"...: one WAIT line
  printf '  %sWAIT%s  %s\n' "$Y" "$N" "$1"
  shift
  for l in "$@"; do say "$l"; done
  WAITS=$((WAITS + 1))
}
for t in jq curl; do command -v "$t" >/dev/null 2>&1 || die "$t is missing" "Run: brew install $t"; done
command -v "${WSR_RAILWAY:-railway}" >/dev/null 2>&1 || die "the railway command is missing" "Run: brew install railway"

title "Morning checks (read-only)"
# ---------------------------------------------------------------- 1. this folder is production -------------------------
pjson=$(rw status --json 2>/dev/null || true)
pid=$(printf '%s' "$pjson" | jq -r '.id // empty' 2>/dev/null || true)
pname=$(printf '%s' "$pjson" | jq -r '.name // empty' 2>/dev/null || true)
[ -n "$pid" ] || die "this folder ($PWD) is not linked to a Railway project, or Railway did not answer" \
  "Run it from ~/wallstreetrats. If Railway is down (status.railway.com): WAIT and run it again later."
[ "$pid" = "$(state_get "$STATE" RAILWAY_PROJECT_ID)" ] || die "this folder is linked to $pname, not the production project in $STATE" "Run it from ~/wallstreetrats."
case "$(state_get "$STATE" PROFILE):$pname" in staging:* | *:*-staging) die "this is the staging project: run it from ~/wallstreetrats" ;; esac
ok "linked to the production project ($pname)"

# ---------------------------------------------------------------- 2. the scripts are up to date ------------------------
if g fetch -q origin main 2>/dev/null; then
  behind=$(g rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
  if [ "$behind" = 0 ]; then ok "the scripts are up to date with main"; else wait_on "this folder is $behind commit(s) behind main" "Run: git -C $PWD pull"; fi
else
  note "could not reach GitHub to check for updates (run git pull by hand)"
fi

# ---------------------------------------------------------------- 3. Railway itself ------------------------------------
summary=$(curl -fsS -m 20 "$STATUS_URL" 2>/dev/null || true)
page=$(printf '%s' "$summary" | jq -r '.page.status // empty' 2>/dev/null || true)
incidents=$(printf '%s' "$summary" | jq -r '[(.activeIncidents // [])[] | .name] | join("; ")' 2>/dev/null || true)
maint=$(printf '%s' "$summary" | jq -r '[(.activeMaintenances // [])[] | .name] | join("; ")' 2>/dev/null || true)
if [ -z "$page" ]; then
  wait_on "could not read status.railway.com" "Open https://status.railway.com yourself. All green: run this again, or go on if everything else is OK."
elif [ "$page" != UP ] || [ -n "$incidents" ]; then
  wait_on "status.railway.com: $page${incidents:+ ($incidents)}" "Wait until it is green, then run this again."
else
  ok "status.railway.com: all systems up"
fi
[ -z "$maint" ] || note "Railway maintenance now: $maint"
if yes_no "Is the \"Limited Access\" banner (\"Deploys have been paused\") gone from your Railway dashboard?" n; then
  ok "you checked: deploys are no longer paused"
else
  wait_on "deploys may still be paused on Railway" "Wait until the banner is gone from https://railway.com/dashboard, then run this again."
fi

# ---------------------------------------------------------------- 4. production deployed, in DRY RUN ------------------
for svc in worker api admin; do
  s=$(service_status "$svc")
  case "$s" in
    SUCCESS) ok "$svc: deployed" ;;
    FAILED | CRASHED | REMOVED) wait_on "$svc: its latest deployment is $s" "Railway dashboard: $svc > Deployments shows why. Fix it (docs/runbooks/INCIDENTS.md), then run this again." ;;
    NONE) wait_on "$svc: Railway did not answer for it" "$API_HINT" ;;
    *) wait_on "$svc: not running yet ($s)" "Wait a few minutes (a build takes about 5, 10 to 15 during a Railway incident), then run this again." ;;
  esac
done
if vars=$(rw_vars worker); then
  dry=$(printf '%s' "$vars" | jq -r '.DRY_RUN // "true"')
  staging=$(printf '%s' "$vars" | jq -r '.STAGING // ""')
  creator=$(printf '%s' "$vars" | jq -r '.CREATOR_PUBKEY // ""')
  coin=$(printf '%s' "$vars" | jq -r '.COIN_MINT // ""')
  confirm=$(printf '%s' "$vars" | jq -r 'if (.LIVE_CONFIRM // "") == "" then "" else "set" end')
  unset vars
  [ "$staging" != true ] || die "STAGING is on for this worker: not the production bot"
  [ "$creator" = "$PRODUCTION_CREATOR" ] || die "the worker's CREATOR_PUBKEY is ${creator:-not set}, not the creator wallet $PRODUCTION_CREATOR"
  if [ "$dry" = true ] && [ -z "$confirm" ]; then ok "worker settings: DRY RUN"; else
    wait_on "the production worker is NOT in DRY RUN before the launch (DRY_RUN=$dry${confirm:+, LIVE_CONFIRM set})" \
      "Only scripts/launch.sh turns it live. Set it back: railway variable set DRY_RUN=true --service worker, and delete LIVE_CONFIRM."
  fi
  [ -z "$coin" ] || note "the worker already has COIN_MINT=$coin: scripts/launch.sh will finish that launch instead of asking for a new one"
else
  wait_on "Railway did not list the worker's settings" "$API_HINT"
fi
api_dry=$(rw_var api DRY_RUN)
if [ "$api_dry" = false ]; then wait_on "the API says DRY_RUN=false before the launch" "Only scripts/launch.sh sets it. Set it back: railway variable set DRY_RUN=true --service api"; else ok "API settings: DRY RUN"; fi

# ---------------------------------------------------------------- 5. the running worker -------------------------------
st=$(rat_json status --json)
if [ -z "$st" ]; then
  wait_on "the running worker did not answer (railway ssh)" "Try: scripts/rat.sh status. No railway ssh: scripts/rat-local.sh status."
else
  mode=$(printf '%s' "$st" | jq -r '.mode // empty')
  if [ "$mode" = dry_run ]; then ok "the running worker: DRY RUN"; else
    wait_on "the running worker says mode ${mode:-?}, not dry_run" "Production must stay in DRY RUN until scripts/launch.sh. Find out why before anything else (docs/runbooks/INCIDENTS.md)."
  fi
  kill=$(printf '%s' "$st" | jq -r 'if .killSwitch.on then (.killSwitch.reason // "on") else "" end')
  [ -z "$kill" ] || note "the kill switch is ON ($kill). Fine before the launch; scripts/launch.sh checks it is off at the end."
  stale=$(printf '%s' "$st" | jq -r --argjson max "$LOOP_STALE_SEC" '[.loops[]? | select(.ageSec > $max) | "\(.loop) \(.ageSec)s"] | join(", ")')
  nloops=$(printf '%s' "$st" | jq -r '[.loops[]?] | length')
  if [ "$nloops" = 0 ]; then wait_on "the worker has no loop running yet" "Wait a minute (it may be starting), then run this again. Logs: railway logs --service worker"
  elif [ -n "$stale" ]; then wait_on "worker loops not running: $stale old" "railway logs --service worker says why (docs/runbooks/INCIDENTS.md, 2 and 8)."
  else ok "worker loops: all ran in the last $LOOP_STALE_SEC s"; fi
fi

# ---------------------------------------------------------------- 6. preflight ----------------------------------------
pre=$(rat_json preflight --json)
if [ -z "$pre" ]; then
  wait_on "rat preflight gave no answer (railway ssh)" "Try: scripts/rat.sh preflight"
else
  # before the launch exactly these may fail: no coin yet, and the creator wallet is funded right before the launch
  # (the same rule as scripts/setup-mac.sh step 8)
  blocking=$(printf '%s' "$pre" | jq -r '.lines[]? | select(.status == "FAIL")
    | select((.check == "settings" and .detail == "missing: COIN_MINT (see .env.example).") or .check == "creator wallet" | not)
    | "\(.check): \(.detail)"')
  if [ -n "$blocking" ]; then
    wait_on "preflight has FAIL lines to fix before the launch:" "$blocking" "Each line says how to fix it. Then run this again."
  else
    ok "preflight: only the expected pre-launch items open"
  fi
  printf '%s' "$pre" | jq -e '.lines[]? | select(.check == "stocks" and .status != "PASS")' >/dev/null 2>&1 &&
    note "no stock is approved yet: MORNING.md step 1 does it (scripts/approve-stocks.sh)"
fi

# ---------------------------------------------------------------- the answer ------------------------------------------
if [ "$WAITS" = 0 ]; then
  printf '\n  %sGO%s  Everything checked. Next: docs/runbooks/MORNING.md step 1.\n' "$B$G" "$N"
  exit 0
fi
printf '\n  %sWAIT%s  %s item(s) above. Fix or wait, then run scripts/morning.sh again.\n' "$B$Y" "$N" "$WAITS"
exit 1
