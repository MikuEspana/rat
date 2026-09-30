#!/bin/bash
# Launch day in ONE Railway build (LAUNCH-DAY.md). Run it from ~/wallstreetrats BEFORE you launch the coin:
#   scripts/launch.sh
# 1. It notes the creator wallet's last transaction, then waits while YOU launch on pump.fun in Phantom.
# 2. It finds the launch on chain (the signatures, the last slot, the coin's mint); you confirm the mint.
# 3. It checks the live preflight WITH the coin's settings before anything changes (read-only): every line must pass.
# 4. It waits for your GO. From then on the bot claims the creator fees and hires rats with real SOL.
# 5. Every launch setting in one change (worker: COIN_MINT, WATCH_FROM_SLOT, KNOWN_OWNER_TX_SIGS, DRY_RUN=false,
#    LIVE_CONFIRM; API: COIN_MINT, DRY_RUN=false, LIVE_CONFIRM), the DRY RUN paper data cleared, then ONE redeploy of the worker and
#    the API, side by side.
# 6. It checks the bot is LIVE, the kill switch off, and preflight --live READY.
# Only in the production folder, never with STAGING, never on a worker that is already live. The same steps are
# rehearsed by scripts/staging.sh phase 1 (scripts/lib/launch.sh). Nothing here needs or prints a secret.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/wsr.sh
. scripts/lib/wsr.sh
# shellcheck source=scripts/lib/launch.sh
. scripts/lib/launch.sh
SECRETS="${WSR_SECRETS:-$HOME/rat-secrets}"
STATE="$SECRETS/setup-state.env"
PRODUCTION_CREATOR="4VYWcTTDYyMVic58AcUC7Nodt6vNQwjKhA9UphaAKiot"
for t in jq curl; do command -v "$t" >/dev/null 2>&1 || die "$t is missing" "Run: brew install $t"; done

title "Launch: the coin, then the bot LIVE in one build"
# ---------------------------------------------------------------- only production, only once --------------------------
pid=$(rw status --json 2>/dev/null | jq -r '.id // empty' 2>/dev/null || true)
pname=$(rw status --json 2>/dev/null | jq -r '.name // empty' 2>/dev/null || true)
[ -n "$pid" ] || die "this folder ($PWD) is not linked to a Railway project" "Run it from ~/wallstreetrats (scripts/setup-mac.sh set it up)."
[ "$pid" = "$(state_get "$STATE" RAILWAY_PROJECT_ID)" ] || die "this folder is linked to $pname, not the production project in $STATE" "Run it from ~/wallstreetrats."
case "$(state_get "$STATE" PROFILE):$pname" in staging:* | *:*-staging) die "this is the staging project: the rehearsal launches with scripts/staging.sh 1" ;; esac
vars=$(rw_vars worker) || die "Railway did not list the worker's variables" "$API_HINT"
[ "$(printf '%s' "$vars" | jq -r '.STAGING // ""')" != true ] || die "STAGING is on for this worker: not the production bot"
creator=$(printf '%s' "$vars" | jq -r '.CREATOR_PUBKEY // ""')
[ "$creator" = "$PRODUCTION_CREATOR" ] || die "the worker's CREATOR_PUBKEY is ${creator:-not set}, not the creator wallet $PRODUCTION_CREATOR"
# the RPC address, once (its API key stays in this shell's memory): every chain read below reuses it
RPC_URL=$(printf '%s' "$vars" | jq -r '.RPC_URL // ""')
# A previous run that stopped halfway (Railway failed a write, a build failed) left the coin's settings on the worker:
# this run finishes it instead of asking for the launch again.
set_coin=$(printf '%s' "$vars" | jq -r '.COIN_MINT // ""')
set_floor=$(printf '%s' "$vars" | jq -r '.WATCH_FROM_SLOT // ""')
set_sigs=$(printf '%s' "$vars" | jq -r '.KNOWN_OWNER_TX_SIGS // ""')
set_dry=$(printf '%s' "$vars" | jq -r '.DRY_RUN // "true"')
unset vars
mode=$(running_mode)
if [ "$mode" = live ]; then
  # the worker already runs LIVE: only the API may be left behind (its build failed after the worker's went through)
  ok "the bot already runs LIVE (coin ${set_coin:-?}): nothing to launch"
  if [ "$(rw_var api DRY_RUN)" = false ] && yes_no "Redeploy the API too (only needed if its last build failed, so the site still shows DRY RUN)?" n; then
    (redeploy api) || die "the API did not start" "Railway dashboard: api > Deployments shows why. The bot itself runs LIVE."
    ok "the API runs with the live settings"
  fi
  exit 0
fi
[ "$mode" = dry_run ] || die "the running worker did not answer (railway ssh): ${mode:-no answer}" "Check it: scripts/rat.sh status, then run this again."
if [ -n "$set_coin" ]; then
  case "$set_floor" in '' | *[!0-9]*) die "the worker has COIN_MINT=$set_coin but no WATCH_FROM_SLOT: a half-finished launch this script cannot resume" "Railway dashboard: worker > Variables: add WATCH_FROM_SLOT (the slot right after the launch), then run this again." ;; esac
  LAUNCH_MINT=$set_coin
  LAUNCH_SLOT=$((set_floor - 1))
  LAUNCH_SIGS=$set_sigs
  RESUME=y
  note "a previous run already set the coin $set_coin (watch floor $set_floor) but the bot never went live: this run finishes it"
elif [ "$set_dry" != true ]; then
  die "the worker is set to LIVE (DRY_RUN is not true) but has no COIN_MINT: not a launch this script started" "Railway dashboard: worker > Variables: set DRY_RUN=true, then run this again."
fi
ok "production project $pname, creator wallet $creator, the bot in DRY RUN"

if [ "${RESUME:-}" = y ]; then
  yes_no "Is $LAUNCH_MINT your coin (the mint shown on pump.fun)?" y || die "not your coin: nothing was changed" "Railway dashboard: worker > Variables: remove COIN_MINT, set DRY_RUN=true, then run this again."
else
# ---------------------------------------------------------------- 1. you launch -----------------------------------------
bal=$(sol_balance "$creator")
[ -n "$bal" ] || die "could not read the creator wallet's balance (RPC)"
say "The creator wallet holds $(lamports_to_sol "$bal") SOL."
[ "$bal" -ge 200000000 ] || die "the creator wallet holds less than 0.2 SOL" "Send it about 0.3 SOL first: 0.1 dev buy + launch cost + 0.05 reserve + spare (LAUNCH-DAY.md)."
before=$(latest_signature "$creator")
say "Now launch the coin in Phantom, with the CREATOR wallet $creator:"
say "1. pump.fun > Create coin: name Wall Street Rats, ticker WSR. Normal mode: no holder rewards, no fee sharing, no cashback."
say "2. Dev buy 0.1 SOL, inside the launch. The dev-buy coins stay in the creator wallet forever."
say "3. After this, never sign anything else with the creator wallet: the bot treats it as a leaked key."
# the CA as soon as pump.fun shows it: the site shows the coin right away (rat announce-ca checks on chain that the
# creator wallet created it; it sends nothing), while this script waits for the launch to be finalized
printf '\n  %sPaste the CA%s (the coin address pump.fun shows) and press Enter.\n' "$B" "$N"
printf '  (No CA? Just press Enter once Solscan shows the launch Finalized.)  CA: '
IFS= read -r CA || die "no keyboard input (end of input)"
CA=$(printf '%s' "$CA" | tr -d '[:space:]')
ANNOUNCED=""
if [ -n "$CA" ]; then
  for i in 1 2 3 4 5 6; do # the coin can take a few seconds to be readable on chain
    if rat announce-ca "$CA" >/dev/null 2>&1; then ANNOUNCED=$CA; break; fi
    [ "$i" = 6 ] || sleep "${WSR_POLL_SEC:-3}"
  done
  if [ -n "$ANNOUNCED" ]; then
    ok "the site shows your coin now: CA $CA"
  else
    note "the site could not show $CA yet (not on chain yet, or not created by the creator wallet $creator): tried again once the launch is finalized"
  fi
fi
say "Waiting for the launch to be finalized on chain (usually under a minute)..."

# ---------------------------------------------------------------- 2. the launch on chain -------------------------------
if find_launch "$creator" "$before"; then
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
  note "no new finalized transaction from the creator wallet (was the coin launched before this script started?)"
  ask_launch
fi
fi

# the site shows the coin now, minutes before the bot is live (rat announce-ca: the creator is checked on chain; it sends
# nothing and changes nothing the bot uses). If it fails, the site shows the coin once the bot is live anyway.
if [ "${ANNOUNCED:-}" = "$LAUNCH_MINT" ]; then
  : # already on the site
elif rat announce-ca "$LAUNCH_MINT" >/dev/null 2>&1; then
  ok "the site shows coin $LAUNCH_MINT now (the bot goes live after your GO)"
else
  note "the site could not be told about the coin yet: in another tab run scripts/announce-ca.sh $LAUNCH_MINT"
fi

# ---------------------------------------------------------------- 3. the live preflight, before anything changes --------
say "Checking the live preflight with the coin's settings (read-only, nothing changes)..."
pre=$(preflight_launch)
printf '%s' "$pre" | jq -e '.lines | type == "array"' >/dev/null 2>&1 ||
  die "the live preflight gave no answer (railway ssh to the worker): nothing was changed" "Run scripts/launch.sh again in a minute: it finds the coin again and asks again."
show_preflight "$pre"
for chk in "launch txs" "dev buy"; do preflight_pass "$pre" "$chk" || die "preflight $chk is not PASS with the coin's settings: nothing was changed" "The line above says why."; done
problems=$(preflight_problems "$pre")
[ -z "$problems" ] || die "preflight --live is not READY with the coin's settings: nothing was changed" "$(printf '%s' "$problems" | head -3 | tr '\n' ';')"
ok "preflight --live with the coin's settings: READY"

# ---------------------------------------------------------------- 4. your GO ---------------------------------------------
printf '\n  %sTHIS TURNS THE BOT LIVE: IT SENDS MAINNET TRANSACTIONS%s\n' "$B$R" "$N"
say "Coin $LAUNCH_MINT. From now on the bot claims the creator fees and hires rats with real SOL, up to the"
say "hourly cap. KILL on the admin page (or scripts/rat.sh kill) stops it at any moment."
printf '  Type GO to go live now (anything else stops, nothing is changed): '
read -r a || die "no keyboard input (end of input)"
[ "$a" = GO ] || die "no GO: nothing was changed, the bot stays in DRY RUN"

# ---------------------------------------------------------------- 5. one change, one build -----------------------------
rat dry-run-reset --yes >/dev/null || die "rat dry-run-reset failed: nothing was changed on Railway" "Run scripts/launch.sh again."
if ! (apply_launch); then
  die "Railway did not keep every launch setting: the bot still runs in DRY RUN, nothing was redeployed" \
    "Run scripts/launch.sh again in a few minutes (status.railway.com): it finds the coin's settings and finishes."
fi
ok "every launch setting set on the worker and the API (read back)"
if ! (WSR_REUSE_BUILD=1; redeploy worker api); then
  die "the redeploy did not finish: the settings are LIVE on Railway, the old DRY RUN bot may still be running" \
    "Once Railway builds again (Deployments shows why), run scripts/launch.sh again: it redeploys and checks LIVE."
fi

# ---------------------------------------------------------------- 6. live -----------------------------------------------
# right after the build, railway ssh can still reach the old DRY RUN container while it drains, or drop: ask for up to
# two minutes before calling it
st=""
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  st=$(rat_json status --json)
  [ "$(printf '%s' "$st" | jq -r '.mode // empty' 2>/dev/null)" = live ] && break
  [ "$i" = 12 ] || sleep "${WSR_POLL_SEC:-10}"
done
case "$(printf '%s' "$st" | jq -r '.mode // empty' 2>/dev/null)" in
  live) ;;
  dry_run) die "the worker still runs in DRY RUN two minutes after its build" "Check the worker's variables (DRY_RUN=false, LIVE_CONFIRM) and its logs on Railway, then run scripts/launch.sh again." ;;
  *) die "the worker did not answer for two minutes after its build (railway ssh)" "Check: scripts/rat.sh status, and the worker's logs on Railway. Running scripts/launch.sh again only redeploys what is left." ;;
esac
[ "$(printf '%s' "$st" | jq -r '.killSwitch.on // empty')" = false ] || note "the kill switch is ON: the bot sends nothing until you resume it (admin page, or scripts/rat.sh resume)"
pre=$(rat_json preflight --live --json)
problems=$(preflight_problems "$pre")
[ -z "$problems" ] || note "preflight --live now says: $(printf '%s' "$problems" | head -3 | tr '\n' ';')"
mins=""
[ -n "$LAUNCH_TIME" ] && mins=" $((($(date +%s) - LAUNCH_TIME + 59) / 60)) minutes after the coin was created"
printf '\n  %sLIVE%s  the bot runs%s. Coin %s\n' "$B$G" "$N" "$mins" "$LAUNCH_MINT"
say "Watch: the admin page (mode LIVE), the first claim on Solscan (creator wallet), the first rats on the site."
