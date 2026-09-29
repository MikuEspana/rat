#!/bin/sh
# Restore drill: decrypt one backup, restore it into an EMPTY scratch database and check it.
# Never points at production: it refuses any database that already has tables.
#
#   infra/backup/restore-check.sh <rat-YYYYMMDD-HHMMSS.dump.age> <age identity file> <scratch database URL>
#
# Needs psql, pg_restore (same major as the backup, or newer) and age. A scratch database on your machine:
#   docker run -d --name rat-drill -e POSTGRES_PASSWORD=drill -p 55432:5432 postgres:18
#   infra/backup/restore-check.sh rat-20261001-033000.dump.age ~/rat-backup.key postgres://postgres:drill@localhost:55432/postgres
# It prints PASS or FAIL, the restore time and how old the backup was. See docs/runbooks/backup-restore.md.
set -eu

[ $# -eq 3 ] || { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
backup=$1
identity=$2
target=$3
: "${RESTORE_REQUIRED_TABLES:=settings stocks rats key_pool ledger_entries claims tx_attempts}"
here=$(cd "$(dirname "$0")" && pwd)
journal="$here/../../packages/db/migrations/meta/_journal.json"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

say() { printf '%s\n' "$*"; }
fail() { say "FAIL: $*"; exit 1; }
q() { psql "$target" -XAtqc "$1"; }

[ -f "$backup" ] || fail "no such backup file: $backup"
[ -f "$identity" ] || fail "no such age identity file: $identity"

say "1. target is an empty scratch database"
tables=$(q "select count(*) from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')") ||
  fail "cannot connect to the scratch database"
[ "$tables" = 0 ] || fail "the target database already has $tables tables. Use an empty scratch database, never production."

say "2. decrypt"
age -d -i "$identity" -o "$work/backup.dump" "$backup" || fail "age could not decrypt the backup (wrong identity file?)"

say "3. read the archive"
pg_restore --list "$work/backup.dump" >"$work/toc" || fail "pg_restore cannot read the archive"
for t in $RESTORE_REQUIRED_TABLES; do
  grep -q " TABLE DATA public $t " "$work/toc" || fail "table $t is missing from the archive"
done

say "4. restore"
t0=$(date +%s)
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$target" "$work/backup.dump" || fail "pg_restore stopped on an error"
restore_sec=$(($(date +%s) - t0))

say "5. check"
grep ' TABLE DATA ' "$work/toc" | awk '{print $6 "." $7}' | sort >"$work/tables"
missing=0
printf '   %-34s %s\n' table rows
while read -r st; do
  n=$(q "select count(*) from $st") || { say "   $st: MISSING"; missing=$((missing + 1)); continue; }
  printf '   %-34s %s\n' "$st" "$n"
done <"$work/tables"
[ "$missing" = 0 ] || fail "$missing tables did not come back"
applied=$(q 'select count(*) from drizzle.__drizzle_migrations') || fail "the migrations table did not come back"
if [ -f "$journal" ]; then
  expected=$(grep -c '"tag"' "$journal")
  [ "$applied" = "$expected" ] || fail "$applied migrations recorded, this checkout has $expected"
  say "   migrations: $applied of $expected"
else
  say "   migrations: $applied (no checkout next to this script to compare with)"
fi
newest=$(q "select coalesce(to_char(max(at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS \"UTC\"'), 'none') from ledger_entries")
say "   newest ledger entry: $newest"

stamp=$(basename "$backup" | sed -n 's/^rat-\([0-9]\{8\}\)-\([0-9]\{6\}\)\.dump\.age$/\1\2/p')
age_note=''
if [ -n "$stamp" ]; then
  taken=$(printf '%s' "$stamp" | sed 's/^\(....\)\(..\)\(..\)\(..\)\(..\)..$/\1-\2-\3 \4:\5/')
  age_note=", backup taken $taken UTC"
fi
say "PASS: restored in ${restore_sec}s${age_note}. The scratch database now holds the backup; delete it when done."
