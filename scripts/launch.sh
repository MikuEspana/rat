#!/bin/bash
# Launch day, ARMED first (LAUNCH-DAY.md). Run it from ~/wallstreetrats BEFORE the coin exists:
#   scripts/launch.sh
# 1. ARM: it checks the creator wallet's balance and the preflight (read-only), then waits for your GO. The bot
#    restarts LIVE with its kill switch ON ("armed"): it sends nothing and waits up to 30 minutes for your coin.
#    The founding rats are booked.
# 2. LAUNCH: you create the coin on pump.fun from the creator wallet and paste its CA. It finds the launch on chain
#    and registers it (rat launch-register): the site shows the CA, the kill switch is released, the bot claims the
#    creator fees and hires rats right away. No build between the coin and the first rats.
# 3. FINISH (no hurry): the coin goes into the worker's and the API's settings (COIN_MINT, KNOWN_OWNER_TX_SIGS), one
#    restart of both, then preflight --live. Hiring pauses about a minute during that restart.
# Stopped halfway? Run it again: it goes on from where it stopped (armed: from the launch; a coin already set: it
# finishes it). Only in the production folder, never with STAGING. `--rehearsal` runs the same flow on the staging
# project with the test creator. Nothing here needs or prints a secret.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/wsr.sh
. scripts/lib/wsr.sh
# shellcheck source=scripts/lib/launch.sh
. scripts/lib/launch.sh
SECRETS="${WSR_SECRETS:-$HOME/rat-secrets}"
STATE="$SECRETS/setup-state.env"
PRODUCTION_CREATOR="6MRpbXQruNeeXraMG3wQWodjnMYyHTrfMP3BpTLjvaeB"
# --rehearsal: this exact script on the staging project with the test creator (from ~/wallstreetrats-staging), to
# practise launch day: the staging guards instead of the production ones. The staging kill switch (ON between
# rehearsals) is released right before the arm; launch-register releases the armed one. Everything else is the same.
REHEARSAL=""
if [ "${1:-}" = --rehearsal ]; then
  REHEARSAL=1
  # shellcheck source=scripts/lib/staging-guard.sh
  . scripts/lib/staging-guard.sh
fi
# the coin found by this run, kept until the settings hold it (public values only): a run that stops between the
# register and the settings goes on with it instead of asking for the launch again
LSTATE="$SECRETS/launch-state.env"
for t in jq curl; do command -v "$t" >/dev/null 2>&1 || die "$t is missing" "Run: brew install $t"; done

# ---------------------------------------------------------------- only production -------------------------------------
pname=$(rw status --json 2>/dev/null | jq -r '.name // empty' 2>/dev/null || true)
if [ -n "$REHEARSAL" ]; then
  title "REHEARSAL of launch day on $pname (staging, test creator)"
  p=$(isolation)
  [ -z "$p" ] || die "the rehearsal runs only on the staging project: $(printf '%s' "$p" | head -1)" "Run it from ~/wallstreetrats-staging."
  vars=$(rw_vars worker) || die "Railway did not list the worker's variables" "$API_HINT"
  creator=$(printf '%s' "$vars" | jq -r '.CREATOR_PUBKEY // ""')
  { [ -n "$creator" ] && [ "$creator" != "$PRODUCTION_CREATOR" ]; } || die "the staging worker's creator is ${creator:-not set}: never the production creator"
else
  title "Launch: arm the bot, then the coin"
  pid=$(rw status --json 2>/dev/null | jq -r '.id // empty' 2>/dev/null || true)
  [ -n "$pid" ] || die "this folder ($PWD) is not linked to a Railway project" "Run it from ~/wallstreetrats (scripts/setup-mac.sh set it up)."
  [ "$pid" = "$(state_get "$STATE" RAILWAY_PROJECT_ID)" ] || die "this folder is linked to $pname, not the production project in $STATE" "Run it from ~/wallstreetrats."
  case "$(state_get "$STATE" PROFILE):$pname" in staging:* | *:*-staging) die "this is the staging project: practise with scripts/launch.sh --rehearsal" ;; esac
  vars=$(rw_vars worker) || die "Railway did not list the worker's variables" "$API_HINT"
  [ "$(printf '%s' "$vars" | jq -r '.STAGING // ""')" != true ] || die "STAGING is on for this worker: not the production bot"
  creator=$(printf '%s' "$vars" | jq -r '.CREATOR_PUBKEY // ""')
  [ "$creator" = "$PRODUCTION_CREATOR" ] || die "the worker's CREATOR_PUBKEY is ${creator:-not set}, not the creator wallet $PRODUCTION_CREATOR"
fi
# the RPC address, once (its API key stays in this shell's memory): every chain read below reuses it
RPC_URL=$(printf '%s' "$vars" | jq -r '.RPC_URL // ""')
set_coin=$(printf '%s' "$vars" | jq -r '.COIN_MINT // ""')
set_floor=$(printf '%s' "$vars" | jq -r '.WATCH_FROM_SLOT // ""')
set_sigs=$(printf '%s' "$vars" | jq -r '.KNOWN_OWNER_TX_SIGS // ""')
set_dry=$(printf '%s' "$vars" | jq -r '.DRY_RUN // "true"')
set_claim=$(printf '%s' "$vars" | jq -r '.CLAIM_INTERVAL_SEC // ""')
unset vars

# ---------------------------------------------------------------- helpers ----------------------------------------------
is_slot() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }
st=""
wait_live() { # after a restart: up to two minutes for the worker to answer mode live (the old container can still
  # answer while it drains, or railway ssh drops); sets st. 0 = live, 1 = still DRY RUN, 2 = no answer
  local i
  st=""
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    st=$(rat_json status --json)
    [ "$(printf '%s' "$st" | jq -r '.mode // empty' 2>/dev/null)" = live ] && return 0
    [ "$i" = 12 ] || sleep "${WSR_POLL_SEC:-5}"
  done
  [ "$(printf '%s' "$st" | jq -r '.mode // empty' 2>/dev/null)" = dry_run ] && return 1
  return 2
}
live_or_die() { # live_or_die what-to-do: the worker must answer LIVE after its restart
  local rc=0
  wait_live || rc=$?
  case "$rc" in
    0) ;;
    1) die "the worker still runs in DRY RUN two minutes after its restart" "Check the worker's variables (DRY_RUN=false, LIVE_CONFIRM) and its logs on Railway. $1" ;;
    *) die "the worker did not answer for two minutes after its restart (railway ssh)" "Check: scripts/rat.sh status, and the worker's logs on Railway. $1" ;;
  esac
}
kill_on() { printf '%s' "$1" | jq -r '.killSwitch.on // empty' 2>/dev/null || true; }
arm_problems() { # every FAIL line of the pre-launch preflight but the ones expected before the coin exists
  printf '%s' "$1" | jq -r '.lines[] | select(.status == "FAIL")
    | select(.check as $c | ["watch floor", "coin", "coin creator", "dev buy", "launch txs", "kill switch"] | index($c) | not)
    | select((.check == "settings" and (.detail | test("^missing: COIN_MINT \\("))) | not)
    | "\(.check): \(.detail)"'
}
check_balance() { # the creator wallet pays the launch and the dev buy (and backs the founding rats)
  local bal f
  bal=$(sol_balance "$creator")
  [ -n "$bal" ] || die "could not read the creator wallet's balance (RPC): nothing was changed" "Run scripts/launch.sh again in a few seconds."
  say "The creator wallet holds $(lamports_to_sol "$bal") SOL."
  [ "$bal" -ge 200000000 ] || die "the creator wallet holds less than 0.2 SOL" "Send it about 0.3 SOL first: 0.1 dev buy + launch cost + 0.05 reserve + spare (LAUNCH-DAY.md)."
  f="${WSR_FOUNDING_RATS:-5}"
  [ "$bal" -ge $((200000000 + f * 30000000)) ] ||
    note "for $f founding rats the creator wallet needs about $(lamports_to_sol $((200000000 + f * 30000000))) SOL (0.03 each on top of 0.2): send more first, or fewer are booked"
}
signature_before_floor() { # the creator's newest transaction before the watch floor ("" = not among the last 50)
  rpc getSignaturesForAddress "[\"$creator\",{\"limit\":50,\"commitment\":\"confirmed\"}]" |
    jq -r --argjson f "$1" '[.[] | select(.slot < $f)][0].signature // empty' 2>/dev/null || true
}
tell_launch() {
  say "Now create the coin on pump.fun, in Phantom, with the CREATOR wallet $creator (within 30 minutes):"
  say "1. pump.fun > Create coin: name The Inuvestors, ticker INUVESTOR. Normal mode: no holder rewards, no fee sharing, no cashback."
  say "2. Dev buy 0.1 SOL, inside the launch. The dev-buy coins stay in the creator wallet forever."
  say "3. After this, never sign anything else with the creator wallet: the bot treats it as a leaked key."
}
find_coin() { # find_coin signature-before: the CA from you, the launch from the chain; sets LAUNCH_MINT, LAUNCH_SIGS
  local before="$1" CA yes
  printf '\n  %sPaste the CA%s (the coin address pump.fun shows) and press Enter.\n' "$B" "$N"
  printf '  (No CA? Just press Enter once Solscan shows the launch.)  CA: '
  IFS= read -r CA || die "no keyboard input (end of input)"
  CA=$(printf '%s' "$CA" | tr -d '[:space:]')
  say "Waiting for the launch to be confirmed on chain (a few seconds)..."
  if [ -n "$before" ] && find_launch "$creator" "$before"; then
    say "Found: the launch signature(s) $LAUNCH_SIGS, last slot $LAUNCH_SLOT"
    say "Coin mint: ${LAUNCH_MINT:-not found}"
    yes=n
    if [ -n "$LAUNCH_MINT" ] && [ "$LAUNCH_MINT" = "$CA" ]; then
      ok "the same coin as the CA you pasted"
      yes=y
    elif [ -n "$LAUNCH_MINT" ]; then
      [ -z "$CA" ] || note "that is NOT the CA you pasted ($CA)"
      yes_no "Is that your coin (the mint shown on pump.fun)?" y && yes=y
    fi
    [ "$yes" = y ] || ask_launch
  else
    note "no new confirmed transaction from the creator wallet was found: type the launch from Solscan (creator wallet page)"
    ask_launch
  fi
}
arm_or_die() { # rat launch-arm: the kill switch ON ("armed: waiting for the coin launch") and a 30-minute launch window.
  # It refuses when the kill switch is already ON for another reason: that reason comes first.
  local out
  if ! out=$(rat launch-arm 2>&1); then
    die "rat launch-arm refused: $1" "$(printf '%s' "$out" | grep . | tail -1)" \
      "Check why (scripts/rat.sh status: the kill switch's reason); once it is safe, scripts/rat.sh resume, then run scripts/launch.sh again."
  fi
  ok "$(printf '%s' "$out" | grep '^launch-arm: armed:' | tail -1 || echo "kill switch ON (armed: waiting for the coin launch)")"
}
book_founders() { # founders_booked: how many founding rats were booked (WSR_FOUNDING_RATS, default 5, 0 = none): your
  # own SOL in the creator wallet books that many salaries as hire budget, so rats walk in before the fees cover one.
  # Never a creator fee (rat founders-seed); once only. A refusal is a note, never a stop.
  local n="${WSR_FOUNDING_RATS:-5}"
  founders_booked=0
  [ "$n" != 0 ] || return 0
  if rat founders-seed --rats "$n" --confirm "FOUNDERS $n RATS" >/dev/null 2>&1; then
    founders_booked=$n
  else
    note "the founding rats were not booked (not enough free SOL in the creator wallet, or already booked): scripts/rat.sh founders-seed --rats $n shows why"
  fi
}

# ---------------------------------------------------------------- where are we -----------------------------------------
mode=$(running_mode)
RESUME=""
if [ "$mode" = live ] && [ -n "$set_coin" ]; then
  # the worker already runs LIVE with its coin set: at most the last restart is left (a failed API build, or a run that
  # stopped between the coin's settings and the restart)
  ok "the bot already runs LIVE (coin $set_coin): nothing to launch"
  pre=$(rat_json preflight --live --json)
  if printf '%s' "$pre" | jq -e '.lines | type == "array"' >/dev/null 2>&1 && ! printf '%s' "$pre" | jq -e '.lines[] | select(.check == "coin")' >/dev/null 2>&1; then
    note "the running worker has not loaded the coin yet (the last run stopped before its restart)"
    if yes_no "Restart the worker and the API now so they load the coin (hiring pauses about a minute)?" y; then
      (WSR_REUSE_BUILD=1; redeploy worker api) || die "the restart did not finish" "Railway dashboard: Deployments shows why. The bot keeps running LIVE meanwhile."
      ok "the worker and the API run with the coin's settings"
    fi
  elif [ "$(rw_var api DRY_RUN)" = false ] && yes_no "Redeploy the API too (only needed if its last build failed, so the site still shows DRY RUN)?" n; then
    (redeploy api) || die "the API did not start" "Railway dashboard: api > Deployments shows why. The bot itself runs LIVE."
    ok "the API runs with the live settings"
  fi
  exit 0
elif [ "$mode" = live ]; then
  is_slot "$set_floor" || die "the worker runs LIVE without COIN_MINT and without WATCH_FROM_SLOT: not armed by this script" \
    "Railway dashboard: worker > Variables: set DRY_RUN=true, redeploy the worker, then run this again."
  RESUME=armed
elif [ "$mode" = dry_run ]; then
  if [ -n "$set_coin" ]; then
    is_slot "$set_floor" || die "the worker has COIN_MINT=$set_coin but no WATCH_FROM_SLOT: a half-finished launch this script cannot resume" "Railway dashboard: worker > Variables: add WATCH_FROM_SLOT (the slot right after the launch), then run this again."
    RESUME=coin
    note "a previous run already set the coin $set_coin (watch floor $set_floor) but the bot never went live: this run finishes it"
  elif [ "$set_dry" != true ]; then
    # an arm that stopped between the settings and the restart: arm again (a new watch floor, the coin does not exist yet)
    { is_slot "$set_floor" && [ "$set_claim" = 15 ]; } || die "the worker is set to LIVE (DRY_RUN is not true) but has no COIN_MINT: not a launch this script started" "Railway dashboard: worker > Variables: set DRY_RUN=true, then run this again."
    note "an earlier arm set the live settings but the bot never restarted: arming again"
  fi
else
  die "the running worker did not answer (railway ssh): ${mode:-no answer}" "Check it: scripts/rat.sh status, then run this again."
fi
if [ "$RESUME" = armed ]; then
  ok "${REHEARSAL:+REHEARSAL: }project $pname, creator wallet $creator, the bot already ARMED (LIVE, watch floor $set_floor): going on from the launch"
else
  ok "${REHEARSAL:+REHEARSAL: }project $pname, creator wallet $creator, the bot in DRY RUN"
fi

# ---------------------------------------------------------------- a coin set before the bot went live -------------------
if [ "$RESUME" = coin ]; then
  # an earlier run set COIN_MINT on a DRY RUN worker: the coin's settings are all there, one checked change finishes it
  LAUNCH_MINT=$set_coin
  LAUNCH_SLOT=$((set_floor - 1))
  LAUNCH_SIGS=$set_sigs
  yes_no "Is $LAUNCH_MINT your coin (the mint shown on pump.fun)?" y || die "not your coin: nothing was changed" "Railway dashboard: worker > Variables: remove COIN_MINT, set DRY_RUN=true, then run this again."
  rat announce-ca "$LAUNCH_MINT" >/dev/null 2>&1 || note "the site could not be told about the coin yet: it shows it once the bot is live"
  say "Checking the live preflight with the coin's settings (read-only, nothing changes)..."
  pre=$(preflight_launch)
  printf '%s' "$pre" | jq -e '.lines | type == "array"' >/dev/null 2>&1 ||
    die "the live preflight gave no answer (railway ssh to the worker): nothing was changed" "Run scripts/launch.sh again in a minute."
  show_preflight "$pre"
  for chk in "launch txs" "dev buy"; do preflight_pass "$pre" "$chk" || die "preflight $chk is not PASS with the coin's settings: nothing was changed" "The line above says why."; done
  problems=$(preflight_problems "$pre" ${REHEARSAL:+"kill switch"})
  [ -z "$problems" ] || die "preflight --live is not READY with the coin's settings: nothing was changed" "$(printf '%s' "$problems" | head -3 | tr '\n' ';')"
  ok "preflight --live with the coin's settings: READY"
  printf '\n  %sTHIS TURNS THE BOT LIVE: IT SENDS MAINNET TRANSACTIONS%s\n' "$B$R" "$N"
  printf '  Type GO to go live now (anything else stops, nothing is changed): '
  read -r a || die "no keyboard input (end of input)"
  [ "$a" = GO ] || die "no GO: nothing was changed, the bot stays in DRY RUN"
  rat dry-run-reset --yes >/dev/null || die "rat dry-run-reset failed: nothing was changed on Railway" "Run scripts/launch.sh again."
  (apply_launch) || die "Railway did not keep every launch setting: the bot still runs in DRY RUN, nothing was redeployed" "Run scripts/launch.sh again in a few minutes (status.railway.com)."
  ok "every launch setting set on the worker and the API (read back)"
  (WSR_REUSE_BUILD=1; redeploy worker api) || die "the redeploy did not finish" "Once Railway builds again (Deployments shows why), run scripts/launch.sh again."
  live_or_die "Then run scripts/launch.sh again."
  [ "$(kill_on "$st")" = false ] || note "the kill switch is ON: the bot sends nothing until you resume it (admin page, or scripts/rat.sh resume)"
  book_founders
  [ "$founders_booked" = 0 ] || ok "$founders_booked founding rats booked"
  problems=$(preflight_problems "$(rat_json preflight --live --json)")
  [ -z "$problems" ] || note "preflight --live now says: $(printf '%s' "$problems" | head -3 | tr '\n' ';')"
  printf '\n  %sLIVE%s  the bot runs. Coin %s\n' "$B$G" "$N" "$LAUNCH_MINT"
  exit 0
fi

# ---------------------------------------------------------------- 1 + 2. arm, before the coin exists ---------------------
REGISTER=y
if [ "$RESUME" != armed ]; then
  check_balance
  say "Checking the preflight before the arm (read-only, nothing changes)..."
  # the live checks the armed bot runs with (read-only). Without the coin, its own lines, the watch floor and the kill
  # switch cannot pass yet: every other FAIL stops here.
  pre=$(rat_json --with DRY_RUN=false --with "LIVE_CONFIRM=$LIVE_PHRASE" preflight --live --json)
  printf '%s' "$pre" | jq -e '.lines | type == "array"' >/dev/null 2>&1 ||
    die "the preflight gave no answer (railway ssh to the worker): nothing was changed" "Run scripts/launch.sh again in a minute."
  show_preflight "$pre"
  problems=$(arm_problems "$pre")
  [ -z "$problems" ] || die "the preflight has a FAIL that is not expected before the coin: nothing was changed" "$(printf '%s' "$problems" | head -3 | tr '\n' ';')"
  ok "preflight: READY for the arm (the coin's own lines pass once it exists)"

  printf '\n  %sTHIS ARMS THE BOT LIVE: FROM NOW ON IT CAN SEND MAINNET TRANSACTIONS%s\n' "$B$R" "$N"
  say "The bot restarts LIVE with its kill switch ON and waits 30 minutes for your coin; it sends nothing meanwhile."
  say "Once you paste the CA, the switch is released: it claims the creator fees and hires rats with real SOL, up to the"
  say "hourly cap. KILL on the admin page (or scripts/rat.sh kill) stops it at any moment."
  printf '  Type GO to arm the bot now (anything else stops, nothing is changed): '
  read -r a || die "no keyboard input (end of input)"
  [ "$a" = GO ] || die "no GO: nothing was changed, the bot stays in DRY RUN"

  state_set "$LSTATE" LAUNCH_CA ""
  state_set "$LSTATE" LAUNCH_TX_SIGS ""
  rat dry-run-reset --yes >/dev/null || die "rat dry-run-reset failed: nothing was changed on Railway" "Run scripts/launch.sh again."
  if [ -n "$REHEARSAL" ]; then # the staging kill switch stays ON between rehearsals: the arm engages its own
    rat resume >/dev/null 2>&1 || note "rehearsal: rat resume failed (the arm engages the kill switch anyway)"
  fi
  arm_or_die "nothing was changed on Railway, the bot stays in DRY RUN"
  slot=$(rpc getSlot '[{"commitment":"confirmed"}]')
  is_slot "$slot" || die "could not read the current slot (RPC): the bot stays in DRY RUN, kill switch ON" "Run scripts/launch.sh again in a few seconds."
  if ! (set_vars worker DRY_RUN=false "LIVE_CONFIRM=$LIVE_PHRASE" CLAIM_INTERVAL_SEC=15 "WATCH_FROM_SLOT=$((slot + 1))" &&
    set_vars api DRY_RUN=false "LIVE_CONFIRM=$LIVE_PHRASE" CLAIM_INTERVAL_SEC=15); then
    die "Railway did not keep every live setting: the bot still runs in DRY RUN (kill switch ON), nothing was restarted" \
      "Run scripts/launch.sh again in a few minutes (status.railway.com): it arms again."
  fi
  ok "the live settings are on the worker (watch floor $((slot + 1))) and the API (read back)"
  (WSR_REUSE_BUILD=1; redeploy worker api) ||
    die "the restart did not finish: the settings are LIVE on Railway, the old DRY RUN bot may still be running" \
      "Once Railway deploys again (Deployments shows why), run scripts/launch.sh again: it goes on from where it stopped."
  live_or_die "Then run scripts/launch.sh again: it goes on from where it stopped."
  [ "$(kill_on "$st")" = true ] || die "the bot runs LIVE but its kill switch is OFF before the coin exists" "Run now: scripts/rat.sh launch-arm (or KILL on the admin page), then scripts/launch.sh again."
  book_founders
  printf '\n  %sARMED%s  the bot is live and waiting, kill switch on, %s founding rats funded\n' "$B$G" "$N" "$founders_booked"
  before=$(latest_signature "$creator")
  [ -n "$before" ] || die "could not read the creator wallet's latest transaction (the RPC did not answer after 3 tries)" \
    "The bot is ARMED and sends nothing. Do not create the coin yet: run scripts/launch.sh again in a few seconds, it goes on from here."
  tell_launch
  find_coin "$before"
else
  # ARMED by an earlier run: the coin may exist already
  saved_mint=$(state_get "$LSTATE" LAUNCH_CA)
  saved_sigs=$(state_get "$LSTATE" LAUNCH_TX_SIGS)
  if [ -n "$saved_mint" ] && [ -n "$saved_sigs" ] && yes_no "The last run found your coin $saved_mint (launch $saved_sigs): is that your coin?" y; then
    LAUNCH_MINT=$saved_mint
    LAUNCH_SIGS=$saved_sigs
    # the last run may have registered it already: the armed kill switch is then off
    if [ "$(kill_on "$(rat_json status --json)")" = false ]; then REGISTER=n; fi
  elif yes_no "Did you already create the coin on pump.fun?" n; then
    find_coin "$(signature_before_floor "$set_floor")"
  else
    # a new 30-minute window for the launch (the first one may have run out)
    arm_or_die "the bot runs LIVE without its coin"
    before=$(latest_signature "$creator")
    [ -n "$before" ] || die "could not read the creator wallet's latest transaction (the RPC did not answer after 3 tries)" \
      "The bot is ARMED and sends nothing. Do not create the coin yet: run scripts/launch.sh again in a few seconds."
    tell_launch
    find_coin "$before"
  fi
fi
state_set "$LSTATE" LAUNCH_CA "$LAUNCH_MINT"
state_set "$LSTATE" LAUNCH_TX_SIGS "$LAUNCH_SIGS"

# ---------------------------------------------------------------- 3. register: the bot hires ---------------------------
if [ "$REGISTER" = y ]; then
  reg=""
  rc=1
  for i in 1 2 3 4 5; do # the coin can take a moment to be readable on chain
    rc=0
    reg=$(rat launch-register "$LAUNCH_MINT" --sigs "$LAUNCH_SIGS" 2>&1) || rc=$?
    [ "$rc" = 0 ] && break
    [ "$i" = 5 ] || sleep "${WSR_POLL_SEC:-2}"
  done
  [ "$rc" = 0 ] || die "rat launch-register refused the coin $LAUNCH_MINT (5 tries): the bot stays ARMED and sends nothing" \
    "$(printf '%s' "$reg" | grep . | tail -1)" \
    "Run scripts/launch.sh again in a few seconds: it goes on from here with the same coin (never create a second one)."
  # registered, but the kill switch stays ON when its reason is not the arm's (someone pressed KILL meanwhile)
  printf '%s' "$reg" | grep -q "kill switch released" ||
    die "the coin $LAUNCH_MINT is registered but the kill switch is still ON: the bot sends nothing" \
      "$(printf '%s' "$reg" | grep . | tail -1)" \
      "Check the reason (scripts/rat.sh status); once it is safe: scripts/rat.sh resume, then run scripts/launch.sh again (it finishes the coin's settings)."
fi
ok "LIVE: the CA is on the site, the founding rats walk in within about 30 s, fee claims started"

# ---------------------------------------------------------------- 4. finish, no hurry ----------------------------------
say "Now the coin goes into the settings (dev-buy protection, the bot's own price): one restart, hiring pauses about a minute."
(set_vars worker "COIN_MINT=$LAUNCH_MINT" "KNOWN_OWNER_TX_SIGS=$LAUNCH_SIGS" && set_vars api "COIN_MINT=$LAUNCH_MINT") ||
  die "Railway did not keep the coin's settings: the bot keeps hiring LIVE meanwhile" "Run scripts/launch.sh again in a few minutes: it finishes this step."
(WSR_REUSE_BUILD=1; redeploy worker api) ||
  die "the restart did not finish: the coin's settings are on Railway" "Once Railway deploys again (Deployments shows why), run scripts/launch.sh again: it restarts what is left."
live_or_die "Running scripts/launch.sh again only restarts what is left."
state_set "$LSTATE" LAUNCH_CA ""
state_set "$LSTATE" LAUNCH_TX_SIGS ""
[ "$(kill_on "$st")" = false ] || note "the kill switch is ON: the bot sends nothing until you resume it (admin page, or scripts/rat.sh resume)"
problems=$(preflight_problems "$(rat_json preflight --live --json)")
[ -z "$problems" ] || note "preflight --live now says: $(printf '%s' "$problems" | head -3 | tr '\n' ';')"
mins=""
[ -n "$LAUNCH_TIME" ] && mins=" $((($(date +%s) - LAUNCH_TIME + 59) / 60)) minutes after the coin was created"
printf '\n  %sLIVE%s  the bot runs with its coin%s. Coin %s\n' "$B$G" "$N" "$mins" "$LAUNCH_MINT"
say "Watch: the admin page (mode LIVE), the first claim on Solscan (creator wallet), the first rats on the site."
