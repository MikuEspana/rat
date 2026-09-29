# Shared helpers for scripts/approve-stocks.sh and scripts/staging.sh (sourced, never run on its own).
# macOS ships bash 3.2: nothing here needs a newer bash. No secret is ever printed or put on a command line: values
# from `railway variable list` stay in shell variables and reach curl through its config on stdin (-K -).
# shellcheck shell=bash

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'; else B=; G=; Y=; R=; C=; N=; fi
ok() { printf '  %sOK%s    %s\n' "$G" "$N" "$1"; }
note() { printf '  %sNOTE%s  %s\n' "$Y" "$N" "$1"; }
bad() { printf '  %sFAIL%s  %s\n' "$R" "$N" "$1"; }
say() { printf '        %s\n' "$1"; }
title() { printf '\n%s== %s ==%s\n' "$B$C" "$1" "$N"; }
die() {
  printf '\n  %sSTOPPED%s  %s\n' "$R" "$N" "$1" >&2
  shift
  for l in "$@"; do printf '           %s\n' "$l" >&2; done
  exit 1
}
pause() { printf '\n  %s ' "${1:-Press Enter to continue.}"; read -r _ || die "no keyboard input (end of input)"; }
yes_no() { # yes_no "question" default(y|n)
  local a
  printf '  %s [%s] ' "$1" "$([ "$2" = y ] && echo Y/n || echo y/N)"
  read -r a || die "no keyboard input (end of input)"
  a=$(printf '%s' "$a" | tr '[:upper:]' '[:lower:]')
  [ -z "$a" ] && a="$2"
  [ "$a" = y ] || [ "$a" = yes ]
}
ask() { # ask VAR "question": a plain (visible) answer, for public values only
  local v
  printf '  %s ' "$2"
  IFS= read -r v || die "no keyboard input (end of input)"
  v=$(printf '%s' "$v" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  printf -v "$1" '%s' "$v"
}
open_url() { say "Opening $1"; ${WSR_OPEN:-open} "$1" >/dev/null 2>&1 || say "(open it yourself: $1)"; }

rw() { ${WSR_RAILWAY:-railway} "$@"; }
# Railway's API fails now and then, more during an incident ("error decoding response body"): reads and writes are
# tried up to 3 times, 5 then 10 seconds apart, every write is read back, and a failed read is never taken for an
# answer (a check on it fails).
TRIES=3
retry_pause() { sleep "${WSR_RETRY_SEC:-$(($1 * 5))}"; }
API_HINT="Railway's API is not answering properly (status.railway.com). Run it again in a few minutes."
rw_vars() { # rw_vars service: its variables as JSON (secret values: only into jq or shasum, never printed); 1 = no answer
  local out i
  for i in 1 2 3; do
    if out=$(rw variable list --service "$1" --json 2>/dev/null) && printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1; then
      printf '%s\n' "$out"
      return 0
    fi
    [ "$i" = "$TRIES" ] || retry_pause "$i"
  done
  return 1
}
rw_var() { rw_vars "$1" | jq -r --arg k "$2" '.[$k] // empty' 2>/dev/null || true; } # "" = not set, or Railway did not answer
set_vars() { # set_vars service KEY=VALUE...: non-secret settings (applied by the next redeploy), then read back, or stop
  local svc="$1" kv i
  shift
  for i in 1 2 3; do
    rw variable set "$@" --service "$svc" --skip-deploys >/dev/null 2>&1 && break
    [ "$i" = "$TRIES" ] && die "could not set $* on $svc ($TRIES tries)" "$API_HINT"
    retry_pause "$i"
  done
  for kv in "$@"; do
    for i in 1 2 3; do
      [ "$(rw_var "$svc" "${kv%%=*}")" = "${kv#*=}" ] && continue 2
      [ "$i" = "$TRIES" ] || retry_pause "$i"
    done
    die "Railway does not show ${kv%%=*} on $svc after setting it" "Check it in the Railway dashboard: $svc > Variables. $API_HINT"
  done
}
unset_var() { # unset_var service KEY: removed, and Railway lists the variables without it (3 tries), or stop
  local i
  for i in 1 2 3; do
    rw variable delete "$2" --service "$1" >/dev/null 2>&1 || true # it fails when the variable is not there
    rw_vars "$1" | jq -e --arg k "$2" 'has($k) | not' >/dev/null 2>&1 && return 0
    [ "$i" = "$TRIES" ] || retry_pause "$i"
  done
  die "could not remove $2 from $1" "Railway dashboard: $1 > Variables: delete $2. $API_HINT"
}
state_get() { if [ -f "$1" ]; then sed -n "s/^$2=//p" "$1" | tail -1; fi; }
state_set() { # state_set file KEY value
  touch "$1"
  grep -v "^$2=" "$1" >"$1.tmp" || true
  printf '%s=%s\n' "$2" "$3" >>"$1.tmp"
  mv "$1.tmp" "$1"
}

# The fast rehearsal (scripts/staging-local.sh): the staging state says LOCAL=1 and this folder is linked to that same
# staging project. Anything else (production, another project) is never local.
local_mode() { # local_mode staging-state-file
  local pid
  [ "$(state_get "$1" LOCAL)" = 1 ] || return 1
  pid=$(rw status --json 2>/dev/null | jq -r '.id // empty' 2>/dev/null || true)
  [ -n "$pid" ] && [ "$pid" = "$(state_get "$1" RAILWAY_PROJECT_ID)" ]
}

# rat commands run in the worker over railway ssh (scripts/rat.sh). WSR_RAT=scripts/rat-local.sh runs them on this
# Mac instead (the route without ssh, docs/runbooks/setup-mac.md).
rat() { command ${WSR_RAT:-scripts/rat.sh} "$@"; }
rat_json() { rat "$@" 2>/dev/null | grep '^{' | tail -1; } # the last JSON line a rat command printed

service_status() { rw service status --service "$1" --json 2>/dev/null | jq -r '.status // "NONE"' 2>/dev/null || echo NONE; }
deployment_id() { rw service status --service "$1" --json 2>/dev/null | jq -r '.deploymentId // empty' 2>/dev/null || true; }
redeploy() { # redeploy service...: a fresh build of the latest commit with the current settings, every service at
  # once (they build side by side, one wait instead of one per service), then wait until every one runs
  local svc s i=0 olds="" old pending left
  for svc in "$@"; do
    olds="$olds$svc=$(deployment_id "$svc")"$'\n' # one line per service
    for i in 1 2 3; do
      rw redeploy --service "$svc" --from-source --yes >/dev/null 2>&1 && break
      [ "$i" = "$TRIES" ] && die "could not redeploy $svc ($TRIES tries)" "Railway dashboard: $svc > Deployments > Deploy the latest commit." "$API_HINT"
      retry_pause "$i"
    done
  done
  say "Waiting for $* to build and start (they build at the same time, a few minutes)..."
  pending="$*"
  i=0
  while :; do
    left=""
    for svc in $pending; do
      old=$(printf '%s' "$olds" | sed -n "s/^$svc=//p")
      s=$(service_status "$svc")
      [ -n "$old" ] && [ "$(deployment_id "$svc")" = "$old" ] && s=QUEUED # the old deployment is not this build's answer
      case "$s" in
        SUCCESS) ok "$svc is running" ;;
        FAILED | CRASHED | REMOVED) die "$svc did not start (status $s)" "Railway dashboard: $svc > Deployments shows why." ;;
        *) left="$left $svc" ;;
      esac
    done
    pending=${left# }
    [ -n "$pending" ] || return 0
    i=$((i + 1))
    [ "$i" -gt 180 ] && die "still not running after 30 minutes: $pending" "Railway dashboard: Deployments shows why (status.railway.com for incidents)."
    sleep "${WSR_POLL_SEC:-10}"
  done
}

# Solana reads from this Mac through the worker's RPC URL (it holds an API key: it stays in this shell)
RPC_URL=""
rpc() { # rpc method 'params json': prints the "result" JSON (empty on error)
  [ -n "$RPC_URL" ] || RPC_URL=$(rw_var worker RPC_URL)
  [ -n "$RPC_URL" ] || die "the worker has no RPC_URL"
  printf 'url = "%s"\n' "$RPC_URL" | curl -sS -m 30 -K - -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" 2>/dev/null | jq -c '.result // empty' 2>/dev/null
}
sol_balance() { rpc getBalance "[\"$1\",{\"commitment\":\"confirmed\"}]" | jq -r '.value // empty'; } # lamports
token_balance() { # token_balance owner mint: raw amount summed over the owner's accounts of that mint
  rpc getTokenAccountsByOwner "[\"$1\",{\"mint\":\"$2\"},{\"encoding\":\"jsonParsed\",\"commitment\":\"confirmed\"}]" |
    jq -r '[.value[]?.account.data.parsed.info.tokenAmount.amount | tonumber] | add // 0'
}
tokens_held() { # tokens_held owner: "mint amount" for every non-empty token account (SPL Token and Token-2022)
  local p
  for p in TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb; do
    rpc getTokenAccountsByOwner "[\"$1\",{\"programId\":\"$p\"},{\"encoding\":\"jsonParsed\",\"commitment\":\"confirmed\"}]" |
      jq -r '.value[]?.account.data.parsed.info | select(.tokenAmount.amount != "0") | "\(.mint) \(.tokenAmount.amount)"'
  done
}
lamports_to_sol() { awk -v l="${1:-0}" 'BEGIN { printf "%.6f", l / 1e9 }'; }
