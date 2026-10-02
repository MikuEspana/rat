#!/bin/sh
# Nightly offsite backup of the bot's database. Runs as a Railway cron service (infra/railway.backup.json; the
# schedule, 30 3 * * * = 03:30 UTC, is set in the service settings, see docs/runbooks/backup-restore.md):
#
#   pg_dump (custom format) -> check the archive -> encrypt with age to the owner's PUBLIC key(s)
#   -> upload to an S3-compatible bucket outside Railway (Backblaze B2, Cloudflare R2, AWS S3) -> exit
#
# Any failure sends a Telegram alert and exits non-zero. Nothing readable leaves the container: the dump is
# encrypted before the upload and the private key never comes near Railway.
# The job never deletes anything: retention is a lifecycle rule on the bucket, so the upload key can be write-only.
# Railway skips a run while the previous one is still going, so every step has a time limit.
#
# Variables (docs/runbooks/backup-restore.md):
#   DATABASE_URL                  ${{Postgres.DATABASE_URL}} (private network, no password copied)
#   BACKUP_AGE_RECIPIENT          age public key(s), space separated (age1...)
#   BACKUP_S3_ENDPOINT            https://s3.us-west-004.backblazeb2.com, https://<account>.r2.cloudflarestorage.com, ...
#   BACKUP_S3_BUCKET              bucket name
#   BACKUP_S3_ACCESS_KEY_ID       write-only key if the provider has one
#   BACKUP_S3_SECRET_ACCESS_KEY
#   BACKUP_S3_REGION              us-west-004 (B2), auto (R2, the default), us-east-1 (AWS) ...
#   BACKUP_S3_PREFIX              folder in the bucket (default rat/)
#   TELEGRAM_BOT_TOKEN            ${{worker.TELEGRAM_BOT_TOKEN}}
#   TELEGRAM_CHAT_ID              ${{worker.TELEGRAM_CHAT_ID}}
#   BACKUP_HEARTBEAT_URL          optional: pinged after every good backup (alerts you if a night is missed)
set -eu

: "${BACKUP_S3_REGION:=auto}"
: "${BACKUP_S3_PREFIX:=rat/}"
: "${BACKUP_DUMP_TIMEOUT_SEC:=1800}"
: "${TELEGRAM_API_BASE:=https://api.telegram.org}"
# tables that must be in every dump: the money (ledger, claims, attempts), the rats and their encrypted keys
: "${BACKUP_REQUIRED_TABLES:=settings stocks rats key_pool ledger_entries claims tx_attempts}"
WORK="${BACKUP_WORK_DIR:-/tmp/rat-backup}"
STEP=setup
DETAIL=''

alert() {
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "backup: cannot send the alert: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set" >&2
    return 1
  fi
  code=$(curl -sS -m 20 --retry 2 -o /dev/null -w '%{http_code}' "$TELEGRAM_API_BASE/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
    --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" --data-urlencode "text=$1" --data-urlencode 'disable_web_page_preview=true') || code=000
  [ "$code" = 200 ] || { echo "backup: the Telegram alert failed (HTTP $code)" >&2; return 1; }
}

finish() {
  rc=$?
  rm -rf "$WORK"
  if [ "$rc" -ne 0 ]; then
    msg="[INUVESTOR !!! critical] backup_failed: the nightly database backup failed at step '$STEP'. No new offsite copy until it is fixed. Check the backup service logs on Railway."
    [ -n "$DETAIL" ] && msg="$msg Detail: $DETAIL"
    echo "backup: FAILED at step '$STEP'${DETAIL:+: $DETAIL}" >&2
    alert "$msg" || true
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT TERM

fail() {
  # keep alerts short and one line; error texts never carry the database password or the S3 secret
  DETAIL=$(printf '%s' "$1" | tr '\n\r' '  ' | cut -c1-400)
  exit 1
}

for v in DATABASE_URL BACKUP_AGE_RECIPIENT BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || fail "$v is not set"
done
set --
for r in $BACKUP_AGE_RECIPIENT; do
  case "$r" in age1*) set -- "$@" -r "$r" ;; *) fail "BACKUP_AGE_RECIPIENT must hold age public keys (age1...), never a private key" ;; esac
done
rm -rf "$WORK"
mkdir -p "$WORK"
chmod 700 "$WORK"
export PGCONNECT_TIMEOUT=20
started=$(date +%s)

# pg_dump must be at least the server's major version, or it refuses to dump
STEP=check_versions
out=$(psql "$DATABASE_URL" -XAtqc 'show server_version_num' 2>&1) || fail "cannot connect to the database: $out"
server_major=$((out / 10000))
client_major=$(pg_dump --version | sed 's/^[^0-9]*\([0-9][0-9]*\).*/\1/')
[ "$server_major" -le "$client_major" ] ||
  fail "the database runs Postgres $server_major but pg_dump is $client_major: change infra/backup/Dockerfile to postgres:$server_major-alpine"

STEP=dump
name="rat-$(date -u +%Y%m%d-%H%M%S).dump"
dump="$WORK/$name"
out=$(timeout "$BACKUP_DUMP_TIMEOUT_SEC" pg_dump --format=custom --compress=6 --file="$dump" "$DATABASE_URL" 2>&1) ||
  fail "pg_dump failed or took longer than ${BACKUP_DUMP_TIMEOUT_SEC}s: $out"

# the archive must be readable and hold every money table
STEP=check_dump
pg_restore --list "$dump" >"$WORK/toc" 2>&1 || fail "pg_restore cannot read the dump: $(tail -c 300 "$WORK/toc")"
for t in $BACKUP_REQUIRED_TABLES; do
  grep -q " TABLE DATA public $t " "$WORK/toc" || fail "table $t is missing from the dump"
done
dump_bytes=$(wc -c <"$dump" | tr -d ' ')

STEP=encrypt
out=$(age "$@" -o "$dump.age" "$dump" 2>&1) || fail "age: $out"
rm -f "$dump"
file="$dump.age"
bytes=$(wc -c <"$file" | tr -d ' ')

# One signed PUT. x-amz-content-sha256 carries the file's real hash, so the store rejects a corrupted upload;
# the ETag (MD5 for a single PUT) is checked too. The key and secret go in a curl config file, never on argv.
STEP=upload
key="${BACKUP_S3_PREFIX}${name}.age"
url="${BACKUP_S3_ENDPOINT%/}/$BACKUP_S3_BUCKET/$key"
sha=$(sha256sum "$file" | cut -d' ' -f1)
md5=$(md5sum "$file" | cut -d' ' -f1)
umask 077
printf 'user = "%s:%s"\n' "$BACKUP_S3_ACCESS_KEY_ID" "$BACKUP_S3_SECRET_ACCESS_KEY" >"$WORK/curl.cfg"
code=$(curl -sS -m 900 --retry 3 --retry-all-errors -K "$WORK/curl.cfg" --aws-sigv4 "aws:amz:$BACKUP_S3_REGION:s3" \
  -H "x-amz-content-sha256: $sha" -H 'content-type: application/octet-stream' \
  -T "$file" -D "$WORK/put.headers" -o "$WORK/put.body" -w '%{http_code}' "$url" 2>"$WORK/put.err") || code=000
rm -f "$WORK/curl.cfg"
[ "$code" = 200 ] || fail "upload of $key got HTTP $code: $(cat "$WORK/put.err" 2>/dev/null) $(head -c 300 "$WORK/put.body" 2>/dev/null)"
etag=$(grep -i '^etag:' "$WORK/put.headers" | head -1 | cut -d: -f2- | tr -d ' "\r')
if printf '%s' "$etag" | grep -Eq '^[0-9a-f]{32}$'; then
  [ "$etag" = "$md5" ] || fail "the store's checksum for $key does not match the file (etag $etag, md5 $md5)"
else
  echo "backup: no MD5 ETag from the store, relying on the signed SHA-256"
fi

STEP=heartbeat
if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
  curl -fsS -m 15 --retry 3 -o /dev/null "$BACKUP_HEARTBEAT_URL" || echo "backup: heartbeat ping failed (the backup itself is fine)" >&2
fi

STEP=finished
echo "backup: ok $key ($bytes bytes encrypted, dump $dump_bytes bytes, Postgres $server_major, $(($(date +%s) - started))s)"
