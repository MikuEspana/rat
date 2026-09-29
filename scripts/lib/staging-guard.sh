# The staging guards, shared by scripts/staging.sh and scripts/staging-local.sh (sourced after scripts/lib/wsr.sh).
# Nothing runs unless this folder is linked to the staging project: STAGING on for the worker, a test creator that is
# not the production one, a master key that differs from production's, and never the production project.
# shellcheck shell=bash
SECRETS="${WSR_SECRETS:-$HOME/rat-secrets-staging}"
PROD_SECRETS="${WSR_PROD_SECRETS:-$HOME/rat-secrets}"
STATE="$SECRETS/setup-state.env"
PRODUCTION_CREATOR="4VYWcTTDYyMVic58AcUC7Nodt6vNQwjKhA9UphaAKiot"
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
  case "$staging" in true) ;; *) echo "STAGING is not true on the worker" ;; esac
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
