#!/bin/sh
# End-to-end test of the backup loop, on this machine, with nothing real:
#   a Postgres database filled with a simulated launch -> backup.sh -> an S3 server that checks request signatures
#   (moto) -> download -> restore-check.sh into an empty database -> every table compared row count by row count.
# Then the failure paths: a wrong S3 secret, an unreachable database and a private key given as the recipient must
# each send exactly one Telegram alert (to a local fake) that names the step and leaks no secret; restore-check must
# refuse a database that already has tables.
#
#   SELFTEST_PG_URL=postgres://postgres:pw@localhost:5432/postgres infra/backup/selftest.sh
#
# Needs psql, pg_dump, pg_restore, age, age-keygen, curl, pnpm (repo installed) and python3 with moto[server].
# SELFTEST_SH picks the shell that runs backup.sh and SELFTEST_BACKUP_PATH puts tools first on its PATH (busybox sh and
# busybox applets match the Alpine image). Used by CI.
set -eu

: "${SELFTEST_PG_URL:?set SELFTEST_PG_URL to a Postgres server URL that can create databases}"
: "${SELFTEST_SH:=sh}"
: "${SELFTEST_PYTHON:=python3}"
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
S3_PORT=${SELFTEST_S3_PORT:-59000}
TG_PORT=${SELFTEST_TG_PORT:-59001}
pids=''
cleanup() {
  for p in $pids; do kill "$p" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }
die() { printf 'SELFTEST FAIL: %s\n' "$*" >&2; exit 1; }
db_url() { printf '%s' "$SELFTEST_PG_URL" | sed "s#/[^/?]*\(?.*\)\{0,1\}\$#/$1\1#"; }
SRC=$(db_url rat_selftest_src)
DRILL=$(db_url rat_selftest_drill)
psql "$SELFTEST_PG_URL" -XAtq -c 'drop database if exists rat_selftest_src' -c 'drop database if exists rat_selftest_drill' \
  -c 'create database rat_selftest_src' -c 'create database rat_selftest_drill'

say "seed: a simulated launch into a real Postgres database"
(cd "$repo" && pnpm --silent --filter @rat/tests exec tsx backup/seed.ts "$SRC") | tail -1

say "an S3 server that checks signatures, and a fake Telegram"
INITIAL_NO_AUTH_ACTION_COUNT=4 "$SELFTEST_PYTHON" -m moto.server -p "$S3_PORT" >"$work/moto.log" 2>&1 &
pids="$pids $!"
cat >"$work/tg.py" <<'PY'
import http.server, sys, urllib.parse
log = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        form = urllib.parse.parse_qs(self.rfile.read(int(self.headers.get('content-length', 0))).decode())
        with open(log, 'a') as f: f.write(f"{self.path}\tchat={form['chat_id'][0]}\t{form['text'][0]}\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
"$SELFTEST_PYTHON" "$work/tg.py" "$TG_PORT" "$work/telegram.log" &
pids="$pids $!"
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$S3_PORT/moto-api/" && break; sleep 0.2; done
# setup calls (unauthenticated, the first 4): a user with a key that may only put and get, and the bucket
"$SELFTEST_PYTHON" - "$S3_PORT" >"$work/creds" <<'PY'
import boto3, json, sys
ep = f'http://127.0.0.1:{sys.argv[1]}'
kw = dict(endpoint_url=ep, region_name='us-east-1', aws_access_key_id='setup', aws_secret_access_key='setup')
iam = boto3.client('iam', **kw)
iam.create_user(UserName='backup')
k = iam.create_access_key(UserName='backup')['AccessKey']
iam.put_user_policy(UserName='backup', PolicyName='rw', PolicyDocument=json.dumps({'Version': '2012-10-17', 'Statement': [
    {'Effect': 'Allow', 'Action': ['s3:PutObject', 's3:GetObject'], 'Resource': '*'}]}))
boto3.client('s3', **kw).create_bucket(Bucket='rat-backups')
print(k['AccessKeyId'], k['SecretAccessKey'])
PY
read -r KEY_ID SECRET <"$work/creds"
age-keygen -o "$work/owner.key" 2>/dev/null
RECIPIENT=$(age-keygen -y "$work/owner.key")

run_backup() {
  env -i PATH="${SELFTEST_BACKUP_PATH:+$SELFTEST_BACKUP_PATH:}$PATH" HOME="$work" \
    DATABASE_URL="$SRC" BACKUP_AGE_RECIPIENT="$RECIPIENT" \
    BACKUP_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" BACKUP_S3_BUCKET=rat-backups BACKUP_S3_REGION=us-east-1 \
    BACKUP_S3_ACCESS_KEY_ID="$KEY_ID" BACKUP_S3_SECRET_ACCESS_KEY="$SECRET" \
    TELEGRAM_BOT_TOKEN=123:selftest-token TELEGRAM_CHAT_ID=42 TELEGRAM_API_BASE="http://127.0.0.1:$TG_PORT" \
    BACKUP_WORK_DIR="$work/job" "$@" "$SELFTEST_SH" "$here/backup.sh"
}

say "1. backup (happy path)"
run_backup >"$work/out" 2>&1 || { cat "$work/out"; die "backup.sh failed"; }
cat "$work/out"
[ ! -s "$work/telegram.log" ] || die "a good backup sent a Telegram message"
object=$(sed -n 's/^backup: ok \([^ ]*\) .*/\1/p' "$work/out")
[ -n "$object" ] || die "backup.sh did not report the object"

say "2. download it again (signed GET) and restore it into an empty database"
printf 'user = "%s:%s"\n' "$KEY_ID" "$SECRET" >"$work/curl.cfg"
curl -fsS -K "$work/curl.cfg" --aws-sigv4 'aws:amz:us-east-1:s3' -o "$work/$(basename "$object")" \
  "http://127.0.0.1:$S3_PORT/rat-backups/$object"
[ "$(head -c 21 "$work/$(basename "$object")")" = 'age-encryption.org/v1' ] || die "the uploaded file is not age encrypted"
"$here/restore-check.sh" "$work/$(basename "$object")" "$work/owner.key" "$DRILL"

say "3. every table has the same rows as the source"
tables=$(psql "$SRC" -XAtqc "select table_schema || '.' || table_name from information_schema.tables where table_schema in ('public', 'drizzle') order by 1")
for t in $tables; do
  a=$(psql "$SRC" -XAtqc "select count(*) from $t")
  b=$(psql "$DRILL" -XAtqc "select count(*) from $t")
  printf '   %-34s %6s %6s\n' "$t" "$a" "$b"
  [ "$a" = "$b" ] || die "$t: $a rows in the source, $b restored"
done
a=$(psql "$SRC" -XAtqc 'select md5(string_agg(t::text, $$|$$ order by id)) from ledger_entries t')
b=$(psql "$DRILL" -XAtqc 'select md5(string_agg(t::text, $$|$$ order by id)) from ledger_entries t')
[ "$a" = "$b" ] || die "the ledger's contents differ after the restore"
echo "   ledger contents identical (md5 $a)"

say "4. restore-check refuses a database that already has tables"
if "$here/restore-check.sh" "$work/$(basename "$object")" "$work/owner.key" "$DRILL" >"$work/out" 2>&1; then die "restore-check restored over a non-empty database"; fi
grep -q 'already has' "$work/out" || die "unexpected refusal: $(cat "$work/out")"
echo "   refused: $(grep FAIL "$work/out")"

expect_alert() {
  # $1 = step the alert must name; the rest of the checks: one message, to the right chat, no secret in it
  [ "$(wc -l <"$work/telegram.log" | tr -d ' ')" = 1 ] || die "expected exactly one Telegram message, got: $(cat "$work/telegram.log")"
  grep -q '^/bot123:selftest-token/sendMessage	chat=42	' "$work/telegram.log" || die "the alert went to the wrong place"
  grep -q 'backup_failed' "$work/telegram.log" || die "the alert does not say backup_failed"
  grep -q "$1" "$work/telegram.log" || die "the alert does not name the step $1: $(cat "$work/telegram.log")"
  # the message text only (the path carries the bot token by design)
  for s in "$SECRET" "$(printf '%s' "$SELFTEST_PG_URL" | sed -n 's#.*://[^:]*:\([^@]*\)@.*#\1#p')"; do
    [ -z "$s" ] || ! cut -f3 "$work/telegram.log" | grep -qF "$s" || die "the alert leaks a secret"
  done
  echo "   alert: $(cut -f3 "$work/telegram.log")"
  : >"$work/telegram.log"
}

say "5. a wrong S3 secret: the upload is refused, one alert"
: >"$work/telegram.log"
if run_backup BACKUP_S3_SECRET_ACCESS_KEY=wrong-secret >"$work/out" 2>&1; then die "backup.sh succeeded with a wrong secret"; fi
expect_alert "'upload'"

say "6. the database is down: one alert"
if run_backup DATABASE_URL="$(printf '%s' "$SRC" | sed 's#@[^/]*/#@127.0.0.1:1/#')" >"$work/out" 2>&1; then die "backup.sh succeeded without a database"; fi
expect_alert "'check_versions'"

say "7. a private key pasted as the recipient is refused before anything runs"
if run_backup BACKUP_AGE_RECIPIENT="$(grep AGE-SECRET-KEY "$work/owner.key")" >"$work/out" 2>&1; then die "backup.sh took a private key"; fi
expect_alert "never a private key"

psql "$SELFTEST_PG_URL" -XAtq -c 'drop database rat_selftest_src' -c 'drop database rat_selftest_drill'
printf '\nSELFTEST PASS\n'
