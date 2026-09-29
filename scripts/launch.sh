#!/bin/bash
# Launch day in ONE Railway build (LAUNCH-DAY.md). Run it from ~/wallstreetrats BEFORE you launch the coin:
#   scripts/launch.sh
# 1. It notes the creator wallet's last transaction, then waits while YOU launch on pump.fun in Phantom.
# 2. It finds the launch on chain (the signatures, the last slot, the coin's mint); you confirm the mint.
# 3. It checks the live preflight WITH the coin's settings before anything changes (read-only): every line must pass.
# 4. It waits for your GO. From then on the bot claims the creator fees and hires rats with real SOL.
# 5. Every launch setting in one change (worker: COIN_MINT, WATCH_FROM_SLOT, KNOWN_OWNER_TX_SIGS, DRY_RUN=false,
#    LIVE_CONFIRM; API: COIN_MINT, DRY_RUN=false), the DRY RUN paper data cleared, then ONE redeploy of the worker and
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
[ "$(printf '%s' "$vars" | jq -r '.DRY_RUN // "true"')" = true ] || die "the worker is already set to LIVE (DRY_RUN is not true): nothing to launch" "Check it: scripts/rat.sh status"
unset vars
mode=$(rat_json status --json | jq -r '.mode // empty' 2>/dev/null || true)
[ "$mode" = dry_run ] || die "the running worker is not in DRY RUN (${mode:-no answer}): nothing to launch" "Check it: scripts/rat.sh status"
ok "production project $pname, creator wallet $creator, the bot in DRY RUN"

# ---------------------------------------------------------------- 1. you launch -----------------------------------------
bal=$(sol_balance "$creator")
[ -n "$bal" ] || die "could not read the creator wallet's balance (RPC)"
say "The creator wallet holds $(lamports_to_sol "$bal") SOL."
[ "$bal" -ge 200000000 ] || die "the creator wallet holds less than 0.2 SOL" "Send it about 0.3 SOL first: 0.1 dev buy + launch cost + 0.05 reserve + spare (LAUNCH-DAY.md)."
before=$(latest_signature "$creator")
say "Now launch the coin in Phantom, with the CREATOR wallet $creator:"
say "1. pump.fun > Create coin: normal mode, no holder rewards, no fee sharing."
say "2. Dev buy 0.1 SOL, inside the launch. The dev-buy coins stay in the creator wallet forever."
say "3. After this, never sign anything else with the creator wallet: the bot treats it as a leaked key."
pause "When Solscan shows the launch as Finalized, press Enter."

# ---------------------------------------------------------------- 2. the launch on chain -------------------------------
if find_launch "$creator" "$before"; then
  say "Found: the launch signature(s) $LAUNCH_SIGS, last slot $LAUNCH_SLOT"
  say "Coin mint: ${LAUNCH_MINT:-not found}"
  yes=n
  [ -n "$LAUNCH_MINT" ] && yes_no "Is that your coin (the mint shown on pump.fun)?" y && yes=y
  [ "$yes" = y ] || ask_launch
else
  note "no new finalized transaction from the creator wallet (was the coin launched before this script started?)"
  ask_launch
fi

# ---------------------------------------------------------------- 3. the live preflight, before anything changes --------
say "Checking the live preflight with the coin's settings (read-only, nothing changes)..."
pre=$(preflight_launch)
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
rat dry-run-reset --yes >/dev/null || die "rat dry-run-reset failed: nothing was changed on Railway" "Run this script again."
apply_launch
ok "every launch setting set on the worker and the API (read back)"
if ! (redeploy worker api); then
  die "the redeploy did not finish: the settings are LIVE on Railway, the old DRY RUN bot may still be running" \
    "Railway dashboard: worker and api > Deployments > Deploy the latest commit. Then check: scripts/rat.sh status"
fi

# ---------------------------------------------------------------- 6. live -----------------------------------------------
st=$(rat_json status --json)
[ "$(printf '%s' "$st" | jq -r '.mode // empty')" = live ] || die "the worker is not LIVE after the redeploy" "Check: scripts/rat.sh status, and the worker's logs on Railway."
[ "$(printf '%s' "$st" | jq -r '.killSwitch.on // empty')" = false ] || note "the kill switch is ON: the bot sends nothing until you resume it (admin page, or scripts/rat.sh resume)"
pre=$(rat_json preflight --live --json)
problems=$(preflight_problems "$pre")
[ -z "$problems" ] || note "preflight --live now says: $(printf '%s' "$problems" | head -3 | tr '\n' ';')"
mins=""
[ -n "$LAUNCH_TIME" ] && mins=" $((($(date +%s) - LAUNCH_TIME + 59) / 60)) minutes after the coin was created"
printf '\n  %sLIVE%s  the bot runs%s. Coin %s\n' "$B$G" "$N" "$mins" "$LAUNCH_MINT"
say "Watch: the admin page (mode LIVE), the first claim on Solscan (creator wallet), the first rats on the site."
