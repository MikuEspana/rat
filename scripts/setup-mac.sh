#!/bin/bash
# WALL STREET RATS: the whole backend setup on a Mac, in one command. DRY RUN only: nothing here can send a
# mainnet transaction. Safe to re-run: every step checks what is already done and skips it.
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/MikuEspana/rat/main/scripts/setup-mac.sh)"
#
# What it does (docs/runbooks/setup-mac.md has the long version):
#   1 tools (Homebrew: railway, node, age, jq, postgresql@16)   2 log in to Railway and Cloudflare (browser)
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
#   PostgreSQL 16   https://www.postgresql.org/docs/16/app-pgrestore.html
# shellcheck disable=SC2015,SC2016,SC2153 # literal ${{references}} for Railway; RPC is set by ask_secret
set -euo pipefail

# ---------------------------------------------------------------- settings --------------------------------------------
REPO_SLUG="MikuEspana/rat"
REPO_URL="https://github.com/$REPO_SLUG.git"
BRANCH="main"
APP_DIR="${WSR_DIR:-$HOME/wallstreetrats}"
SECRETS="${WSR_SECRETS:-$HOME/rat-secrets}"
STATE="$SECRETS/setup-state.env"
PROJECT_NAME="wall-street-rats"
CREATOR_PUBKEY="${WSR_CREATOR_PUBKEY:-4VYWcTTDYyMVic58AcUC7Nodt6vNQwjKhA9UphaAKiot}"
COLD_WALLET="${WSR_COLD_WALLET:-DX7RpxyhbcGeiBQh76ed2wZHw8WZ2CdMoDibpWmX9ajj}"
SITE_ORIGIN="https://wallstreetrats.world"
BACKUP_CRON="30 3 * * *"
TG_API="${WSR_TELEGRAM_API:-https://api.telegram.org}"
HC_API="${WSR_HEALTHCHECKS_API:-https://healthchecks.io}"
JUP_API="${WSR_JUPITER_API:-https://api.jup.ag}"
RAT="cd /app && pnpm --silent --filter @rat/cli rat"

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
rw_json() { rw "$@" --json 2>/dev/null; }
# variable names set on a service (values are read into jq only, never printed)
rw_has() { rw variable list --service "$1" --json 2>/dev/null | jq -e --arg k "$2" 'has($k) and .[$k] != ""' >/dev/null 2>&1; }
CHANGED=" "
mark_changed() { case "$CHANGED" in *" $1 "*) ;; *) CHANGED="$CHANGED$1 " ;; esac; }
rw_set() { # rw_set service KEY=VALUE ...: non-secret values and ${{references}}, written only when they differ
  local svc="$1" cur kv k v
  shift
  cur=$(rw variable list --service "$svc" --json 2>/dev/null || echo '{}')
  for kv in "$@"; do
    k=${kv%%=*}
    v=${kv#*=}
    case "$v" in
      *'${{'*) printf '%s' "$cur" | jq -e --arg k "$k" 'has($k)' >/dev/null 2>&1 && continue ;; # Railway lists the resolved value
      *) printf '%s' "$cur" | jq -e --arg k "$k" --arg v "$v" '.[$k] == $v' >/dev/null 2>&1 && continue ;;
    esac
    rw variable set "$kv" --service "$svc" --skip-deploys >/dev/null || die "could not set $k on the $svc service" "Check: railway variable list --service $svc"
    mark_changed "$svc"
  done
}
rw_secret() { # rw_secret service KEY value: the value goes through stdin, never on a command line
  printf '%s' "$3" | rw variable set "$2" --stdin --service "$1" --skip-deploys >/dev/null || die "could not set $2 on the $1 service"
  mark_changed "$1"
}
rw_ssh() { # rw_ssh service "command": runs inside the running container
  rw ssh --service "$1" -i "$SSH_KEY" -- sh -c "$2"
}
service_exists() { rw service list --json 2>/dev/null | jq -e --arg n "$1" 'map(.name) | index($n) != null' >/dev/null 2>&1; }
service_status() { rw service status --service "$1" --json 2>/dev/null | jq -r '.status // "NONE"' 2>/dev/null || echo NONE; }
wait_deployed() { # wait_deployed service minutes
  local svc="$1" mins="$2" s i=0
  say "Waiting for the $svc service to build and start (can take a few minutes)..."
  while :; do
    s=$(service_status "$svc")
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

# ---------------------------------------------------------------- 0. sanity + repo ------------------------------------
if [ "$(uname -s)" != Darwin ] && [ -z "${WSR_TEST:-}" ]; then die "this script is for macOS" "On other systems follow docs/runbooks/deploy.md by hand."; fi
if [ ! -t 0 ] && [ -z "${WSR_TEST:-}" ]; then
  die "the prompts need your keyboard" 'Run it exactly like this: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/MikuEspana/rat/main/scripts/setup-mac.sh)"'
fi
umask 077

printf '%s\n' "${B}WALL STREET RATS setup${N}  (DRY RUN only. Nothing here can send a mainnet transaction.)"
say "Secrets are only typed into hidden prompts. Never paste a seed phrase anywhere."

# ---------------------------------------------------------------- 1. tools --------------------------------------------
step "Install what is missing"
if ! command -v brew >/dev/null 2>&1; then
  die "Homebrew is not installed" "Install it from https://brew.sh (one command), open a new Terminal, then run this again."
fi
for f in git railway node age jq postgresql@16; do
  bin="$f"
  case "$f" in node) bin=npx ;; postgresql@16) bin="" ;; esac
  if [ -n "$bin" ] && command -v "$bin" >/dev/null 2>&1; then continue; fi
  if [ -z "$bin" ] && brew list --versions postgresql@16 >/dev/null 2>&1; then continue; fi
  say "brew install $f"
  brew install "$f" >/dev/null || die "brew install $f failed" "Run: brew install $f   and read its error."
done
PG_BIN="${WSR_PG_BIN:-$(brew --prefix postgresql@16 2>/dev/null)/bin}"
[ -x "$PG_BIN/psql" ] || die "psql from postgresql@16 was not found in $PG_BIN" "Run: brew reinstall postgresql@16"
export PATH="$PG_BIN:$PATH" # pg_restore / psql 16 match Railway's Postgres 16 (restore drill, read-only user)
ok "railway $(rw --version 2>/dev/null | awk '{print $NF}'), node $(node --version 2>/dev/null), $(age --version 2>/dev/null | head -1 | sed 's/^/age /'), psql $(psql --version | awk '{print $3}')"

if [ -z "${WSR_SKIP_CLONE:-}" ]; then
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only -q origin "$BRANCH" >/dev/null 2>&1 || note "could not update $APP_DIR (local changes?), using it as it is"
  else
    git clone -q --branch "$BRANCH" "$REPO_URL" "$APP_DIR" || die "could not download the repo to $APP_DIR"
  fi
fi
cd "$APP_DIR"
ok "repo at $APP_DIR"

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
if rw ssh keys list 2>/dev/null | grep -q "$(ssh-keygen -lf "$SSH_KEY.pub" | awk '{print $2}')"; then
  skip "SSH key for railway ssh"
else
  rw ssh keys add --key "$(basename "$SSH_KEY")" --name "wall-street-rats setup" >/dev/null || die "could not register the SSH key with Railway" "Run: railway ssh keys add"
  ok "SSH key registered with Railway (for running commands inside the worker)"
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
state_set RAILWAY_PROJECT_ID "$(rw status --json 2>/dev/null | jq -r '.id // empty')"

PG=$(rw service list --json 2>/dev/null | jq -r 'map(select(.name | test("^Postgres"))) | .[0].name // empty')
if [ -n "$PG" ]; then
  skip "Postgres ($PG)"
else
  rw add --database postgres --json >/dev/null || die "could not add Postgres"
  PG=$(rw service list --json 2>/dev/null | jq -r 'map(select(.name | test("^Postgres"))) | .[0].name // empty')
  [ -n "$PG" ] || die "Postgres was added but not found in the service list"
  ok "Postgres 16 added (private network only)"
fi
DB_REF="\${{$PG.DATABASE_URL}}"

for svc in worker api admin backup; do
  if service_exists "$svc"; then
    skip "service $svc"
  else
    rw add --service "$svc" --json >/dev/null || die "could not create the $svc service"
    ok "service $svc created (no code yet)"
  fi
  if [ "$(state_get "CONFIG_$svc")" != 1 ]; then
    rw environment edit --service-config "$svc" configFile "/infra/railway.$svc.json" -m "setup: $svc config file" --json >/dev/null ||
      die "could not point $svc at infra/railway.$svc.json"
    state_set "CONFIG_$svc" 1
  fi
done
ok "each service reads its settings from infra/railway.<service>.json in the repo"

# ---------------------------------------------------------------- 4. R2 bucket ----------------------------------------
step "Private R2 bucket for the nightly backups"
BUCKET=$(state_get R2_BUCKET)
if [ -z "$BUCKET" ]; then
  BUCKET="wsr-db-backups-$(openssl rand -hex 3)"
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
WALL STREET RATS secrets. Put every file here in your password manager, then keep this folder or delete it.

rat-backup.key            age PRIVATE key. The only way to read the nightly backups. Its public key is on Railway.
KEY_ENCRYPTION_KEY.txt    master key: encrypts every wallet key in the database. Lose it and the rat wallets are lost.
ADMIN_PASSWORD.txt        password of the private admin page (any user name).
RAT_API_DB_PASSWORD.txt   password of the read-only database user of the public API.
setup-state.env           ids only (no secrets): Railway project, R2 bucket, what the setup already did.
EOF

# master key: set once, never replaced (replacing it would make every stored wallet key unreadable)
MASTER=$(tr -d '\n' <"$SECRETS/KEY_ENCRYPTION_KEY.txt")
if rw_has worker KEY_ENCRYPTION_KEY; then
  [ "$(rw variable list --service worker --json 2>/dev/null | jq -j '.KEY_ENCRYPTION_KEY' | shasum -a 256)" = "$(printf '%s' "$MASTER" | shasum -a 256)" ] ||
    die "the worker already has a DIFFERENT KEY_ENCRYPTION_KEY than $SECRETS/KEY_ENCRYPTION_KEY.txt" \
      "Never replace it. Copy the one in Railway (worker > Variables) into that file, then run this again."
  skip "master key on the worker"
else
  rw_secret worker KEY_ENCRYPTION_KEY "$MASTER"
  rw_set worker KEY_VERSION=1
  ok "master key set on the worker"
fi
unset MASTER
rw_has admin ADMIN_PASSWORD || rw_secret admin ADMIN_PASSWORD "$(tr -d '\n' <"$SECRETS/ADMIN_PASSWORD.txt")"
rw_has api RAT_API_DB_PASSWORD || rw_secret api RAT_API_DB_PASSWORD "$(tr -d '\n' <"$SECRETS/RAT_API_DB_PASSWORD.txt")"
rw_set backup "BACKUP_AGE_RECIPIENT=$AGE_PUB"
ok "admin password, read-only database password and backup public key set on Railway"

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
rw_set worker "DATABASE_URL=$DB_REF" DRY_RUN=true "CREATOR_PUBKEY=$CREATOR_PUBKEY" "COLD_WALLET=$COLD_WALLET"
rw_set admin "DATABASE_URL=$DB_REF" DRY_RUN=true "CREATOR_PUBKEY=$CREATOR_PUBKEY"
rw_set api "DATABASE_URL_READONLY=postgresql://rat_api:\${{RAT_API_DB_PASSWORD}}@\${{$PG.PGHOST}}:\${{$PG.PGPORT}}/\${{$PG.PGDATABASE}}" \
  DRY_RUN=true "CREATOR_PUBKEY=$CREATOR_PUBKEY" "CORS_ORIGIN=$SITE_ORIGIN" API_CACHE_SEC=3
rw_set backup "DATABASE_URL=$DB_REF"
ok "creator wallet $CREATOR_PUBKEY, cold wallet $COLD_WALLET, DRY_RUN=true everywhere"

# ---------------------------------------------------------------- deploy the worker ------------------------------------
connected() { [ "$(rw service list --json 2>/dev/null | jq -r --arg n "$1" '.[] | select(.name == $n) | .source.repo // empty')" = "$REPO_SLUG" ]; }
connect_source() { # connect_source service: the first deploy starts with every setting already in place
  if connected "$1"; then return 0; fi
  rw service source connect --repo "$REPO_SLUG" --branch "$BRANCH" --service "$1" --json >/dev/null ||
    die "could not connect $1 to github.com/$REPO_SLUG" "Give Railway access to the repo: https://github.com/apps/railway-app/installations/new"
}
# a setting changed on a service that already runs (a re-run): redeploy it so the change applies
redeploy_changed() { # redeploy_changed service...: only services already running whose settings changed
  local svc
  for svc in "$@"; do
    case "$CHANGED" in *" $svc "*) connected "$svc" && { rw redeploy --service "$svc" --yes >/dev/null && say "redeploying $svc (a setting changed)"; } ;; esac
  done
  return 0
}
redeploy_changed worker api admin backup
connect_source worker
wait_deployed worker 20
rw_ssh worker 'test -n "$DATABASE_URL" && test -n "$KEY_ENCRYPTION_KEY" && echo env-ok' 2>/dev/null | grep -q env-ok ||
  die "railway ssh into the worker works, but its settings are not visible there" "Open the worker in the Railway dashboard and check Variables."

# ---------------------------------------------------------------- 7. creator key -----------------------------------------
step "Import the creator wallet key (hidden prompt, straight into Railway)"
creator_key_ok() { rw_ssh worker "$RAT preflight --json" 2>/dev/null | grep '^{' | tail -1 | jq -e '.lines[] | select(.check == "creator key" and .status == "PASS")' >/dev/null 2>&1; }
if creator_key_ok; then
  skip "creator key $CREATOR_PUBKEY"
else
  say "In Phantom: open the creator account ($CREATOR_PUBKEY), then Settings > Manage Accounts > that account > Show Private Key."
  say "Type your Phantom password, copy the key, paste it below. It goes into Railway encrypted and is never shown."
  while :; do
    ask_secret CREATOR_SECRET "Creator private key"
    if out=$(printf '%s' "$CREATOR_SECRET" | rw_ssh worker "$RAT keys import --role creator" 2>&1); then
      break
    fi
    msg=$(printf '%s\n' "$out" | grep -i 'error' | tail -1)
    note "not imported: ${msg:-the import failed}"
    case "$msg" in *"already stored"*) break ;; esac
    say "It must be the private key of $CREATOR_PUBKEY (a key for any other wallet is refused)."
  done
  unset CREATOR_SECRET out
  ${WSR_PBCOPY:-pbcopy} </dev/null 2>/dev/null || true # clear the clipboard: the key was on it
  creator_key_ok || die "the creator key is not usable" "Run this again and paste the private key of $CREATOR_PUBKEY."
  ok "creator key imported, encrypted with the master key, matches $CREATOR_PUBKEY (clipboard cleared)"
fi

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
  rw domain --service "$1" --json 2>/dev/null | jq -r '.domain // .domains[0] // empty' 2>/dev/null | sed 's#^https://##; s#/$##'
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
pre=$(rw_ssh worker "$RAT preflight --json" 2>/dev/null | grep '^{' | tail -1)
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
  note "no stock is approved yet: before launch, verify the mints on xstocks.fi, set approved=true in config/stocks.json, then rat stocks-sync"
ok "preflight: nothing else blocks"
if [ "$(state_get ALERT_OK)" = 1 ]; then
  skip "Telegram test alert"
else
  rw_ssh worker "$RAT alert-test" >/dev/null 2>&1 || die "the test alert could not be sent" "Check TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID on the worker."
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
  connect_source backup # without a schedule yet, the first deploy runs one backup and exits
  say "Waiting for the first backup (build + run, a few minutes)..."
  i=0
  while :; do
    logs=$(rw logs --service backup --latest --lines 80 2>/dev/null || true)
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
if [ "$(state_get CRON_SET)" = 1 ]; then
  skip "nightly schedule"
else
  rw environment edit --service-config backup deploy.cronSchedule "$BACKUP_CRON" -m "setup: nightly backup" --json >/dev/null || die "could not set the backup schedule"
  state_set CRON_SET 1
  ok "backup runs every night at 03:30 UTC"
fi
if [ -n "$(state_get HEARTBEAT)" ]; then
  skip "missed-night check ($(state_get HEARTBEAT))"
elif yes_no "Add a free healthchecks.io check, so a night the backup never starts also alerts you on Telegram?" n; then
  say "1. Sign up (free) at healthchecks.io.  2. Integrations > Telegram: add it (their bot sends you a link)."
  say "3. Settings > API Access > Create API key (not read-only). Copy it."
  open_url "https://healthchecks.io/accounts/signup/"
  while :; do
    ask_secret HC_KEY "healthchecks.io API key"
    ping=$(printf 'header = "X-Api-Key: %s"\n' "$HC_KEY" | curl -sS -m 20 -K - -H 'content-type: application/json' \
      -d "{\"name\":\"wall-street-rats backup\",\"slug\":\"wsr-backup\",\"schedule\":\"$BACKUP_CRON\",\"tz\":\"UTC\",\"grace\":7200,\"channels\":\"*\",\"unique\":[\"slug\"]}" \
      "$HC_API/api/v3/checks/" 2>/dev/null | jq -r '.ping_url // empty')
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
for l in "tools installed, repo at $APP_DIR" \
  "Railway project: Postgres, worker, api, admin, backup (DRY RUN)" \
  "R2 bucket $BUCKET, private, backups deleted after 30 days" \
  "secrets in $SECRETS (you saved them in your password manager)" \
  "Helius, Jupiter and Telegram set; alerts arrive" \
  "creator key imported for $CREATOR_PUBKEY; cold wallet $COLD_WALLET" \
  "preflight: only the expected pre-launch items open" \
  "backup ran, nightly at 03:30 UTC, restore drill PASSED"; do
  printf '  %s[x]%s %s\n' "$G" "$N" "$l"
done
printf '\n  %sAdmin page%s  https://%s\n  %sPublic API%s  https://%s/api/state\n' "$B" "$N" "$(state_get ADMIN_DOMAIN)" "$B" "$N" "$(state_get API_DOMAIN)"
printf '\n  %sNEXT STEP%s  Open %s/LAUNCH-DAY.md and do "The night before".\n' "$B$G" "$N" "$APP_DIR"
say "Then, right before launch: send about 0.3 SOL to $CREATOR_PUBKEY (0.1 dev buy, launch cost, 0.05 reserve)."
say "Everything stays in DRY RUN until you follow T-0 in LAUNCH-DAY.md yourself."
