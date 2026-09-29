#!/bin/bash
# The mainnet rehearsal, one phase at a time (docs/runbooks/rehearsal.md). Run it from the staging folder:
#   ~/wallstreetrats-staging/scripts/staging.sh check      isolation checks (also run before every phase)
#   ~/wallstreetrats-staging/scripts/staging.sh 1 ... 8    the phases, in order
#   ~/wallstreetrats-staging/scripts/staging.sh teardown   get the SOL back, delete the project
#   ~/wallstreetrats-staging/scripts/staging.sh report     rehearsal-report.md with the GO / NO-GO line
#
# How money moves: the staging worker runs with its kill switch ON, which stops every bot transaction (an emergency
# sweep aside). A phase first shows what will be sent and how much SOL, then waits until you type GO, then turns
# the kill switch off, checks the result, and turns it back on, also if anything fails or you press Ctrl-C.
# Transactions you send yourself (the launch, test trades, teardown sales) happen in Phantom.
#
# It refuses to run unless this folder is linked to the staging project: STAGING=true on the worker, a test creator
# that is not the production one, a master key that differs from production's, and never the production project.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/wsr.sh
. scripts/lib/wsr.sh
APP_DIR=$PWD
SECRETS="${WSR_SECRETS:-$HOME/rat-secrets-staging}"
PROD_SECRETS="${WSR_PROD_SECRETS:-$HOME/rat-secrets}"
STATE="$SECRETS/setup-state.env"
RESULTS="$SECRETS/rehearsal-results.env"
REPORT="$APP_DIR/rehearsal-report.md"
PRODUCTION_CREATOR="4VYWcTTDYyMVic58AcUC7Nodt6vNQwjKhA9UphaAKiot"
SITE="https://wallstreetrats.world"

record() { # record PHASE STATUS "detail": one line per phase in the results file (no secrets)
  state_set "$RESULTS" "PHASE_$1" "$2|$(date -u +%Y-%m-%dT%H:%MZ)|$3"
  case "$2" in PASS) ok "phase $1: PASS $3" ;; *) bad "phase $1: $2 $3" ;; esac
}
result_of() { state_get "$RESULTS" "PHASE_$1" | cut -d'|' -f1; }
fail() { record "$PHASE" FAIL "$1"; die "phase $PHASE failed: $1" "Fix it, then run this phase again (docs/runbooks/rehearsal.md)."; }

# ---------------------------------------------------------------- guards ----------------------------------------------
st() { rat_json status --json; }                       # rat status --json (no secret in it)
st_get() { st | jq -r "$1" 2>/dev/null; }
isolation() { # prints problems, one per line ("" = isolated)
  local pid prod creator staging mk_s mk_p
  [ "$(state_get "$STATE" PROFILE)" = staging ] || echo "no staging setup state in $SECRETS: run scripts/setup-staging.sh first"
  pid=$(rw status --json 2>/dev/null | jq -r '.id // empty' 2>/dev/null || true)
  [ -n "$pid" ] || echo "this folder is not linked to a Railway project"
  [ -z "$pid" ] || [ "$pid" = "$(state_get "$STATE" RAILWAY_PROJECT_ID)" ] || echo "this folder is linked to project $pid, not the staging project"
  prod=$(state_get "$PROD_SECRETS/setup-state.env" RAILWAY_PROJECT_ID)
  [ -z "$prod" ] || [ "$pid" != "$prod" ] || echo "this folder is linked to the PRODUCTION project"
  creator=$(rw_var worker CREATOR_PUBKEY)
  { [ -n "$creator" ] && [ "$creator" != "$PRODUCTION_CREATOR" ]; } || echo "the worker's CREATOR_PUBKEY is ${creator:-not set} (it must be the test creator)"
  staging=$(rw_var worker STAGING)
  [ "$staging" = true ] || echo "STAGING is not true on the worker"
  if [ -f "$PROD_SECRETS/KEY_ENCRYPTION_KEY.txt" ]; then # compared as hashes: no key leaves its pipe
    mk_p=$(tr -d '\n' <"$PROD_SECRETS/KEY_ENCRYPTION_KEY.txt" | shasum -a 256 | cut -c1-64)
    if ! mk_s=$(rw_vars worker | jq -j '.KEY_ENCRYPTION_KEY // ""' | shasum -a 256 | cut -c1-64); then
      echo "Railway did not list the worker's variables, so its master key could not be compared with production's"
    elif [ "$mk_s" = "$mk_p" ]; then
      echo "the staging worker has the PRODUCTION master key"
    fi
  fi
  return 0
}
guard() {
  local p
  p=$(isolation)
  [ -z "$p" ] || die "not the staging project, nothing was done" "$(printf '%s' "$p" | head -1)" "All problems: scripts/staging.sh check"
}
creator() { rw_var worker CREATOR_PUBKEY; }

# ---------------------------------------------------------------- the GO gate and the kill switch ----------------------
OPEN=0
gate_close() {
  if [ "$OPEN" = 1 ]; then
    if rat kill --reason "staging: phase ${PHASE:-?} closed" >/dev/null 2>&1; then ok "kill switch ON again"; else bad "could not turn the kill switch back on: run scripts/rat.sh kill NOW"; fi
    OPEN=0
  fi
}
trap gate_close EXIT
trap 'printf "\n"; exit 130' INT TERM
go_gate() { # go_gate "what is sent" "SOL": waits for the exact word GO
  local a
  printf '\n  %sTHIS SENDS MAINNET TRANSACTIONS%s\n' "$B$R" "$N"
  say "What: $1"
  say "SOL:  $2"
  printf '  Type GO to do it now (anything else stops, nothing is sent): '
  read -r a || die "no keyboard input (end of input)"
  [ "$a" = GO ] || { record "$PHASE" SKIP "no GO given"; exit 1; }
}
gate_open() {
  [ "$(st_get '.killSwitch.on')" = true ] || die "the kill switch was already off before this phase" "Turn it on first: scripts/rat.sh kill --reason staging"
  OPEN=1
  rat resume >/dev/null || die "could not turn the kill switch off"
  ok "kill switch OFF: the bot may send now"
}
wait_for() { # wait_for "what" seconds 'jq condition on rat status --json'
  local i=0 s
  say "Waiting for: $1 (up to $(($2 / 60)) min)..."
  while :; do
    s=$(st)
    if [ -n "$s" ] && printf '%s' "$s" | jq -e "$3" >/dev/null 2>&1; then return 0; fi
    i=$((i + ${WSR_POLL_SEC:-15}))
    [ "$i" -ge "$2" ] && return 1
    sleep "${WSR_POLL_SEC:-15}"
  done
}
audit_ok() { # audit_ok: rat audit until PASS (WAIT is retried); prints the lines; returns 1 on FAIL
  local a i
  for i in 1 2 3 4 5 6; do
    a=$(rat_json audit --json)
    printf '%s' "$a" | jq -r '.lines[]? | "        \(.status)  \(.check): \(.detail)"' 2>/dev/null || true
    printf '%s' "$a" | jq -e '[.lines[]?.status] | length > 0 and all(. == "PASS")' >/dev/null 2>&1 && return 0
    printf '%s' "$a" | jq -e '[.lines[]?.status] | any(. == "FAIL")' >/dev/null 2>&1 && return 1
    [ "$i" -lt 6 ] && sleep "${WSR_POLL_SEC:-15}"
  done
  return 1
}
api_state() { curl -fsS -m 20 "https://$(state_get "$STATE" API_DOMAIN)/api/state" 2>/dev/null || true; }
approx() { awk -v a="$1" -v b="$2" -v t="${3:-0.000000001}" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d <= t) }'; } # |a-b| <= t

# ---------------------------------------------------------------- phases -----------------------------------------------
phase_check() {
  local p
  title "Isolation checks"
  p=$(isolation)
  if [ -n "$p" ]; then
    printf '%s\n' "$p" | while IFS= read -r l; do bad "$l"; done
    record 0 FAIL "$(printf '%s' "$p" | head -1)"
    exit 1
  fi
  ok "staging project $(rw status --json 2>/dev/null | jq -r '.name // "?"'), not production"
  ok "test creator $(creator), STAGING=true, master key differs from production"
  [ "$(st_get '.staging')" = true ] || { record 0 FAIL "the worker does not run with STAGING"; exit 1; }
  [ "$(st_get '.killSwitch.on')" = true ] || note "the kill switch is OFF (every phase starts with it ON): scripts/rat.sh kill --reason staging"
  record 0 PASS "separate project, test creator, own master key, STAGING on"
}

phase_1() { # the launch (yours, in Phantom), then the bot's live settings with the kill switch ON
  local c before start sigs slot mint i new yes pre bad_lines s chk
  title "Phase 1: launch the test coin"
  c=$(creator)
  [ "$(st_get '.killSwitch.on')" = true ] || die "the kill switch must be ON before phase 1" "Run: scripts/rat.sh kill --reason staging"
  start=$(sol_balance "$c")
  [ -n "$start" ] || die "could not read the test creator's balance"
  state_get "$RESULTS" CREATOR_START_LAMPORTS | grep -q . || state_set "$RESULTS" CREATOR_START_LAMPORTS "$start"
  say "Test creator $c holds $(lamports_to_sol "$start") SOL."
  [ "$start" -ge 300000000 ] || die "the test creator holds less than 0.3 SOL" "Send it 0.47 SOL from a wallet unrelated to the real launch, then run phase 1 again."
  before=$(rpc getSignaturesForAddress "[\"$c\",{\"limit\":1}]" | jq -r '.[0].signature // empty')
  go_gate "YOU launch the test coin on pump.fun from the test creator in Phantom (the bot sends nothing)" \
    "about 0.02 launch cost + 0.1 dev buy = about 0.12 SOL from the test creator"
  say "1. pump.fun > Create coin, connected with the TEST CREATOR account in Phantom."
  say "2. Name: TEST DO NOT BUY   Ticker: TESTNOBUY   Image: a plain grey square (nothing from the real project)."
  say "3. No website, no X, no Telegram. Normal mode, no holder rewards, no fee sharing."
  say "4. Dev buy: 0.1 SOL, inside the launch. Confirm in Phantom."
  pause "When Solscan shows the launch as Finalized, press Enter."
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    sigs=$(rpc getSignaturesForAddress "[\"$c\",{\"limit\":20,\"commitment\":\"finalized\"}]" |
      jq -c --arg b "$before" '[.[] | select(.err == null)] | (map(.signature) | index($b)) as $i | if $i == null then . else .[:$i] end')
    [ "$(printf '%s' "$sigs" | jq 'length')" -gt 0 ] && break
    sleep 10
  done
  [ "$(printf '%s' "$sigs" | jq 'length')" -gt 0 ] || fail "no finalized transaction from the test creator after the launch"
  slot=$(printf '%s' "$sigs" | jq '[.[].slot] | max')
  new=$(printf '%s' "$sigs" | jq -r '[.[].signature] | join(",")')
  mint=""
  for s in $(printf '%s' "$sigs" | jq -r '.[].signature'); do
    mint=$(rpc getTransaction "[\"$s\",{\"encoding\":\"jsonParsed\",\"maxSupportedTransactionVersion\":0,\"commitment\":\"finalized\"}]" |
      jq -r --arg c "$c" '[.meta.postTokenBalances[]? | select(.owner == $c and (.uiTokenAmount.amount | tonumber) > 0) | .mint] | first // empty')
    [ -n "$mint" ] && break
  done
  say "Found: $(printf '%s' "$sigs" | jq length) transaction(s) signed by the test creator, last slot $slot"
  say "Coin mint: ${mint:-not found}"
  yes=n
  [ -n "$mint" ] && yes_no "Is that your launch (mint shown on pump.fun)?" y && yes=y
  if [ "$yes" != y ]; then
    ask mint "Coin mint address (from pump.fun):"
    ask new "Launch signature(s), comma separated (Solscan, test creator page):"
    ask slot "Slot of the last one:"
  fi
  set_vars worker "COIN_MINT=$mint" "WATCH_FROM_SLOT=$((slot + 1))" "KNOWN_OWNER_TX_SIGS=$new"
  set_vars api "COIN_MINT=$mint"
  redeploy worker
  redeploy api
  pre=$(rat_json preflight --json)
  for chk in "launch txs" "dev buy"; do
    printf '%s' "$pre" | jq -e --arg k "$chk" '.lines[] | select(.check == $k and .status == "PASS")' >/dev/null 2>&1 ||
      fail "preflight $chk is not PASS: $(printf '%s' "$pre" | jq -r --arg k "$chk" '.lines[] | select(.check == $k) | .detail' 2>/dev/null)"
    ok "preflight $chk: PASS"
  done
  rat dry-run-reset --yes >/dev/null || fail "rat dry-run-reset failed"
  say "Now the staging worker goes LIVE with its kill switch ON: it sends nothing until a phase opens it after your GO."
  yes_no "Switch the staging worker and API to LIVE?" y || { record 1 SKIP "stayed in DRY RUN"; exit 1; }
  set_vars worker DRY_RUN=false LIVE_CONFIRM=I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS
  set_vars api DRY_RUN=false
  redeploy worker
  redeploy api
  [ "$(st_get '.mode')" = live ] || fail "the worker is not live"
  [ "$(st_get '.killSwitch.on')" = true ] || fail "the kill switch is not ON after going live"
  pre=$(rat_json preflight --live --json)
  bad_lines=$(printf '%s' "$pre" | jq -r '.lines[] | select(.status == "FAIL" and .check != "kill switch") | "\(.check): \(.detail)"' 2>/dev/null)
  if [ -z "$pre" ] || [ -n "$bad_lines" ]; then fail "preflight --live: ${bad_lines:-no answer}"; fi
  [ "$(st_get '.claims')" = 0 ] || fail "the live ledger already has claims"
  record 1 PASS "coin $mint, launch txs and dev buy PASS, live with the kill switch ON, preflight --live READY but the switch"
}

phase_2() { # the first fee claim
  local before
  title "Phase 2: the bot claims the creator fees"
  [ "$(result_of 1)" = PASS ] || die "run phase 1 first"
  before=$(st_get '.claims')
  say "From YOUR trading wallet (never the test creator): buy 0.05 SOL of TEST DO NOT BUY, twice, then sell both."
  say "That makes about 0.3 SOL of volume: about 0.0009 SOL of creator fees (0.30%), above MIN_CLAIM_SOL 0.0003."
  pause "Done trading? Press Enter."
  go_gate "the bot claims the creator fees: 1 transaction from the test creator, moving the fees from pump.fun's vault to it" \
    "under 0.0001 SOL of network fees; it RECEIVES about 0.0009 SOL"
  gate_open
  wait_for "a confirmed claim" 600 ".claims > $before and .openReservations == 0" || fail "no claim within 10 minutes"
  gate_close
  audit_ok || fail "rat audit is not PASS"
  record 2 PASS "claimed $(st_get '.claimedSol') SOL, every claim equals what left the fee vaults, to the lamport"
}

phase_3() { # seed and 5 hires at the real salary
  local rats0 pre seed st_now claimed seeded api stage
  title "Phase 3: seed 0.165 SOL, 5 rats at the real 0.03 SOL salary"
  [ "$(result_of 2)" = PASS ] || die "run phase 2 first"
  pre=$(rat_json preflight --json)
  printf '%s' "$pre" | jq -e '.lines[] | select(.check == "stocks" and .status == "PASS")' >/dev/null 2>&1 ||
    die "no approved xStock passes the mint check yet" "Run: scripts/approve-stocks.sh (you check each mint on xstocks.fi)"
  seed=$(rat staging-seed --sol 0.165 2>&1) || fail "staging-seed refused: $(printf '%s' "$seed" | tail -1)"
  printf '%s\n' "$seed" | sed 's/^/        /'
  rats0=$(st_get '[.rats.active // 0, .rats.frozen // 0] | add')
  go_gate "seed 0.165 SOL of hire budget, then 5 hires: 5 new rat wallets funded by the test creator, each buying an approved xStock on Jupiter" \
    "about 0.165 SOL leaves the test creator (5 x 0.03 salary plus fees and rent); about 97% comes back at teardown"
  rat staging-seed --sol 0.165 --confirm "SEED 0.165 SOL" >/dev/null || fail "the seed was not booked"
  gate_open
  wait_for "5 new rats, nothing in flight" 900 "([.rats.active // 0, .rats.frozen // 0] | add) >= $((rats0 + 5)) and .openReservations == 0" ||
    fail "5 rats were not hired within 15 minutes"
  gate_close
  audit_ok || fail "rat audit is not PASS"
  st_now=$(st)
  claimed=$(printf '%s' "$st_now" | jq -r '.claimedSol')
  seeded=$(printf '%s' "$st_now" | jq -r '.seededSol')
  api=$(api_state)
  [ -n "$api" ] || fail "the staging API did not answer"
  approx "$(printf '%s' "$api" | jq -r '.treasury.totalClaimedSol')" "$claimed" || fail "the public claimed figure is not the claims only"
  stage=$(printf '%s' "$api" | jq -r '.treasury.stageSol // empty')
  if [ -z "$stage" ] || ! approx "$stage" "$(awk -v a="$claimed" -v b="$seeded" 'BEGIN { print a + b }')"; then fail "stageSol is not claimed plus seeded"; fi
  record 3 PASS "5 rats hired, each paid once and holding what the database says; claimed $claimed SOL excludes the $seeded SOL seed"
}

phase_4() { # the burst under the cap, with the crash test inside it (phase 5)
  local out cap n429 st_now budget seed
  title "Phase 4 and 5: a burst at 0.01 SOL under a small cap, the worker killed after hire 6"
  [ "$(result_of 3)" = PASS ] || die "run phase 3 first"
  out=$(st_get '.hourOutflowSol')
  cap=$(awk -v o="$out" 'BEGIN { printf "%.3f", o + 0.08 }') # 8 more hires at 0.01 in this rolling hour
  say "Spent on hires in the last hour: $out SOL. The cap for this phase: $cap SOL per hour."
  seed=$(rat staging-seed --sol 0.125 2>&1) || fail "staging-seed refused: $(printf '%s' "$seed" | tail -1)"
  go_gate "salary 0.01 SOL, hourly cap $cap SOL; seed 0.125 SOL, then up to 12 hires. The cap stops them part way, then the script raises it and the rest go. The worker kills itself right after the 6th hire is broadcast and Railway restarts it." \
    "about 0.125 SOL leaves the test creator; about 95% comes back at teardown"
  set_vars worker SALARY_SOL=0.01 "SPEND_CAP_SOL_PER_HOUR_HIRE=$cap" STAGING_CRASH_AFTER_SEND=6
  redeploy worker
  rat staging-seed --sol 0.125 --confirm "SEED 0.125 SOL" >/dev/null || fail "the seed was not booked"
  gate_open
  wait_for "the crash after hire 6 and the restart" 900 '.stagingCrashDone and ([.loops[].ageSec] | length > 0 and max < 120)' ||
    fail "the crash test did not fire, or the worker did not come back"
  ok "the worker died right after hire 6 was broadcast and came back"
  wait_for "hiring to stop at the cap" 900 \
    '(.hourOutflowSol | tonumber) + (.salarySol | tonumber) > (.hourCapSol | tonumber) and (.hireBudgetSol | tonumber) >= (.salarySol | tonumber) and .openReservations == 0' ||
    fail "hiring never stopped at the cap (budget ran out first, or it kept going)"
  st_now=$(st)
  awk -v o="$(printf '%s' "$st_now" | jq -r .hourOutflowSol)" -v c="$cap" 'BEGIN { exit !(o <= c) }' || fail "spending passed the cap"
  budget=$(printf '%s' "$st_now" | jq -r .hireBudgetSol)
  approx "$(api_state | jq -r '.treasury.waitingSol')" "$budget" 0.000001 || fail "the job-fair line (waitingSol) is not the waiting budget"
  ok "cap held: $(printf '%s' "$st_now" | jq -r .hourOutflowSol) of $cap SOL, $budget SOL waiting in the job-fair line"
  set_vars worker SPEND_CAP_SOL_PER_HOUR_HIRE=60
  redeploy worker
  wait_for "the rest to be hired" 900 '(.hireBudgetSol | tonumber) < (.salarySol | tonumber) and .openReservations == 0' ||
    fail "the rest were not hired after the cap was raised"
  gate_close
  audit_ok || fail "rat audit is not PASS (after the crash)"
  n429=$(rw logs --service worker --lines 3000 2>/dev/null | grep -c 'jupiter_429' || true)
  [ "${n429:-0}" = 0 ] || fail "$n429 Jupiter 429 answers in the worker log"
  rw variable delete STAGING_CRASH_AFTER_SEND --service worker >/dev/null 2>&1 || true
  rw variable delete SALARY_SOL --service worker >/dev/null 2>&1 || true
  rw variable delete SPEND_CAP_SOL_PER_HOUR_HIRE --service worker >/dev/null 2>&1 || true
  redeploy worker
  record 4 PASS "cap held at $cap SOL/h with budget waiting, the rest hired after it was raised, no Jupiter 429"
  record 5 PASS "killed after hire 6 was broadcast, restarted, that rat paid once, nothing left open, audit PASS"
}

phase_6() { # the watch trips the kill switch; the admin watchdog sees the worker go down and come back
  local c t0 reason
  title "Phase 6: safety"
  [ "$(result_of 4)" = PASS ] || die "run phases 4 and 5 first"
  c=$(creator)
  go_gate "kill switch OFF; YOU send 0.001 SOL from the test creator to your own wallet in Phantom. The bot must see a transaction it did not send and turn the kill switch back ON by itself, with a critical Telegram alert. While it is off the bot may also claim fees and hire with the $(st_get .hireBudgetSol) SOL left." \
    "0.001 SOL (yours, comes back to you) plus a network fee"
  gate_open
  say "In Phantom, test creator account: send 0.001 SOL to your own wallet."
  pause "Sent? Press Enter."
  t0=$(date +%s)
  wait_for "the kill switch to turn itself ON" 300 '.killSwitch.on' || fail "the kill switch did not turn on within 5 minutes"
  OPEN=0
  reason=$(st_get '.killSwitch.reason')
  ok "kill switch ON after $(($(date +%s) - t0)) s: $reason"
  yes_no "Did a CRITICAL Telegram alert arrive, naming that transaction?" y || fail "no critical alert"
  say "Now the worker stops for 4 minutes: the admin service must alert that it is down, then that it is back."
  rw down --service worker --yes >/dev/null 2>&1 || fail "could not stop the worker"
  say "Worker stopped at $(date +%H:%M). Waiting 4 minutes..."
  sleep "${WSR_DOWN_SEC:-240}"
  yes_no "Did a 'worker down' Telegram alert arrive?" y || fail "no worker down alert"
  redeploy worker
  wait_for "the worker's loops to run again" 600 '[.loops[].ageSec] | length > 0 and max < 120' || fail "the worker did not come back"
  yes_no "Did a 'Worker is back' Telegram alert arrive (within a minute or two)?" y || fail "no back alert"
  [ "$(st_get '.killSwitch.on')" = true ] || fail "the kill switch is off after the restart"
  record 6 PASS "unknown creator transaction tripped the kill switch ($reason); down and back alerts arrived"
}

phase_7() { # the production site against the staging API, on your phone
  local api rats portfolio sum ids
  title "Phase 7: the site on your phone"
  [ "$(result_of 3)" = PASS ] || die "run phase 3 first"
  api=$(api_state)
  [ -n "$api" ] || fail "the staging API did not answer"
  rats=$(curl -fsS -m 30 "https://$(state_get "$STATE" API_DOMAIN)/api/rats" 2>/dev/null || true)
  [ -n "$rats" ] || fail "/api/rats did not answer"
  [ "$(printf '%s' "$rats" | jq '.total')" = "$(st_get '[.rats.active // 0, .rats.frozen // 0] | add')" ] || fail "/api/rats does not list every rat"
  printf '%s' "$rats" | jq -e 'all(.rats[]; .solscanUrl == "https://solscan.io/account/" + .wallet)' >/dev/null || fail "a Solscan link points at the wrong wallet"
  ids=$(printf '%s' "$api" | jq -r '[.stocks[].mint] | join(",")')
  portfolio=$(printf '%s' "$api" | jq -r '.portfolio.valueUsd')
  JUP_KEY=$(rw_var worker JUPITER_API_KEY)
  sum=$(printf 'header = "x-api-key: %s"\n' "$JUP_KEY" | curl -sS -m 20 -K - "https://api.jup.ag/price/v3?ids=$ids" 2>/dev/null |
    jq -r --argjson r "$(printf '%s' "$rats" | jq -c '[.rats[] | {m: .stockMint, a: (.tokenAmount | tonumber)}]')" \
      '. as $p | [$r[] | .a * ($p[.m].usdPrice // 0)] | add // 0')
  unset JUP_KEY
  awk -v a="$portfolio" -v b="$sum" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(b > 0 && d <= b * 0.01) }' ||
    fail "Vault value $portfolio USD vs $sum USD from Jupiter prices (more than 1% apart)"
  ok "Vault value $portfolio USD matches the token amounts x Jupiter prices ($sum USD) within 1%"
  open_url "$SITE/?api=https://$(state_get "$STATE" API_DOMAIN)"
  say "Open that link on your phone too."
  yes_no "Do the rats walk in and open a card when you tap them?" y || fail "rats not shown or not clickable"
  yes_no "Tap 2 rats' Solscan links: do they open the right wallet?" y || fail "Solscan links wrong"
  yes_no "Does the building show SMALL OFFICE (stage by claimed plus seed: $(printf '%s' "$api" | jq -r '.treasury.stageSol') SOL) and the Company Roadmap?" y ||
    fail "the stage-up did not show"
  record 7 PASS "$(printf '%s' "$rats" | jq .total) rats on the site, Solscan links right, Vault within 1% of Jupiter, stage-up shown"
}

phase_8() { # one backup now, then a restore drill on this Mac, row counts compared
  local bucket obj i logs drill port rows_rats rows_claims st_now old
  title "Phase 8: backup and restore drill"
  bucket=$(state_get "$STATE" R2_BUCKET)
  [ -n "$bucket" ] || die "no R2 bucket in the staging setup state"
  st_now=$(st)
  PATH="${WSR_PG_BIN:-$(brew --prefix postgresql@16 2>/dev/null)/bin}:$PATH" # initdb, pg_ctl, pg_restore 16 (setup installed them)
  command -v initdb >/dev/null 2>&1 || die "postgresql@16 is missing" "Run: brew install postgresql@16"
  # a backup service without a schedule runs one backup per deploy, then exits: follow its log, not its status
  old=$(deployment_id backup)
  rw redeploy --service backup --from-source --yes >/dev/null 2>&1 || fail "could not start a backup (redeploy of the backup service)"
  say "Waiting for the backup (build + run, a few minutes)..."
  i=0
  while :; do
    if [ -n "$old" ] && [ "$(deployment_id backup)" = "$old" ]; then logs=""; else logs=$(rw logs --service backup --latest --lines 80 2>/dev/null || true); fi
    obj=$(printf '%s\n' "$logs" | sed -n 's/.*backup: ok \(rat\/rat-[0-9-]*\.dump\.age\).*/\1/p' | tail -1)
    [ -n "$obj" ] && break
    printf '%s\n' "$logs" | grep -q 'backup: FAILED' && fail "the backup failed: $(printf '%s\n' "$logs" | grep 'backup: ' | tail -1)"
    i=$((i + 1))
    [ "$i" -gt 60 ] && fail "no backup result after 10 minutes"
    sleep 10
  done
  ok "backup uploaded: $bucket/$obj"
  drill=$(mktemp -d)
  wr() { if [ -n "${WSR_WRANGLER:-}" ]; then $WSR_WRANGLER "$@"; else npx --yes wrangler@4 "$@"; fi; }
  wr r2 object get "$bucket/$obj" --file "$drill/backup.age" --remote >/dev/null 2>&1 || fail "could not download the backup"
  initdb -D "$drill/pg" -U postgres -A trust >/dev/null
  port=$((20000 + RANDOM % 20000))
  pg_ctl -D "$drill/pg" -o "-p $port -k $drill -c listen_addresses=''" -l "$drill/pg.log" -w start >/dev/null || fail "could not start a temporary database"
  infra/backup/restore-check.sh "$drill/backup.age" "$SECRETS/rat-backup.key" "postgresql://postgres@/postgres?host=$drill&port=$port" >"$drill/out.txt" 2>&1 || true
  pg_ctl -D "$drill/pg" -m fast stop >/dev/null 2>&1 || true
  sed 's/^/        /' "$drill/out.txt" | tail -25
  grep -q '^PASS:' "$drill/out.txt" || { rm -rf "$drill"; fail "restore-check did not PASS"; }
  rows_rats=$(awk '$1 == "public.rats" { print $2 }' "$drill/out.txt")
  rows_claims=$(awk '$1 == "public.claims" { print $2 }' "$drill/out.txt")
  rm -rf "$drill"
  [ "$rows_rats" = "$(printf '%s' "$st_now" | jq '[.rats[]] | add // 0')" ] || fail "restored rats ($rows_rats) differ from staging"
  [ "$rows_claims" = "$(printf '%s' "$st_now" | jq '.claims')" ] || fail "restored claims ($rows_claims) differ from staging"
  record 8 PASS "backup restored on this Mac: PASS, $rows_rats rats and $rows_claims claims match the staging database"
}

phase_teardown() {
  local c t mint held spent back s_c s_t name
  title "Teardown: get the SOL back"
  c=$(creator)
  t=$(rw_var worker COLD_WALLET)
  mint=$(rw_var worker COIN_MINT)
  if [ -z "$t" ] || [ "$t" != "$(tr -d '[:space:]' <"$SECRETS/throwaway-wallet.pub")" ]; then die "the worker's COLD_WALLET is not the throwaway wallet"; fi
  rat sweep --to "$t" 2>&1 | sed 's/^/        /' || true
  if [ "$(st_get '[.rats.active // 0, .rats.frozen // 0, .rats.failed // 0] | add')" -gt 0 ]; then
    go_gate "sweep every rat's xStock tokens and SOL to the throwaway wallet $t (the bot's emergency sweep)" \
      "all the rats' SOL and tokens move to $t; the test creator pays the fees (under 0.001 SOL per rat)"
    rat sweep --to "$t" --confirm "SWEEP ALL RATS TO $t" 2>&1 | sed 's/^/        /' || fail "the sweep failed"
  fi
  held=$(tokens_held "$t")
  say "The throwaway wallet now holds: $(printf '%s' "$held" | wc -l | tr -d ' ') token(s) and $(lamports_to_sol "$(sol_balance "$t")") SOL."
  say "Sell the xStocks (YOUR transactions, in Phantom):"
  say "1. Phantom > Add account > Import private key. The key is in $SECRETS/throwaway-wallet.key"
  say "   (open it with: open -e $SECRETS/throwaway-wallet.key, copy, paste in Phantom, then close the file)."
  say "2. Swap every xStock in that account to SOL."
  pause "Done? Press Enter."
  held=$(tokens_held "$t" | grep -v "^${mint:-none} " || true)
  [ -z "$held" ] || note "the throwaway wallet still holds $(printf '%s\n' "$held" | wc -l | tr -d ' ') token(s)"
  say "Sell the test coin (YOUR transaction, in Phantom, test creator account): sell ALL TEST DO NOT BUY on pump.fun."
  say "(This trips the staging kill switch: expected, the bot is done.)"
  pause "Done? Press Enter."
  [ -z "$mint" ] || [ "$(token_balance "$c" "$mint")" = 0 ] || note "the test creator still holds test coins"
  s_c=$(sol_balance "$c")
  s_t=$(sol_balance "$t")
  back=$((${s_c:-0} + ${s_t:-0}))
  spent=$(state_get "$RESULTS" CREATOR_START_LAMPORTS)
  say "SOL now: test creator $(lamports_to_sol "$s_c"), throwaway $(lamports_to_sol "$s_t"), together $(lamports_to_sol "$back")."
  say "Empty both to your own wallet in Phantom (Send > Max), from the test creator and from the throwaway account."
  pause "Done? Press Enter."
  state_set "$RESULTS" RECOVERED_LAMPORTS "$back"
  name=$(rw status --json 2>/dev/null | jq -r '.name // empty')
  say "Last: delete the staging project $name (Railway dashboard > $name > Settings > Danger > Delete project)."
  say "Also delete its R2 bucket $(state_get "$STATE" R2_BUCKET) and its R2 token in the Cloudflare dashboard."
  record T PASS "started with $(lamports_to_sol "${spent:-0}") SOL, got back $(lamports_to_sol "$back") SOL (cost $(lamports_to_sol $((${spent:-0} - back))) SOL)"
}

phase_report() {
  local p s verdict=GO line site
  {
    printf '# Rehearsal report\n\n'
    printf 'Written %s by scripts/staging.sh. Staging project: %s.\n\n' "$(date -u +%Y-%m-%dT%H:%MZ)" "$(rw status --json 2>/dev/null | jq -r '.name // "?"')"
    printf '| Phase | Result | When | Detail |\n|---|---|---|---|\n'
    for p in 0 1 2 3 4 5 6 7 8 T; do
      line=$(state_get "$RESULTS" "PHASE_$p")
      s=${line%%|*}
      [ -n "$line" ] || s="NOT RUN"
      [ "$p" = T ] || [ "$s" = PASS ] || verdict=NO-GO
      printf '| %s | %s | %s | %s |\n' "$([ "$p" = T ] && echo Teardown || echo "$p")" "$s" "$(printf '%s' "$line" | cut -d'|' -f2)" "$(printf '%s' "$line" | cut -d'|' -f3-)"
    done
    site=$(state_get "$PROD_SECRETS/setup-state.env" SITE_GO_LIVE)
    printf '| Production site | %s | | %s |\n' "${site%%|*}" "$(printf '%s' "$site" | cut -d'|' -f2-)"
    [ "${site%%|*}" = PASS ] || verdict=NO-GO
    printf '\n## %s\n\n' "$verdict"
    if [ "$verdict" = GO ]; then
      printf 'Every phase and the production site check PASSED. Launch day starts at LAUNCH-DAY.md, "The night before".\n'
    else
      printf 'Any FAIL or anything not run is NO-GO: fix it, then run that phase again.\n'
    fi
  } >"$REPORT"
  cat "$REPORT"
  printf '\n  Saved: %s\n' "$REPORT"
}

PHASE="${1:-}"
case "$PHASE" in
  check) PHASE=0; phase_check ;;
  1 | 2 | 3 | 6 | 7 | 8) guard; "phase_$PHASE" ;;
  4 | 5) PHASE=4; guard; phase_4 ;;
  teardown) PHASE=T; guard; phase_teardown ;;
  report) phase_report ;;
  *) die "which phase? scripts/staging.sh check | 1 ... 8 | teardown | report" ;;
esac
