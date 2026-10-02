#!/bin/bash
# THE INUVESTORS: the whole backend setup on a Mac, in one command. DRY RUN only: nothing here can send a
# mainnet transaction. Safe to re-run: every step checks what is already done and skips it.
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/MikuEspana/rat/main/scripts/setup-mac.sh)"
#
# What it does (docs/runbooks/setup-mac.md has the long version):
#   1 tools (Homebrew: railway, node, age, jq, Postgres client) 2 log in to Railway and Cloudflare (browser)
#   3 Railway project: Postgres + worker, api, admin, backup     4 private R2 bucket, 30-day delete rule, API token
#   5 master key, backup key, admin password -> ~/rat-secrets     6 your secrets through hidden prompts
#   7 creator key import (hidden prompt, straight into Railway)   8 deploy in DRY RUN, preflight, Telegram test
#   9 first backup, nightly schedule, restore drill               10 checklist and the next step
#
# Secrets are only ever typed into hidden prompts or read from ~/rat-secrets. They go to Railway through stdin
# (never on a command line) and are never printed. This script never asks for a seed phrase.
#
# Official docs for every tool it drives:
#   Homebrew        https://docs.brew.sh
#   Railway CLI     https://docs.railway.com/cli  (variables https://docs.railway.com/variables,
#                   ssh https://docs.railway.com/cli/ssh, cron https://docs.railway.com/cron-jobs)
#   Wrangler (R2)   https://developers.cloudflare.com/workers/wrangler/commands/#r2
#   R2 API tokens   https://developers.cloudflare.com/r2/api/tokens/
#   R2 lifecycles   https://developers.cloudflare.com/r2/buckets/object-lifecycles/
#   age             https://github.com/FiloSottile/age
#   Telegram        https://core.telegram.org/bots/api#getupdates
#   healthchecks.io https://healthchecks.io/docs/api/
#   PostgreSQL 18   https://www.postgresql.org/docs/18/app-pgrestore.html
# shellcheck disable=SC2015,SC2016,SC2153 # literal ${{references}} for Railway; RPC is set by ask_secret
set -euo pipefail

# ---------------------------------------------------------------- settings --------------------------------------------
REPO_SLUG="MikuEspana/rat"
REPO_URL="https://github.com/$REPO_SLUG.git"
BRANCH="main"
APP_DIR="${WSR_DIR:-$HOME/wallstreetrats}"
SECRETS="${WSR_SECRETS:-$HOME/rat-secrets}"
STATE="$SECRETS/setup-state.env"
# The rehearsal uses this same script with the staging profile (scripts/setup-staging.sh sets every WSR_ value
# below). Production never takes extra settings, never links to the staging project, and the reverse.
PROFILE="${WSR_PROFILE:-production}"
PROJECT_NAME="${WSR_PROJECT_NAME:-wall-street-rats}"
EXTRA_VARS="${WSR_EXTRA_VARS:-}" # KEY=VALUE ... for worker, admin and api (the staging profile only)
BUCKET_PREFIX="${WSR_BUCKET_PREFIX:-wsr-db-backups}"
FORBIDDEN_PROJECT_ID="${WSR_FORBIDDEN_PROJECT_ID:-}"
CREATOR_PUBKEY="${WSR_CREATOR_PUBKEY:-E8nsHrGuWeE97inEZUEsJPEEiZjqQCExULr1JzPqFdRq}"
CREATOR_LABEL="${WSR_CREATOR_LABEL:-creator}"
COLD_WALLET="${WSR_COLD_WALLET:-DX7RpxyhbcGeiBQh76ed2wZHw8WZ2CdMoDibpWmX9ajj}"
SITE_ORIGIN="https://theinuvestors.world"
# Every service and Postgres run here: EU West (Amsterdam). Most Solana stake sits in Europe and Helius has nodes in
# Amsterdam and Frankfurt (docs/runbooks/setup-mac.md, "Region").
REGION="${WSR_REGION:-europe-west4-drams3a}"
REGION_NAME="EU West (Amsterdam)"
ALL_REGIONS="us-west2 us-east4-eqdc4a europe-west4-drams3a asia-southeast1-eqsg3a" # docs.railway.com/deployments/regions
BACKUP_CRON="30 3 * * *"
TG_API="${WSR_TELEGRAM_API:-https://api.telegram.org}"
HC_API="${WSR_HEALTHCHECKS_API:-https://healthchecks.io}"
JUP_API="${WSR_JUPITER_API:-https://api.jup.ag}"

# ---------------------------------------------------------------- output ----------------------------------------------
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'; else B=; G=; Y=; R=; C=; N=; fi
STEP=0
step() { STEP=$((STEP + 1)); printf '\n%s== Step %s of 10: %s ==%s\n' "$B$C" "$STEP" "$1" "$N"; }
ok() { printf '  %sOK%s    %s\n' "$G" "$N" "$1"; }
skip() { printf '  %sDONE%s  %s (already set up, skipped)\n' "$G" "$N" "$1"; }
note() { printf '  %sNOTE%s  %s\n' "$Y" "$N" "$1"; }
say() { printf '        %s\n' "$1"; }
die() {
  printf '\n  %sSTOPPED%s  %s\n' "$R" "$N" "$1" >&2
  shift
  for l in "$@"; do printf '           %s\n' "$l" >&2; done
  printf '\n  Fix that, then run the same command again: finished steps are skipped.\n' >&2
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
ask_secret() { # ask_secret VAR "label" [optional]
  local v=""
  while :; do
    printf '  %s (hidden, paste then press Enter): ' "$2"
    IFS= read -rs v || die "no keyboard input (end of input)"
    printf '\n'
    v=$(printf '%s' "$v" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    if [ -n "$v" ] || [ "${3:-}" = optional ]; then break; fi
    note "nothing was pasted, try again"
  done
  printf -v "$1" '%s' "$v"
}
open_url() { say "Opening $1"; ${WSR_OPEN:-open} "$1" >/dev/null 2>&1 || say "(open it yourself: $1)"; }

# ---------------------------------------------------------------- state (ids only, never secrets) --------------------
state_get() { [ -f "$STATE" ] && sed -n "s/^$1=//p" "$STATE" | tail -1 || true; }
state_set() {
  mkdir -p "$SECRETS"
  touch "$STATE"
  grep -v "^$1=" "$STATE" >"$STATE.tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}

# ---------------------------------------------------------------- tool wrappers ---------------------------------------
rw() { ${WSR_RAILWAY:-railway} "$@"; }
wr() { if [ -n "${WSR_WRANGLER:-}" ]; then $WSR_WRANGLER "$@"; else npx --yes wrangler@4 "$@"; fi; }
# Railway's API fails now and then, more during an incident ("error decoding response body", timeouts). A call that is
# safe to repeat is tried up to 3 times, 5 then 10 seconds apart. A read that decides something never takes a failed
# call for an answer: "not set" counts only when Railway really listed the service's variables without it, otherwise
# the script stops. So a failed read can never lead to replacing a secret already on Railway (the master key!), nor
# to a second service with the same name. Every variable written is read back.
TRIES=3
retry_pause() { sleep "${WSR_RETRY_SEC:-$(($1 * 5))}"; }
API_HINT="Railway's API is not answering properly (status.railway.com). Run the same command again in a few minutes: finished steps are skipped."
rw_read() { # rw_read args...: a Railway read that answers a JSON object or list; stops the script after 3 failures
  local out i
  for i in 1 2 3; do
    if out=$(rw "$@" 2>/dev/null) && printf '%s' "$out" | jq -e 'type == "object" or type == "array"' >/dev/null 2>&1; then
      printf '%s\n' "$out"
      return 0
    fi
    [ "$i" = "$TRIES" ] || retry_pause "$i"
  done
  die "Railway did not answer: railway $* ($TRIES tries)" "$API_HINT"
}
RW_ERR=""
rw_write() { # rw_write "stdin" args...: a Railway change that is safe to repeat, 3 tries (RW_ERR: Railway's last complaint)
  local input="$1" i
  shift
  for i in 1 2 3; do
    RW_ERR=$(printf '%s' "$input" | rw "$@" 2>&1 >/dev/null) && return 0
    [ "$i" = "$TRIES" ] || retry_pause "$i"
  done
  RW_ERR=$(printf '%s\n' "$RW_ERR" | grep -v '^>' | grep . | tail -1 | cut -c1-200 || true)
  return 1
}
# a service's variables, as JSON: the values are secrets, they only ever go into jq or shasum, never printed
rw_vars() { rw_read variable list --service "$1" --json; }
var_is() { # var_is variables-json KEY VALUE: Railway holds that value (a ${{reference}}: holds the key, listed resolved)
  case "$3" in
    *'${{'*) printf '%s' "$1" | jq -e --arg k "$2" 'has($k)' >/dev/null 2>&1 ;;
    *) [ "$(printf '%s' "$1" | jq -j --arg k "$2" '.[$k] // ""' | shasum -a 256)" = "$(printf '%s' "$3" | shasum -a 256)" ] ;;
  esac
}
rw_has() { # rw_has service KEY: 0 = set, 1 = Railway listed the variables without it; stops if Railway cannot say
  local r
  r=$(rw_vars "$1" | jq -r --arg k "$2" 'if has($k) and .[$k] != "" then "yes" else "no" end') || exit 1
  [ "$r" = yes ]
}
var_confirm() { # var_confirm service KEY value: Railway lists that value now (read back up to 3 times), or stop
  local i cur
  for i in 1 2 3; do
    cur=$(rw_vars "$1") || exit 1
    var_is "$cur" "$2" "$3" && return 0
    [ "$i" = "$TRIES" ] || retry_pause "$i"
  done
  die "Railway does not show the $2 that setup just set on the $1 service" \
    "Check it in the Railway dashboard: $1 > Variables. $API_HINT"
}
CHANGED=" "
mark_changed() { case "$CHANGED" in *" $1 "*) ;; *) CHANGED="$CHANGED$1 " ;; esac; }
rw_set() { # rw_set service KEY=VALUE ...: non-secret values and ${{references}}, written only when they differ
  local svc="$1" cur kv k v
  shift
  cur=$(rw_vars "$svc") || exit 1
  for kv in "$@"; do
    k=${kv%%=*}
    v=${kv#*=}
    var_is "$cur" "$k" "$v" && continue
    rw_write "" variable set "$kv" --service "$svc" --skip-deploys ||
      die "could not set $k on the $svc service ($TRIES tries): $RW_ERR" "$API_HINT"
    var_confirm "$svc" "$k" "$v"
    mark_changed "$svc"
  done
}
rw_secret() { # rw_secret service KEY value: the value goes through stdin, never on a command line; then read back
  rw_write "$3" variable set "$2" --stdin --service "$1" --skip-deploys ||
    die "could not set $2 on the $1 service ($TRIES tries)" "$API_HINT"
  var_confirm "$1" "$2" "$3"
  mark_changed "$1"
}
rw_ssh() { # rw_ssh service "command": runs inside the running container
  rw ssh --service "$1" -i "$SSH_KEY" -- sh -c "$2"
}
# A `railway ssh` session does not get the service's variables. scripts/in-worker.cjs (sent as base64) runs the rat
# command with the settings of the running worker process, or else with the service variables sent as the first line
# of stdin. Values never go on a command line and are never printed.
worker_env_json() { rw_vars worker 2>/dev/null | jq -c 'with_entries(select(.value | type == "string"))' 2>/dev/null || echo '{}'; }
in_worker_cmd() { # the remote shell line: no secret in it; every argument quoted for the remote shell
  local a args=""
  for a in "$@"; do args="$args $(printf '%q' "$a")"; done
  printf "cd /app && exec node -e 'eval(Buffer.from(\"%s\",\"base64\").toString())' --%s" "$(base64 <"$APP_DIR/scripts/in-worker.cjs" | tr -d '\n')" "$args"
}
# The relay answers some refusals with a JSON status and exit code 0 (for example "signup_required": Railway does not
# know this SSH key), so success is a marker coming back, never the exit code.
ssh_ready() { # ssh_ready service: dies with the reason (and the link, for an unknown key) unless a command runs there
  local out="" i status url
  for i in 1 2 3 4 5 6; do
    out=$(rw_ssh "$1" 'echo RAT_SSH_OK' </dev/null 2>&1) || true
    case "$out" in *RAT_SSH_OK*) return 0 ;; esac
    status=$(printf '%s\n' "$out" | grep -o '{.*}' | jq -r '.status // empty' 2>/dev/null | head -1)
    if [ "$status" = signup_required ]; then
      url=$(printf '%s\n' "$out" | grep -o '{.*}' | jq -r '.human_signup_url // empty' 2>/dev/null | head -1)
      die "Railway does not know this SSH key yet ($SSH_KEY.pub): railway ssh cannot run anything in the $1 service" \
        "Link it to your Railway account: open ${url:-https://railway.com/account/ssh-keys} and sign in with your Railway account." \
        "Or run: railway ssh keys add --key $(basename "$SSH_KEY") --name \"wall-street-rats setup\"" \
        "Then run this again."
    fi
    [ "$i" -lt 6 ] && sleep "${WSR_POLL_SEC:-10}"
  done
  die "railway ssh into the $1 service gave no answer" "What Railway said: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')" \
    "Try it yourself: railway ssh --service $1 -i $SSH_KEY -- echo hello"
}
rat_w() { printf '%s\n' "$(worker_env_json)" | rw_ssh worker "$(in_worker_cmd "$@")"; }             # rat <args> in the worker
rat_w_in() { { printf '%s\n' "$(worker_env_json)"; cat; } | rw_ssh worker "$(in_worker_cmd "$@")"; } # ... with this stdin
preflight_json() { rat_w preflight --json 2>/dev/null | grep '^{' | tail -1 || true; } # its JSON line (exit code 1 while anything FAILs)
services_json() { rw_read service list --json; }
service_exists() { # 0 = listed, 1 = Railway listed the services without it (a failed read stops: no second service)
  local l
  l=$(services_json) || exit 1
  printf '%s' "$l" | jq -e --arg n "$1" 'map(.name) | index($n) != null' >/dev/null 2>&1
}
service_status() { rw service status --service "$1" --json 2>/dev/null | jq -r '.status // "NONE"' 2>/dev/null || echo NONE; }
deployment_id() { rw service status --service "$1" --json 2>/dev/null | jq -r '.deploymentId // empty' 2>/dev/null || true; }
replaced_deployment() { eval "printf '%s' \"\${OLD_DEPLOY_$1:-}\""; } # the deployment a rebuild replaces (see rebuild)
wait_deployed() { # wait_deployed service minutes
  local svc="$1" mins="$2" s i=0 old
  old=$(replaced_deployment "$svc")
  say "Waiting for the $svc service to build and start (can take a few minutes)..."
  while :; do
    s=$(service_status "$svc")
    # right after a rebuild the old (failed) deployment is still the latest one listed: its status is not the answer
    if [ -n "$old" ] && [ "$(deployment_id "$svc")" = "$old" ]; then s=QUEUED; fi
    case "$s" in
      SUCCESS) ok "$svc is running"; return 0 ;;
      FAILED | CRASHED | REMOVED)
        rw logs --service "$svc" --latest --lines 30 2>/dev/null | tail -30 | sed 's/^/        | /' || true
        die "the $svc service did not start (status $s)" "The last log lines are above. Open the Railway dashboard, service $svc, Deployments." ;;
    esac
    i=$((i + 1))
    [ "$i" -gt $((mins * 6)) ] && die "the $svc service is still not running after $mins minutes (status $s)" "Check the Railway dashboard, service $svc, Deployments."
    sleep "${WSR_POLL_SEC:-10}"
  done
}

connected() { local l; l=$(services_json) || exit 1; printf '%s' "$l" | jq -e --arg n "$1" --arg r "$REPO_SLUG" '.[] | select(.name == $n) | (.source.repo // "" | ascii_downcase) == ($r | ascii_downcase)' >/dev/null 2>&1; }
connect_source() { # connect_source service: the first deploy starts with every setting already in place
  if connected "$1"; then return 0; fi
  printf -v "OLD_DEPLOY_$1" '%s' "$(deployment_id "$1")" # a failed deployment from before is not this build's answer
  rw service source connect --repo "$REPO_SLUG" --branch "$BRANCH" --service "$1" --json >/dev/null ||
    die "could not connect $1 to github.com/$REPO_SLUG" "Give Railway access to the repo: https://github.com/apps/railway-app/installations/new"
}
# a setting changed on a service that already runs (a re-run): redeploy it so the change applies
rebuild() { # rebuild service: a fresh build of the latest commit with the current settings (never a replay of the last
  # one, which would repeat a wrong build). Older Railway CLIs have no --from-source: connecting the repo again also
  # starts a fresh build.
  printf -v "OLD_DEPLOY_$1" '%s' "$(deployment_id "$1")"
  rw redeploy --service "$1" --from-source --yes >/dev/null 2>&1 && return 0
  if connected "$1"; then
    rw service source connect --repo "$REPO_SLUG" --branch "$BRANCH" --service "$1" --json >/dev/null 2>&1 && return 0
  else
    rw redeploy --service "$1" --yes >/dev/null 2>&1 && return 0 # an image service (Postgres): a redeploy takes the new settings
  fi
  die "could not start a new deployment of $1" "Railway dashboard: $1 > Deployments > Redeploy. Then run this again."
}
redeploy_changed() { # redeploy_changed service...: services already connected whose settings changed or whose last deploy failed
  local svc
  for svc in "$@"; do
    connected "$svc" || continue
    case "$CHANGED" in
      *" $svc "*) rebuild "$svc"; say "rebuilding $svc (its settings changed)" ;;
      *) case "$(service_status "$svc")" in FAILED | CRASHED) rebuild "$svc"; say "rebuilding $svc (its last deploy failed)" ;; esac ;;
    esac
  done
  return 0
}

# ---------------------------------------------------------------- 0. sanity + repo ------------------------------------
if [ "$(uname -s)" != Darwin ] && [ -z "${WSR_TEST:-}" ]; then die "this script is for macOS" "On other systems follow docs/runbooks/deploy.md by hand."; fi
if [ ! -t 0 ] && [ -z "${WSR_TEST:-}" ]; then
  die "the prompts need your keyboard" 'Run it exactly like this: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/MikuEspana/rat/main/scripts/setup-mac.sh)"'
fi
umask 077
case "$PROFILE" in
  production)
    [ -z "$EXTRA_VARS" ] || die "extra settings (WSR_EXTRA_VARS) are for the staging profile only"
    # never the rehearsal's project (scripts/setup-staging.sh keeps its state in ~/rat-secrets-staging)
    [ -n "$FORBIDDEN_PROJECT_ID" ] || FORBIDDEN_PROJECT_ID=$(sed -n 's/^RAILWAY_PROJECT_ID=//p' "$HOME/rat-secrets-staging/setup-state.env" 2>/dev/null | tail -1 || true)
    ;;
  staging)
    [ "$CREATOR_PUBKEY" != "E8nsHrGuWeE97inEZUEsJPEEiZjqQCExULr1JzPqFdRq" ] || die "the staging profile never uses the production creator wallet"
    [ "$SECRETS" != "$HOME/rat-secrets" ] || die "the staging profile never uses the production secrets folder"
    ;;
  *) die "unknown profile $PROFILE" ;;
esac

printf '%s\n' "${B}THE INUVESTORS setup${N}  (DRY RUN only. Nothing here can send a mainnet transaction.)"
say "Secrets are only typed into hidden prompts. Never paste a seed phrase anywhere."

# ---------------------------------------------------------------- 1. tools --------------------------------------------
step "Install what is missing"
if ! command -v brew >/dev/null 2>&1; then
  die "Homebrew is not installed" "Install it from https://brew.sh (one command), open a new Terminal, then run this again."
fi
for f in git railway node age jq; do
  bin="$f"
  case "$f" in node) bin=npx ;; esac
  if command -v "$bin" >/dev/null 2>&1; then continue; fi
  say "brew install $f"
  brew install "$f" >/dev/null || die "brew install $f failed" "Run: brew install $f   and read its error."
done
ok "railway $(rw --version 2>/dev/null | awk '{print $NF}'), node $(node --version 2>/dev/null), $(age --version 2>/dev/null | head -1 | sed 's/^/age /')"

if [ -z "${WSR_SKIP_CLONE:-}" ]; then
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only -q origin "$BRANCH" >/dev/null 2>&1 || note "could not update $APP_DIR (local changes?), using it as it is"
  else
    git clone -q --branch "$BRANCH" "$REPO_URL" "$APP_DIR" || die "could not download the repo to $APP_DIR"
  fi
fi
cd "$APP_DIR"
ok "repo at $APP_DIR"

# Postgres client tools of the backup job's major (infra/backup/Dockerfile, the one source of truth): the restore
# drill restores with them and railway connect runs their psql. Railway's database must run that major too (checked
# at the end of step 3, before anything depends on it).
PG_MAJOR=$(sed -n 's/^FROM postgres:\([0-9][0-9]*\)-alpine.*/\1/p' infra/backup/Dockerfile | head -1)
[ -n "$PG_MAJOR" ] || die "infra/backup/Dockerfile names no Postgres major (FROM postgres:N-alpine)" "Run: git -C $APP_DIR pull"
if [ -z "${WSR_PG_BIN:-}" ] && ! brew list --versions "postgresql@$PG_MAJOR" >/dev/null 2>&1; then
  say "brew install postgresql@$PG_MAJOR (the client tools; no database server is started on this Mac)"
  brew install "postgresql@$PG_MAJOR" >/dev/null || die "brew install postgresql@$PG_MAJOR failed" "Run: brew install postgresql@$PG_MAJOR   and read its error."
fi
PG_BIN="${WSR_PG_BIN:-$(brew --prefix "postgresql@$PG_MAJOR" 2>/dev/null)/bin}"
for t in psql pg_restore initdb pg_ctl; do
  [ -x "$PG_BIN/$t" ] || die "$t from postgresql@$PG_MAJOR was not found in $PG_BIN" "Run: brew reinstall postgresql@$PG_MAJOR"
done
pg_major_of() { "$PG_BIN/$1" --version 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9]*\).*/\1/p' | head -1; }
for t in psql pg_restore initdb; do
  [ "$(pg_major_of "$t")" = "$PG_MAJOR" ] ||
    die "$t in $PG_BIN is Postgres $(pg_major_of "$t"), the backup job uses $PG_MAJOR" "Run: brew install postgresql@$PG_MAJOR"
done
export PATH="$PG_BIN:$PATH"
ok "Postgres $PG_MAJOR client tools (psql, pg_restore, initdb), the same major as the backup job"

# ---------------------------------------------------------------- 2. logins -------------------------------------------
step "Log in to Railway and Cloudflare"
if rw whoami >/dev/null 2>&1; then
  skip "Railway login ($(rw whoami --json 2>/dev/null | jq -r '.email // "logged in"'))"
else
  say "A browser window opens. Click Authorize, then come back here."
  rw login || die "Railway login failed" "Run: railway login"
fi
if wr whoami --json >/dev/null 2>&1; then
  skip "Cloudflare login"
else
  say "A browser window opens for Cloudflare. Click Allow, then come back here."
  wr login || die "Cloudflare login failed" "Run: npx wrangler login"
fi
CF_ACCOUNT_ID=$(state_get CF_ACCOUNT_ID)
if [ -z "$CF_ACCOUNT_ID" ]; then
  accounts=$(wr whoami --json 2>/dev/null | jq -r '.accounts[] | "\(.id) \(.name)"')
  count=$(printf '%s\n' "$accounts" | grep -c . || true)
  [ "$count" -ge 1 ] || die "no Cloudflare account found for this login" "Check https://dash.cloudflare.com"
  if [ "$count" -eq 1 ]; then
    CF_ACCOUNT_ID=$(printf '%s' "$accounts" | awk '{print $1}')
  else
    say "Your Cloudflare accounts:"
    printf '%s\n' "$accounts" | awk '{ $1=""; print "        " NR ")" $0 }'
    printf '  Which one has R2? Number: '
    read -r n || n=1
    CF_ACCOUNT_ID=$(printf '%s\n' "$accounts" | sed -n "${n}p" | awk '{print $1}')
    [ -n "$CF_ACCOUNT_ID" ] || die "no such account number"
  fi
  state_set CF_ACCOUNT_ID "$CF_ACCOUNT_ID"
fi
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
ok "Cloudflare account $CF_ACCOUNT_ID"

# SSH key for railway ssh / railway connect (a dedicated key, registered once)
SSH_KEY="${WSR_SSH_KEY:-$HOME/.ssh/railway_wsr_ed25519}"
if [ ! -f "$SSH_KEY" ]; then
  mkdir -p "$(dirname "$SSH_KEY")"
  ssh-keygen -q -t ed25519 -N "" -C "wall-street-rats setup" -f "$SSH_KEY"
fi
SSH_FP=$(ssh-keygen -lf "$SSH_KEY.pub" | awk '{print $2}')
# `railway ssh keys list` also lists this Mac's keys that are NOT registered ("Local Keys (not registered)"): only the
# part before that counts. Whether ssh really works is proven later by ssh_ready, before the first command.
ssh_key_registered() { rw ssh keys list 2>/dev/null | awk '/^(GitHub SSH Keys|Local Keys)/ { exit } { print }' | grep -qF "$SSH_FP"; }
if ssh_key_registered; then
  skip "SSH key for railway ssh"
elif rw ssh keys add --key "$(basename "$SSH_KEY")" --name "wall-street-rats setup" >/dev/null 2>&1 && ssh_key_registered; then
  ok "SSH key registered with Railway (for running commands inside the worker)"
else
  note "could not confirm the SSH key registration; the first railway ssh command below will tell"
fi

# ---------------------------------------------------------------- 3. Railway project ----------------------------------
step "Railway project with Postgres, worker, api, admin and backup"
if rw status --json >/dev/null 2>&1; then
  skip "project $(rw status --json 2>/dev/null | jq -r '.name // "linked"')"
else
  ws_json=$(rw whoami --json 2>/dev/null)
  ws_count=$(printf '%s' "$ws_json" | jq '.workspaces | length')
  ws=$(printf '%s' "$ws_json" | jq -r '.workspaces[0].id')
  if [ "$ws_count" -gt 1 ]; then
    say "Your Railway workspaces:"
    printf '%s' "$ws_json" | jq -r '.workspaces[] | .name' | awk '{ print "        " NR ") " $0 }'
    printf '  Create the project in which one? Number: '
    read -r n || n=1
    ws=$(printf '%s' "$ws_json" | jq -r --argjson i "$((n - 1))" '.workspaces[$i].id')
  fi
  rw init --name "$PROJECT_NAME" --workspace "$ws" --json >/dev/null || die "could not create the Railway project"
  ok "project $PROJECT_NAME created and linked to $APP_DIR"
fi
project_json=$(rw status --json 2>/dev/null || echo '{}')
project_id=$(printf '%s' "$project_json" | jq -r '.id // empty' 2>/dev/null || true)
project_name=$(printf '%s' "$project_json" | jq -r '.name // empty' 2>/dev/null || true)
if [ -n "$FORBIDDEN_PROJECT_ID" ] && [ "$project_id" = "$FORBIDDEN_PROJECT_ID" ]; then
  die "$APP_DIR is linked to the $([ "$PROFILE" = staging ] && echo PRODUCTION || echo staging) project ($project_name): nothing was changed" \
    "Unlink it: cd $APP_DIR && railway unlink, then run this again."
fi
case "$PROFILE:$project_name" in
  staging:"$PROJECT_NAME" | production:*) ;;
  staging:*) die "$APP_DIR is linked to project $project_name, not $PROJECT_NAME" "Unlink it: cd $APP_DIR && railway unlink, then run this again." ;;
esac
case "$PROFILE:$project_name" in production:*-staging) die "$APP_DIR is linked to the staging project $project_name" "Unlink it: cd $APP_DIR && railway unlink" ;; esac
state_set RAILWAY_PROJECT_ID "$project_id"
state_set PROFILE "$PROFILE"

PG=$(services_json | jq -r 'map(select(.name | test("^Postgres"))) | .[0].name // empty')
if [ -n "$PG" ]; then
  skip "Postgres ($PG)"
else
  rw add --database postgres --json >/dev/null || die "could not add Postgres"
  PG=$(services_json | jq -r 'map(select(.name | test("^Postgres"))) | .[0].name // empty')
  [ -n "$PG" ] || die "Postgres was added but not found in the service list"
  ok "Postgres added (private network only)"
fi
DB_REF="\${{$PG.DATABASE_URL}}"

# Build settings go on each service BEFORE its first build: builder Dockerfile, the Dockerfile path, the start
# command and the restart / health settings, all read from infra/railway.<service>.json (the one source of truth).
# The config file path alone is not enough (Railway then fell back to auto-detection, Railpack), so every setting is
# set on the service itself, then read back. The builder, Dockerfile and start command are compared with what Railway
# has (not with a "done" flag), so a re-run repairs a service that was built the wrong way: it is rebuilt from the
# latest commit before step 7 (redeploy_changed). The other settings are sent again when infra/railway.*.json changes.
service_id() { # the id of the one service with this name in the linked environment (two with one name: stop)
  local ids
  ids=$(services_json | jq -r --arg n "$1" '.[] | select(.name == $n) | .id // empty') || exit 1
  [ "$(printf '%s\n' "$ids" | grep -c .)" -le 1 ] ||
    die "project $project_name has more than one service named $1 (ids: $(printf '%s' "$ids" | tr '\n' ' '))" \
      "Railway dashboard: delete the extra $1 service, then run this again."
  printf '%s' "$ids"
}
# Railway's answer holds every variable decrypted: only the build settings leave this pipe (no secret in a shell variable)
env_config() { rw environment config --json 2>/dev/null | jq -ce 'select(type == "object") | {services: ((.services // {}) | map_values({configFile, build, deploy, volumeMounts})), volumes: ((.volumes // {}) | map_values({region}))}' 2>/dev/null; }
# Older Railway CLIs have no `environment config`: then the first build proves the settings. Asked from the CLI's own
# help (no API call), so a Railway failure is never mistaken for an older CLI.
ENV_HELP=$(rw environment --help 2>/dev/null || true)
if grep -qE '^ +config( |$)' <<<"$ENV_HELP"; then HAS_ENV_CONFIG=1; else HAS_ENV_CONFIG=""; fi
env_settings() { # the settings (3 tries, then stop); nothing only when this CLI has no `environment config`
  local i
  [ -n "$HAS_ENV_CONFIG" ] || return 0
  for i in 1 2 3; do
    env_config && return 0
    [ "$i" = "$TRIES" ] || retry_pause "$i"
  done
  die "Railway did not answer: railway environment config ($TRIES tries)" "$API_HINT"
}
# `railway environment edit` returns once Railway has QUEUED a change, not once it holds it (the CLI's own source: the
# commit "returns its id as soon as the workflow STARTS"). A read right after it can still show the old settings, for
# minutes while Railway's API is degraded. So a change counts only when Railway shows it back, compared exactly as
# strictly as before: the read is only repeated, for up to WSR_APPLY_WAIT_SEC (default 5 minutes), and the change is
# sent once more halfway (in case it was lost). The service list, the edit and the read all use the environment this
# folder is linked to (railway link), so they always look at the same service.
APPLY_WAIT_SEC="${WSR_APPLY_WAIT_SEC:-300}"
case "$APPLY_WAIT_SEC" in '' | *[!0-9]*) die "WSR_APPLY_WAIT_SEC must be a number of seconds" ;; esac
LEFT="" # what Railway still shows, when wait_applied gives up
wait_words() { if [ "$APPLY_WAIT_SEC" -ge 120 ]; then echo "$((APPLY_WAIT_SEC / 60)) minutes"; else echo "$APPLY_WAIT_SEC seconds"; fi; }
send_patch() { rw_write "$2" environment edit -m "$1" --json; } # send_patch "commit message" patch
wait_applied() { # wait_applied "commit message" patch check args...: until `check args... <config>` prints nothing
  local msg="$1" patch="$2" start=$SECONDS delay=5 resent="" told="" cfg
  shift 2
  while :; do
    if cfg=$(env_config) && LEFT=$("$@" "$cfg"); then
      [ -n "$LEFT" ] || return 0
      LEFT=$(printf '%s' "$LEFT" | tr '\n' ';' | sed 's/;/; /g')
    else
      LEFT="Railway's settings could not be read"
    fi
    [ $((SECONDS - start)) -lt "$APPLY_WAIT_SEC" ] || return 1
    if [ -z "$told" ]; then
      say "Railway has not applied it yet ($LEFT). It applies changes in the background, slower during an"
      say "incident (status.railway.com). Reading it again for up to $(wait_words)..."
      told=1
    fi
    if [ -z "$resent" ] && [ $((SECONDS - start)) -ge $((APPLY_WAIT_SEC / 2)) ]; then
      resent=1
      send_patch "$msg" "$patch" || true
    fi
    sleep "${WSR_APPLY_POLL_SEC:-$delay}"
    [ "$delay" -ge 30 ] || delay=$((delay + 5))
  done
}
not_applied() { # not_applied service id "what" "how to set it by hand": Railway still shows something else, so stop
  local env_id="" env_name=""
  read -r env_id env_name <<EOF || true
$(rw environment list --json 2>/dev/null | jq -r '.environments[]? | select(.isLinked) | "\(.id) \(.name)"' 2>/dev/null | head -1 || true)
EOF
  die "after $(wait_words) Railway still does not show $3 of $1 that setup sent. It shows: $LEFT" \
    "Setup reads project ${project_name:-?}, environment ${env_name:-(linked)}, service $1 (id $2). That exact page:" \
    "https://railway.com/project/$project_id/service/$2/settings${env_id:+?environmentId=$env_id}" \
    "Right settings on that page? Railway has not finished applying them (status.railway.com): run this again later." \
    "To read for longer, put WSR_APPLY_WAIT_SEC=900 in front of the same command." \
    "Other settings there, or another project or environment than the one you looked at? $4"
}
build_patch() { # build_patch service id: the settings for Railway, as an environment config patch
  jq -c --arg id "$2" --arg f "/infra/railway.$1.json" '{services: {($id): ({configFile: $f} + {build, deploy})}}' "infra/railway.$1.json"
}
build_wrong() { # build_wrong service id config: the settings a build depends on that Railway does not have ("" = all good)
  jq -rn --argjson want "$(build_patch "$1" "$2")" --argjson have "$3" --arg id "$2" '
    def norm: if type == "string" then ltrimstr("/") | ascii_downcase else . end;
    $want.services[$id] as $w | ($have.services[$id] // {}) as $h
    | ["build", "builder"], ["build", "dockerfilePath"], ["deploy", "startCommand"]
    | . as $p | select(($w | getpath($p)) != null and (($w | getpath($p) | norm) != ($h | getpath($p) | norm)))
    | "\($p | join(".")) is \($h | getpath($p) // "not set" | tostring)"'
}
for svc in worker api admin backup; do
  if service_exists "$svc"; then
    skip "service $svc"
  else
    rw add --service "$svc" --json >/dev/null || die "could not create the $svc service"
    ok "service $svc created (no code yet)"
  fi
  [ -f "infra/railway.$svc.json" ] || die "infra/railway.$svc.json is missing in $APP_DIR" "Run: git -C $APP_DIR pull"
  id=$(service_id "$svc")
  [ -n "$id" ] || die "the $svc service was created but not found in the service list"
  dockerfile=$(jq -r '.build.dockerfilePath' "infra/railway.$svc.json")
  fix_hint="Railway dashboard: $svc > Settings > Build: Builder Dockerfile, Dockerfile path $dockerfile. Then run this again."
  patch=$(build_patch "$svc" "$id")
  want=$(printf '%s\n' "$patch" | shasum -a 256 | awk '{print $1}')
  cfg=$(env_settings)
  wrong=""
  [ -z "$cfg" ] || wrong=$(build_wrong "$svc" "$id" "$cfg")
  if [ -z "$wrong" ] && [ "$(state_get "BUILD_$svc")" = "$want" ]; then
    skip "$svc builds with $dockerfile"
  else
    send_patch "setup: $svc builds with $dockerfile" "$patch" || die "could not set the build settings of $svc ($TRIES tries): $RW_ERR" "$fix_hint"
    if [ -n "$cfg" ]; then # read them back: nothing is built until Railway holds the Dockerfile settings
      wait_applied "setup: $svc builds with $dockerfile" "$patch" build_wrong "$svc" "$id" ||
        not_applied "$svc" "$id" "the build settings" "Set them there: Settings > Build: Builder Dockerfile, Dockerfile path $dockerfile. Then run this again."
    else
      note "this Railway CLI cannot show settings back; the first build of $svc proves them"
    fi
    state_set "BUILD_$svc" "$want"
    mark_changed "$svc"
    ok "$svc builds with $dockerfile (builder, start command and restart rules from infra/railway.$svc.json)"
  fi
  rw_set "$svc" "RAILWAY_DOCKERFILE_PATH=$dockerfile" # Railway's documented Dockerfile setting: a second lock on the same door
done

# Region: every service, and Postgres with its volume, runs in $REGION_NAME. New services start in the account's
# default region, so each one is moved right after it is created (the app services before their first build). A
# service already running elsewhere is redeployed there: Postgres now (its volume migrates with it, while the
# database is still empty), the others in step 6. Checked against where each deployment really runs.
service_regions() { # the regions the service's running deployment is in, sorted, comma separated ("" = not deployed)
  local l
  l=$(services_json) || exit 1
  printf '%s' "$l" | jq -r --arg n "$1" '.[] | select(.name == $n) | [.regions[]? | select((.configured // 1) > 0) | .name] | sort | join(",")' 2>/dev/null || true
}
region_set() { # region_set service_id config: the configured regions, sorted, comma separated
  jq -rn --argjson have "$2" --arg id "$1" '($have.services[$id].deploy // {}) as $d
    | ([($d.multiRegionConfig // {}) | to_entries[] | select(.value != null) | .key] + [($d.region // empty)]) | unique | join(",")'
}
cron_wrong() { # cron_wrong service_id schedule config: "" when Railway holds that cron schedule
  jq -rn --argjson have "$3" --arg id "$1" --arg c "$2" '($have.services[$id].deploy.cronSchedule // "not set") | select(. != $c) | "deploy.cronSchedule is \(.)"'
}
region_wrong() { # region_wrong service_id config: "" when the configured region is $REGION alone
  local now
  now=$(region_set "$1" "$2")
  [ "$now" = "$REGION" ] || echo "the region is ${now:-not set}"
}
region_patch() { # region_patch service_id config actual: only $REGION stays (every other region null), its volumes follow
  jq -cn --argjson have "$2" --arg id "$1" --arg r "$REGION" --arg actual "$3" --arg all "$ALL_REGIONS" '($have.services[$id] // {}) as $s
    | ([($s.deploy.multiRegionConfig // {}) | keys[]] + [($s.deploy.region // empty)] + ($actual | split(",")) + ($all | split(" "))
       | map(select(. != "")) | unique | map(select(. != $r))) as $old
    | {services: {($id): {deploy: {multiRegionConfig: ({($r): {numReplicas: 1}} + ($old | map({(.): null}) | add // {}))}}},
       volumes: (($s.volumeMounts // {}) | keys | map({(.): {region: $r}}) | add // {})}'
}
NO_CONFIG='{"services":{}}'
for svc in "$PG" worker api admin backup; do
  id=$(service_id "$svc")
  [ -n "$id" ] || die "the $svc service was not found in the service list"
  actual=$(service_regions "$svc")
  cfg=$(env_settings)
  if [ -n "$cfg" ]; then configured=$(region_set "$id" "$cfg"); else configured=$(state_get "REGION_$svc"); fi
  if [ "$configured" = "$REGION" ] && { [ -z "$actual" ] || [ "$actual" = "$REGION" ]; }; then
    skip "$svc runs in $REGION_NAME"
    continue
  fi
  if [ -z "$cfg" ] && [ "$svc" = "$PG" ] && [ -n "$actual" ] && [ "$actual" != "$REGION" ]; then
    die "this Railway CLI cannot move Postgres with its volume" "Railway dashboard: Postgres > Settings > Region: $REGION_NAME, and confirm the volume migration. Then run this again."
  fi
  if [ "$configured" != "$REGION" ]; then
    patch=$(region_patch "$id" "${cfg:-$NO_CONFIG}" "$actual")
    send_patch "setup: $svc runs in $REGION_NAME" "$patch" ||
      die "could not move $svc to $REGION_NAME ($TRIES tries): $RW_ERR" "Railway dashboard: $svc > Settings > Region: $REGION_NAME. Then run this again."
    if [ -n "$cfg" ]; then
      wait_applied "setup: $svc runs in $REGION_NAME" "$patch" region_wrong "$id" ||
        not_applied "$svc" "$id" "the region" "Set it there: Settings > Region: $REGION_NAME. Then run this again."
    fi
    state_set "REGION_$svc" "$REGION"
  fi
  if [ -n "$actual" ] && [ "$actual" != "$REGION" ]; then
    if [ "$svc" = "$PG" ]; then
      say "Moving Postgres from $actual to $REGION_NAME (its volume migrates too, a few minutes while it is still empty)..."
      rebuild "$PG"
      wait_deployed "$PG" 20
      [ "$(service_regions "$PG")" = "$REGION" ] || die "Postgres still runs in $(service_regions "$PG")" "Railway dashboard: Postgres > Settings > Region: $REGION_NAME, confirm the volume migration. Then run this again."
    else
      mark_changed "$svc" # redeployed in step 6
    fi
  fi
  ok "$svc runs in $REGION_NAME"
done

# Railway's Postgres major, before anything depends on it: the backup job's pg_dump refuses a newer server, and the
# restore drill on this Mac restores with this Mac's tools. All three must be the same major.
wait_deployed "$PG" 20
server_num=$(printf '\\echo SERVER_VERSION_NUM :SERVER_VERSION_NUM\n' | rw connect "$PG" 2>/dev/null | sed -n 's/^SERVER_VERSION_NUM \([0-9][0-9]*\).*/\1/p' | tail -1 || true)
[ -n "$server_num" ] || die "could not read the Postgres version on Railway" "Try it yourself: railway connect $PG, then type: show server_version;"
server_major=$((server_num / 10000))
[ "$server_major" = "$PG_MAJOR" ] ||
  die "Railway's database runs Postgres $server_major, but the backup job (infra/backup/Dockerfile) and this Mac's tools are $PG_MAJOR" \
    "The nightly backup and the restore drill would fail. infra/backup/Dockerfile must say FROM postgres:$server_major-alpine;" \
    "once the repo has that, run this again (it installs postgresql@$server_major)."
ok "versions match: Railway's Postgres $server_major, the backup job's pg_dump $PG_MAJOR, this Mac's tools $PG_MAJOR"

# ---------------------------------------------------------------- 4. R2 bucket ----------------------------------------
step "Private R2 bucket for the nightly backups"
BUCKET=$(state_get R2_BUCKET)
if [ -z "$BUCKET" ]; then
  BUCKET="$BUCKET_PREFIX-$(openssl rand -hex 3)"
  state_set R2_BUCKET "$BUCKET"
fi
if wr r2 bucket info "$BUCKET" --json >/dev/null 2>&1; then
  skip "bucket $BUCKET"
else
  wr r2 bucket create "$BUCKET" >/dev/null || die "could not create the R2 bucket $BUCKET" "Is R2 enabled on the account? https://dash.cloudflare.com/?to=/:account/r2/overview"
  ok "bucket $BUCKET created (private: no public access, your other buckets untouched)"
fi
if wr r2 bucket lifecycle list "$BUCKET" 2>/dev/null | grep -q "delete-after-30-days"; then
  skip "30-day delete rule"
else
  wr r2 bucket lifecycle add "$BUCKET" delete-after-30-days rat/ --expire-days 30 --force >/dev/null || die "could not add the 30-day delete rule"
  ok "rule: backups are deleted 30 days after upload"
fi
R2_ENDPOINT="${WSR_R2_ENDPOINT:-https://$CF_ACCOUNT_ID.r2.cloudflarestorage.com}"

if rw_has backup BACKUP_S3_ACCESS_KEY_ID && rw_has backup BACKUP_S3_SECRET_ACCESS_KEY; then
  skip "R2 API token"
else
  say "Cloudflare does not let a CLI login create R2 tokens, so this one is 6 clicks in the browser:"
  say "  1. Create Account API token (or User API token)"
  say "  2. Name: wall-street-rats-backup"
  say "  3. Permissions: Object Read & Write"
  say "  4. Specify bucket(s): only $BUCKET"
  say "  5. TTL: Forever. Click Create."
  say "  6. Keep the page open: you need the Access Key ID and the Secret Access Key."
  open_url "https://dash.cloudflare.com/$CF_ACCOUNT_ID/r2/api-tokens"
  while :; do
    ask_secret R2_KEY_ID "Access Key ID"
    ask_secret R2_SECRET "Secret Access Key"
    # prove the token can write to the bucket: one tiny signed upload (the delete rule removes it)
    probe=$(mktemp)
    printf 'setup check\n' >"$probe"
    code=$(printf 'user = "%s:%s"\n' "$R2_KEY_ID" "$R2_SECRET" | curl -sS -m 30 -K - --aws-sigv4 "aws:amz:auto:s3" \
      -H "x-amz-content-sha256: $(shasum -a 256 "$probe" | awk '{print $1}')" -T "$probe" -o /dev/null -w '%{http_code}' \
      "$R2_ENDPOINT/$BUCKET/rat/setup-check.txt" 2>/dev/null) || code=000
    rm -f "$probe"
    [ "$code" = 200 ] && break
    note "Cloudflare refused that token (HTTP $code). Check it is scoped to $BUCKET with Object Read & Write, and paste both values again."
  done
  rw_secret backup BACKUP_S3_ACCESS_KEY_ID "$R2_KEY_ID"
  rw_secret backup BACKUP_S3_SECRET_ACCESS_KEY "$R2_SECRET"
  unset R2_KEY_ID R2_SECRET
  ok "R2 token works and is stored on the backup service"
fi
rw_set backup "BACKUP_S3_ENDPOINT=$R2_ENDPOINT" "BACKUP_S3_REGION=auto" "BACKUP_S3_BUCKET=$BUCKET" "BACKUP_S3_PREFIX=rat/"
ok "backup service points at $BUCKET"

# ---------------------------------------------------------------- 5. generated secrets ---------------------------------
step "Master key, backup key and passwords (saved to $SECRETS)"
mkdir -p "$SECRETS"
chmod 700 "$SECRETS"
new_files=""
gen() { # gen file command: never overwrites an existing secret file
  if [ -s "$SECRETS/$1" ]; then return 0; fi
  eval "$2" >"$SECRETS/$1"
  chmod 600 "$SECRETS/$1"
  new_files="$new_files $1"
}
if [ ! -s "$SECRETS/rat-backup.key" ]; then
  age-keygen -o "$SECRETS/rat-backup.key" 2>/dev/null
  chmod 600 "$SECRETS/rat-backup.key"
  new_files="$new_files rat-backup.key"
fi
gen KEY_ENCRYPTION_KEY.txt 'openssl rand -base64 32'
gen ADMIN_PASSWORD.txt "openssl rand -base64 30 | tr -d '/+=\n' | cut -c1-28"
gen RAT_API_DB_PASSWORD.txt 'openssl rand -hex 32'
AGE_PUB=$(age-keygen -y "$SECRETS/rat-backup.key")
cat >"$SECRETS/README.txt" <<EOF
THE INUVESTORS secrets. Put every file here in your password manager, then keep this folder or delete it.

rat-backup.key            age PRIVATE key. The only way to read the nightly backups. Its public key is on Railway.
KEY_ENCRYPTION_KEY.txt    master key: encrypts every wallet key in the database. Lose it and the rat wallets are lost.
ADMIN_PASSWORD.txt        password of the private admin page (any user name).
RAT_API_DB_PASSWORD.txt   password of the read-only database user of the public API.
setup-state.env           ids only (no secrets): Railway project, R2 bucket, what the setup already did.
EOF

# master key: set once, never replaced (replacing it would make every stored wallet key unreadable)
MASTER=$(tr -d '\n' <"$SECRETS/KEY_ENCRYPTION_KEY.txt")
if rw_has worker KEY_ENCRYPTION_KEY; then
  worker_vars=$(rw_vars worker) || exit 1
  var_is "$worker_vars" KEY_ENCRYPTION_KEY "$MASTER" ||
    die "the worker already has a DIFFERENT KEY_ENCRYPTION_KEY than $SECRETS/KEY_ENCRYPTION_KEY.txt" \
      "Never replace it. Copy the one in Railway (worker > Variables) into that file, then run this again."
  skip "master key on the worker"
else
  rw_secret worker KEY_ENCRYPTION_KEY "$MASTER"
  rw_set worker KEY_VERSION=1
  ok "master key set on the worker"
fi
unset MASTER worker_vars
# passwords already on Railway are never overwritten
if rw_has admin ADMIN_PASSWORD && rw_has api RAT_API_DB_PASSWORD && rw_has backup BACKUP_AGE_RECIPIENT; then
  skip "admin password, read-only database password and backup public key"
else
  rw_has admin ADMIN_PASSWORD || rw_secret admin ADMIN_PASSWORD "$(tr -d '\n' <"$SECRETS/ADMIN_PASSWORD.txt")"
  rw_has api RAT_API_DB_PASSWORD || rw_secret api RAT_API_DB_PASSWORD "$(tr -d '\n' <"$SECRETS/RAT_API_DB_PASSWORD.txt")"
  ok "admin password, read-only database password and backup public key set on Railway"
fi
rw_set backup "BACKUP_AGE_RECIPIENT=$AGE_PUB"

if [ -n "$new_files" ] || [ "$(state_get SECRETS_SAVED)" != 1 ]; then
  printf '\n%s' "$B$Y"
  printf '  ###########################################################################\n'
  printf '  ##                                                                       ##\n'
  printf '  ##     SAVE THESE FILES IN YOUR PASSWORD MANAGER NOW                     ##\n'
  printf '  ##                                                                       ##\n'
  printf '  ###########################################################################%s\n' "$N"
  for f in rat-backup.key KEY_ENCRYPTION_KEY.txt ADMIN_PASSWORD.txt RAT_API_DB_PASSWORD.txt; do say "$SECRETS/$f"; done
  say "Open the folder with: open $SECRETS"
  say "Without KEY_ENCRYPTION_KEY the rat wallets are lost. Without rat-backup.key no backup can be read."
  pause "Saved all four? Press Enter to continue."
  state_set SECRETS_SAVED 1
fi

# ---------------------------------------------------------------- 6. your secrets --------------------------------------
step "Your secrets (hidden prompts) and the wallets"
rpc_ok() { # rpc_ok url: one getSlot call, the URL (and its api key) stays off the command line
  printf 'url = "%s"\n' "$1" | curl -sS -m 20 -K - -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' 2>/dev/null | jq -e '.result > 0' >/dev/null 2>&1
}
if rw_has worker RPC_URL; then
  skip "Helius RPC URL"
else
  while :; do
    ask_secret RPC "Helius RPC URL (https://mainnet.helius-rpc.com/?api-key=...)"
    rpc_ok "$RPC" && break
    note "that URL did not answer a getSlot call, paste it again"
  done
  rw_secret worker RPC_URL "$RPC"
  unset RPC
  ok "RPC URL works and is set"
fi
if rw_has worker RPC_URL_BACKUP || [ "$(state_get RPC_BACKUP_SKIPPED)" = 1 ]; then
  skip "backup RPC URL"
else
  ask_secret RPC2 "Backup RPC URL (optional, press Enter to skip)" optional
  if [ -z "$RPC2" ]; then
    state_set RPC_BACKUP_SKIPPED 1
    note "no backup RPC: reads have no failover (preflight shows a warning)"
  else
    rpc_ok "$RPC2" || note "the backup RPC did not answer now; it is set anyway, preflight will say if it stays down"
    rw_secret worker RPC_URL_BACKUP "$RPC2"
    ok "backup RPC URL set"
  fi
  unset RPC2
fi
if rw_has worker JUPITER_API_KEY; then
  skip "Jupiter API key"
else
  while :; do
    ask_secret JUP "Jupiter API key"
    code=$(printf 'header = "x-api-key: %s"\n' "$JUP" | curl -sS -m 20 -K - -o /dev/null -w '%{http_code}' \
      "$JUP_API/price/v3?ids=So11111111111111111111111111111111111111112" 2>/dev/null) || code=000
    [ "$code" = 200 ] && break
    note "Jupiter answered HTTP $code with that key, paste it again"
  done
  rw_secret worker JUPITER_API_KEY "$JUP"
  unset JUP
  ok "Jupiter key works and is set"
fi
tg() { printf 'url = "%s/bot%s/%s"\n' "$TG_API" "$1" "$2" | curl -sS -m 20 -K - 2>/dev/null; }
if rw_has worker TELEGRAM_BOT_TOKEN && rw_has worker TELEGRAM_CHAT_ID; then
  skip "Telegram bot and chat"
else
  while :; do
    ask_secret TG_TOKEN "Telegram bot token (from @BotFather)"
    bot=$(tg "$TG_TOKEN" getMe | jq -r 'select(.ok) | .result.username // empty')
    [ -n "$bot" ] && break
    note "Telegram rejected that token, paste it again"
  done
  ok "token belongs to @$bot"
  while :; do
    upd=$(tg "$TG_TOKEN" getUpdates)
    printf '%s' "$upd" | jq -e '.ok' >/dev/null 2>&1 || note "Telegram: $(printf '%s' "$upd" | jq -r '.description // "no answer"' 2>/dev/null)"
    chat=$(printf '%s' "$upd" | jq -c '[.result[]? | (.message // .edited_message // .my_chat_member // .channel_post) | select(. != null) | .chat] | last // empty' 2>/dev/null)
    if [ -n "$chat" ]; then
      who=$(printf '%s' "$chat" | jq -r '[.first_name, .last_name, (if .username then "@" + .username else empty end), .title] | map(select(. != null)) | join(" ")')
      TG_CHAT=$(printf '%s' "$chat" | jq -r '.id')
      if yes_no "Detected chat: $who (id $TG_CHAT). Is that you?" y; then break; fi
    else
      note "no message found for @$bot (Telegram keeps them for 24 hours)"
    fi
    say "In Telegram, open @$bot and send: hi"
    pause "Sent it? Press Enter to look again."
  done
  rw_secret worker TELEGRAM_BOT_TOKEN "$TG_TOKEN"
  rw_set worker "TELEGRAM_CHAT_ID=$TG_CHAT"
  unset TG_TOKEN
  ok "Telegram alerts go to $who"
fi
for svc in admin backup; do rw_set "$svc" 'TELEGRAM_BOT_TOKEN=${{worker.TELEGRAM_BOT_TOKEN}}' 'TELEGRAM_CHAT_ID=${{worker.TELEGRAM_CHAT_ID}}'; done
# shellcheck disable=SC2086 # EXTRA_VARS: space-separated KEY=VALUE words (staging profile only)
rw_set worker "DATABASE_URL=$DB_REF" DRY_RUN=true "CREATOR_PUBKEY=$CREATOR_PUBKEY" "COLD_WALLET=$COLD_WALLET" $EXTRA_VARS
# shellcheck disable=SC2086
rw_set admin "DATABASE_URL=$DB_REF" DRY_RUN=true "CREATOR_PUBKEY=$CREATOR_PUBKEY" $EXTRA_VARS
# shellcheck disable=SC2086
rw_set api "DATABASE_URL_READONLY=postgresql://rat_api:\${{RAT_API_DB_PASSWORD}}@\${{$PG.PGHOST}}:\${{$PG.PGPORT}}/\${{$PG.PGDATABASE}}" \
  DRY_RUN=true "CREATOR_PUBKEY=$CREATOR_PUBKEY" "CORS_ORIGIN=$SITE_ORIGIN" API_CACHE_SEC=3 $EXTRA_VARS
rw_set backup "DATABASE_URL=$DB_REF"
ok "creator wallet $CREATOR_PUBKEY, cold wallet $COLD_WALLET, DRY_RUN=true everywhere${EXTRA_VARS:+ ($EXTRA_VARS)}"

# ---------------------------------------------------------------- deploy the worker ------------------------------------
redeploy_changed worker api admin backup
connect_source worker
wait_deployed worker 20
ssh_ready worker
envc=$(rat_w --env-check 2>&1) || true
case "$envc" in
  *env-ok*) ok "railway ssh reaches the worker and its settings ($(printf '%s' "$envc" | sed -n 's/.*env-ok (settings from \(.*\)).*/\1/p' | head -1))" ;;
  *) die "railway ssh reaches the worker, but its settings (DATABASE_URL, KEY_ENCRYPTION_KEY) could not be handed to the rat command" \
    "What the worker said (names only, no values): $(printf '%s' "$envc" | tail -2 | tr '\n' ' ')" \
    "Check both are set: Railway dashboard, worker, Variables." \
    "Route without railway ssh: cd $APP_DIR && scripts/rat-local.sh keys import --role creator (docs/runbooks/setup-mac.md)" ;;
esac
if [ "$PROFILE" = staging ]; then
  init=$(rat_w staging-init 2>&1) || true
  case "$init" in
    *"Staging database marked"* | *"Already a staging database"*) ok "staging database marked for the test creator $CREATOR_PUBKEY" ;;
    *) die "rat staging-init refused" "$(printf '%s' "$init" | grep -i 'error\|refused' | tail -1)" ;;
  esac
  if [ "$(state_get STAGING_KILL)" != 1 ]; then
    rat_w kill --reason "staging: every phase waits for GO" >/dev/null 2>&1 || die "could not turn the staging kill switch on"
    state_set STAGING_KILL 1
    ok "kill switch ON: nothing is sent until a phase of scripts/staging.sh gets your GO"
  fi
fi

# ---------------------------------------------------------------- 7. creator key -----------------------------------------
step "Import the creator wallet key (hidden prompt, straight into Railway)"
# `rat preflight` exits 1 while any line FAILs, and before launch some always do (no COIN_MINT yet, the creator wallet
# not funded): only its JSON counts, never its exit code. "creator key: PASS" means the stored key is for
# CREATOR_PUBKEY, decrypts with the worker's KEY_ENCRYPTION_KEY and derives that public key (packages/keys keystore.ts).
creator_key_line() { preflight_json | jq -r '.lines[]? | select(.check == "creator key") | "\(.status) \(.detail)"' 2>/dev/null | head -1 || true; }
key_line=$(creator_key_line)
case "$key_line" in
  PASS*) skip "creator key $CREATOR_PUBKEY (stored, decrypts with the master key, matches)" ;;
  "FAIL no creator key imported"*)
    say "In Phantom: open the $CREATOR_LABEL account ($CREATOR_PUBKEY), then Settings > Manage Accounts > that account > Show Private Key."
    say "Type your Phantom password, copy the key, paste it below. It goes into Railway encrypted and is never shown."
    while :; do
      ask_secret CREATOR_SECRET "Creator private key"
      if out=$(printf '%s' "$CREATOR_SECRET" | rat_w_in keys import --role creator 2>&1); then
        break
      fi
      msg=$(printf '%s\n' "$out" | grep -i 'error' | tail -1 || true)
      case "$msg" in *"already stored"*) note "a creator key is already stored: checking it instead"; break ;; esac
      note "not imported: ${msg:-the import failed}"
      say "It must be the private key of $CREATOR_PUBKEY (a key for any other wallet is refused)."
    done
    unset CREATOR_SECRET out
    ${WSR_PBCOPY:-pbcopy} </dev/null 2>/dev/null || true # clear the clipboard: the key was on it
    key_line=$(creator_key_line)
    case "$key_line" in
      PASS*) ok "creator key stored, decrypts with the master key, matches $CREATOR_PUBKEY (clipboard cleared)" ;;
      *) die "the stored creator key does not work: ${key_line:-rat preflight gave no answer}" \
        "Check it yourself: scripts/rat.sh preflight (the \"creator key\" line)." ;;
    esac ;;
  "")
    die "rat preflight did not report the creator key, so it cannot be checked" \
      "Try it yourself: cd $APP_DIR && scripts/rat.sh preflight" ;;
  *)
    die "a creator key is stored but does not work: ${key_line#FAIL }" \
      "Nothing was changed. If KEY_ENCRYPTION_KEY on the worker was replaced, put the original back (it is in $SECRETS)." ;;
esac

# ---------------------------------------------------------------- read-only user, api, admin ----------------------------
if [ "$(state_get READONLY_USER)" = 1 ]; then
  skip "read-only database user for the API"
else
  # psql runs locally through railway connect; the password comes from the environment (\getenv), not the SQL text
  RAT_API_PW=$(tr -d '\n' <"$SECRETS/RAT_API_DB_PASSWORD.txt")
  export RAT_API_PW
  rw connect "$PG" >/dev/null 2>"$SECRETS/.psql-err" <<'SQL' ||
\set ON_ERROR_STOP on
\set VERBOSITY terse
\getenv rat_pw RAT_API_PW
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rat_api') AS missing \gset
\if :missing
CREATE ROLE rat_api LOGIN;
\endif
ALTER ROLE rat_api WITH LOGIN PASSWORD :'rat_pw';
GRANT USAGE ON SCHEMA public TO rat_api;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO rat_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO rat_api;
REVOKE ALL ON key_pool FROM rat_api;
SQL
    die "could not create the read-only database user" "$(tail -2 "$SECRETS/.psql-err" 2>/dev/null)"
  unset RAT_API_PW
  rm -f "$SECRETS/.psql-err"
  state_set READONLY_USER 1
  ok "read-only database user rat_api (the public API can only read)"
fi
connect_source api
connect_source admin
wait_deployed api 20
wait_deployed admin 20
domain_of() { # the service's railway domain (created the first time, listed after)
  rw domain --service "$1" --json 2>/dev/null | jq -r '.domain // .domains[0] // empty' 2>/dev/null | sed 's#^https://##; s#/$##' || true
}
API_DOMAIN=$(domain_of api)
ADMIN_DOMAIN=$(domain_of admin)
[ -n "$API_DOMAIN" ] && state_set API_DOMAIN "$API_DOMAIN"
[ -n "$ADMIN_DOMAIN" ] && state_set ADMIN_DOMAIN "$ADMIN_DOMAIN"
if [ -n "$API_DOMAIN" ] && curl -fsS -m 20 "https://$API_DOMAIN/api/state" >/dev/null 2>&1; then
  ok "public API answers: https://$API_DOMAIN/api/state"
else
  note "the public API did not answer yet at https://$API_DOMAIN (a new domain can take a few minutes)"
fi
ok "admin page: https://$ADMIN_DOMAIN (any user name, password in ADMIN_PASSWORD.txt)"

# ---------------------------------------------------------------- 8. preflight + alert ---------------------------------
step "DRY RUN preflight and a test alert"
pre=$(preflight_json)
[ -n "$pre" ] || die "rat preflight gave no answer" "Try it yourself: railway ssh --service worker, then: cd /app && pnpm --filter @rat/cli rat preflight"
printf '%s' "$pre" | jq -r '.lines[] | "\(.status)\t\(.check)\t\(.detail)"' | while IFS="$(printf '\t')" read -r st ck dt; do
  case "$st" in PASS) c="$G" ;; WARN) c="$Y" ;; *) c="$R" ;; esac
  printf '        %s%-4s%s  %-14s %s\n' "$c" "$st" "$N" "$ck" "$dt"
done
# before launch, exactly these may fail: no coin yet, and the creator wallet is funded right before launch
blocking=$(printf '%s' "$pre" | jq -r '.lines[] | select(.status == "FAIL")
  | select((.check == "settings" and .detail == "missing: COIN_MINT (see .env.example).") or .check == "creator wallet" | not)
  | .check')
if [ -n "$blocking" ]; then
  die "preflight has FAIL lines that must be fixed before launch day: $(printf '%s' "$blocking" | tr '\n' ' ')" "Each FAIL line above says how to fix it."
fi
printf '%s' "$pre" | jq -e '.lines[] | select(.check == "creator wallet" and .status == "FAIL")' >/dev/null &&
  note "creator wallet has less than the 0.05 SOL reserve: expected, you fund it right before launch"
printf '%s' "$pre" | jq -e '.lines[] | select(.check == "settings" and .status == "FAIL")' >/dev/null &&
  note "COIN_MINT is empty: expected, it is set right after the launch (LAUNCH-DAY.md)"
printf '%s' "$pre" | jq -e '.lines[] | select(.check == "stocks" and .status != "PASS")' >/dev/null &&
  note "no stock is approved yet: before launch, verify the mints on xstocks.fi with: scripts/approve-stocks.sh"
ok "preflight: nothing else blocks"
if [ "$(state_get ALERT_OK)" = 1 ]; then
  skip "Telegram test alert"
else
  rat_w alert-test >/dev/null 2>&1 || die "the test alert could not be sent" "Check TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID on the worker."
  if yes_no "A test alert was sent to Telegram. Did it arrive on your phone?" y; then
    state_set ALERT_OK 1
    ok "Telegram alerts arrive"
  else
    die "the test alert did not arrive" "Open your bot in Telegram, press Start, then run this again."
  fi
fi

# ---------------------------------------------------------------- 9. backup, schedule, drill ----------------------------
step "First backup now, then every night, then a restore drill"
if [ "$(state_get BACKUP_FIRST_OK)" = "" ]; then
  # without a schedule yet, each deploy runs one backup and exits. An earlier attempt (a failed backup) is never
  # read again: the backup is rebuilt from the latest commit and only the new deployment's log counts.
  if connected backup; then
    rebuild backup
    say "running the backup again with the latest code"
  else
    connect_source backup
  fi
  say "Waiting for the first backup (build + run, a few minutes)..."
  i=0
  old=$(replaced_deployment backup)
  while :; do
    if [ -n "$old" ] && [ "$(deployment_id backup)" = "$old" ]; then logs=""; else logs=$(rw logs --service backup --latest --lines 80 2>/dev/null || true); fi
    obj=$(printf '%s\n' "$logs" | sed -n 's/.*backup: ok \(rat\/rat-[0-9-]*\.dump\.age\).*/\1/p' | tail -1)
    [ -n "$obj" ] && break
    if printf '%s\n' "$logs" | grep -q 'backup: FAILED'; then
      printf '%s\n' "$logs" | grep 'backup: ' | tail -3 | sed 's/^/        | /'
      die "the first backup failed (a Telegram alert was sent too)" "The reason is on the line above."
    fi
    i=$((i + 1))
    [ "$i" -gt 120 ] && die "no backup result after 20 minutes" "Check the backup service logs in the Railway dashboard."
    sleep "${WSR_POLL_SEC:-10}"
  done
  state_set BACKUP_FIRST_OK "$obj"
  ok "first backup uploaded: $BUCKET/$obj (encrypted)"
else
  skip "first backup ($(state_get BACKUP_FIRST_OK))"
fi
if [ "$PROFILE" = staging ]; then
  note "staging: no nightly schedule (scripts/staging.sh 8 runs a backup when you ask)"
elif [ "$(state_get CRON_SET)" = 1 ]; then
  skip "nightly schedule"
else
  id=$(service_id backup)
  patch=$(jq -nc --arg id "$id" --arg c "$BACKUP_CRON" '{services: {($id): {deploy: {cronSchedule: $c}}}}')
  send_patch "setup: nightly backup" "$patch" || die "could not set the backup schedule ($TRIES tries): $RW_ERR" "Railway dashboard: backup > Settings > Cron Schedule: $BACKUP_CRON. Then run this again."
  if [ -n "$HAS_ENV_CONFIG" ]; then
    wait_applied "setup: nightly backup" "$patch" cron_wrong "$id" "$BACKUP_CRON" ||
      not_applied backup "$id" "the nightly schedule" "Set it there: Settings > Cron Schedule: $BACKUP_CRON. Then run this again."
  fi
  state_set CRON_SET 1
  ok "backup runs every night at 03:30 UTC"
fi
if [ "$PROFILE" = staging ]; then
  : # no schedule, so no missed-night check
elif [ -n "$(state_get HEARTBEAT)" ]; then
  skip "missed-night check ($(state_get HEARTBEAT))"
elif yes_no "Add a free healthchecks.io check, so a night the backup never starts also alerts you on Telegram?" n; then
  say "1. Sign up (free) at healthchecks.io.  2. Integrations > Telegram: add it (their bot sends you a link)."
  say "3. Settings > API Access > Create API key (not read-only). Copy it."
  open_url "https://healthchecks.io/accounts/signup/"
  while :; do
    ask_secret HC_KEY "healthchecks.io API key"
    ping=$(printf 'header = "X-Api-Key: %s"\n' "$HC_KEY" | curl -sS -m 20 -K - -H 'content-type: application/json' \
      -d "{\"name\":\"wall-street-rats backup\",\"slug\":\"wsr-backup\",\"schedule\":\"$BACKUP_CRON\",\"tz\":\"UTC\",\"grace\":7200,\"channels\":\"*\",\"unique\":[\"slug\"]}" \
      "$HC_API/api/v3/checks/" 2>/dev/null | jq -r '.ping_url // empty' || true)
    [ -n "$ping" ] && break
    note "healthchecks.io refused that key, paste it again"
  done
  unset HC_KEY
  CHANGED=" "
  rw_secret backup BACKUP_HEARTBEAT_URL "$ping"
  redeploy_changed backup # the running schedule picks the new setting up
  state_set HEARTBEAT yes
  ok "missed-night check created (alerts through your healthchecks.io Telegram integration)"
else
  state_set HEARTBEAT skipped
  note "no missed-night check (you can add it later: docs/runbooks/backup-restore.md)"
fi

if [ "$(state_get DRILL_PASSED)" != "" ]; then
  skip "restore drill ($(state_get DRILL_PASSED))"
else
  obj=$(state_get BACKUP_FIRST_OK)
  drill=$(mktemp -d)
  cleanup_drill() { [ -f "$drill/pg/postmaster.pid" ] && pg_ctl -D "$drill/pg" -m fast stop >/dev/null 2>&1; rm -rf "$drill"; }
  trap cleanup_drill EXIT
  wr r2 object get "$BUCKET/$obj" --file "$drill/$(basename "$obj")" --remote >/dev/null || die "could not download $obj from R2"
  initdb -D "$drill/pg" -U postgres -A trust >/dev/null
  port=$((20000 + RANDOM % 20000))
  pg_ctl -D "$drill/pg" -o "-p $port -k $drill -c listen_addresses=''" -l "$drill/pg.log" -w start >/dev/null || die "could not start the temporary database"
  if infra/backup/restore-check.sh "$drill/$(basename "$obj")" "$SECRETS/rat-backup.key" "postgresql://postgres@/postgres?host=$drill&port=$port" | sed 's/^/        /'; then
    state_set DRILL_PASSED "$(basename "$obj") $(date -u +%Y-%m-%d)"
    ok "restore drill PASSED on the real backup (temporary database deleted)"
  else
    die "the restore drill did not pass" "The lines above say why. Nothing was changed on Railway."
  fi
  cleanup_drill
  trap - EXIT
fi

# ---------------------------------------------------------------- 10. checklist ------------------------------------------
step "Done"
for svc in "$PG" worker api admin backup; do # where every deployment really runs
  r=$(service_regions "$svc")
  [ -z "$r" ] || [ "$r" = "$REGION" ] || die "$svc runs in $r, not $REGION_NAME" "Railway dashboard: $svc > Settings > Region: $REGION_NAME. Then run this again."
done
for l in "tools installed, repo at $APP_DIR" \
  "every service and Postgres run in $REGION_NAME" \
  "Railway project: Postgres, worker, api, admin, backup (DRY RUN)" \
  "R2 bucket $BUCKET, private, backups deleted after 30 days" \
  "secrets in $SECRETS (you saved them in your password manager)" \
  "Helius, Jupiter and Telegram set; alerts arrive" \
  "creator key imported for $CREATOR_PUBKEY; cold wallet $COLD_WALLET" \
  "preflight: only the expected pre-launch items open" \
  "backup ran$([ "$PROFILE" = staging ] || echo ", nightly at 03:30 UTC"), restore drill PASSED"; do
  printf '  %s[x]%s %s\n' "$G" "$N" "$l"
done
printf '\n  %sAdmin page%s  https://%s\n  %sPublic API%s  https://%s/api/state\n' "$B" "$N" "$(state_get ADMIN_DOMAIN)" "$B" "$N" "$(state_get API_DOMAIN)"
if [ "$PROFILE" = staging ]; then
  printf '\n  %sNEXT STEP%s  The rehearsal: docs/runbooks/rehearsal.md. Start with: %s/scripts/staging.sh check\n' "$B$G" "$N" "$APP_DIR"
  say "The staging worker is in DRY RUN with its kill switch ON. Every mainnet transaction waits for your GO."
else
  printf '\n  %sNEXT STEP%s  Open %s/LAUNCH-DAY.md and do "The night before".\n' "$B$G" "$N" "$APP_DIR"
  say "Then, right before launch: send about 0.3 SOL to $CREATOR_PUBKEY (0.1 dev buy, launch cost, 0.05 reserve)."
  say "Everything stays in DRY RUN until you follow T-0 in LAUNCH-DAY.md yourself."
fi
