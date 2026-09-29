#!/bin/bash
# Saves an encrypted copy of every stored key on THIS Mac. The rat wallets' keys exist nowhere else (the nightly
# database backup is up to a day old), so run it every hour or so while the bot hires, and once at the end:
#   scripts/keys-backup.sh          (from ~/wallstreetrats; from ~/wallstreetrats-staging for the rehearsal)
# `rat keys backup` runs inside the Railway worker (scripts/rat.sh), where a file would stay on the container's disk
# and vanish with the next deploy: it prints the backup instead, still encrypted with KEY_ENCRYPTION_KEY, and this
# script saves it in ~/wallstreetrats-key-backups/<this folder's name>/ (folder 0700, files 0600).
# Keep that folder and KEY_ENCRYPTION_KEY in two different places: one without the other is useless to a thief.
set -euo pipefail
cd "$(dirname "$0")/.."
die() {
  printf 'keys-backup: %s\n' "$1" >&2
  shift
  for l in "$@"; do printf '             %s\n' "$l" >&2; done
  exit 1
}
command -v jq >/dev/null 2>&1 || die "jq is missing" "Run: brew install jq"
dir="${WSR_KEY_BACKUP_DIR:-$HOME/wallstreetrats-key-backups}/$(basename "$PWD")"
mkdir -p "$dir"
chmod 700 "$dir"
raw=$(mktemp)
json=$(mktemp)
trap 'rm -f "$raw" "$json"' EXIT

"${WSR_RAT:-scripts/rat.sh}" keys backup --out - </dev/null >"$raw" || die "the backup command failed (its message is above). Nothing was saved."
# railway ssh may add carriage returns; only the lines between the markers are the backup
tr -d '\r' <"$raw" | sed -n '/^-----BEGIN RAT KEY BACKUP-----$/,/^-----END RAT KEY BACKUP-----$/p' | sed '1d;$d' >"$json"
jq -e '.format == "rat-race-keys-v1" and (.keys | type == "array") and ([.keys[] | select(.role == "creator")] | length) == 1' "$json" >/dev/null 2>&1 ||
  die "the answer is not a complete key backup. Nothing was saved."
keys=$(jq '.keys | length' "$json")
rats=$(jq '[.keys[] | select(.role == "rat")] | length' "$json")

# keys are never deleted from the database: fewer than in the last backup means something is wrong there
prev=$(find "$dir" -maxdepth 1 -name 'rat-keys-*.json' -type f 2>/dev/null | sort | tail -1)
if [ -n "$prev" ]; then
  had=$(jq '.keys | length' "$prev" 2>/dev/null || echo 0)
  [ "$keys" -ge "$had" ] || die "the database holds $keys keys, the last backup ($prev) has $had." \
    "Keys are never deleted: check the database before anything else. Nothing was saved."
fi

name="rat-keys-$(date -u +%Y%m%d-%H%M%S).json"
(umask 077 && cp "$json" "$dir/.$name.tmp")
mv "$dir/.$name.tmp" "$dir/$name"
chmod 600 "$dir/$name"
printf 'OK saved %s keys (%s rat wallets, 1 creator), still encrypted, to %s\n' "$keys" "$rats" "$dir/$name"
printf '   Keep this folder and KEY_ENCRYPTION_KEY in two different safe places.\n'
