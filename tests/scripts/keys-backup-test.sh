#!/bin/bash
# scripts/keys-backup.sh against a fake `rat` (no Railway, no database): the backup that `rat keys backup --out -`
# prints inside the worker lands on the Mac, complete, private (0700 folder, 0600 file), never half written.
# Run: bash tests/scripts/keys-backup-test.sh
# shellcheck disable=SC2016,SC2034 # each check is a string evaluated later (check), rc and f are read there
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
fails=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
mkdir -p "$W/bin" "$W/home" "$W/repo/scripts"
cp "$REPO/scripts/keys-backup.sh" "$W/repo/scripts/"
key() { printf '{"pubkey":"%s","secretEnc":"enc","keyVersion":1,"role":"%s"}' "$1" "$2"; }
backup() { # backup <rat count>: the JSON line `rat keys backup --out -` prints
  local keys i
  keys=$(key C creator)
  for ((i = 0; i < $1; i++)); do keys="$keys,$(key "R$i" rat)"; done
  printf '{"format":"rat-race-keys-v1","createdAt":"2026-10-01T12:00:00Z","keys":[%s]}' "$keys"
}
# the fake rat prints what scripts/rat.sh brings back from railway ssh: noise, CRLF line ends, the markers
cat >"$W/bin/fake-rat" <<'EOF'
#!/bin/bash
[ "$*" = "keys backup --out -" ] || { echo "unexpected: $*" >&2; exit 2; }
[ -f "$FAKE_DIR/fail" ] && { echo "rat: database unreachable" >&2; exit 1; }
printf 'Welcome to railway ssh\r\n'
[ -f "$FAKE_DIR/nomarkers" ] || printf -- '-----BEGIN RAT KEY BACKUP-----\r\n'
cat "$FAKE_DIR/backup.json"; printf '\r\n'
[ -f "$FAKE_DIR/nomarkers" ] || printf -- '-----END RAT KEY BACKUP-----\r\n'
EOF
chmod +x "$W/bin/fake-rat"
run() { env -i PATH="$W/bin:/usr/bin:/bin" HOME="$W/home" FAKE_DIR="$W" WSR_RAT=fake-rat bash "$W/repo/scripts/keys-backup.sh" >"$W/out.txt" 2>&1; }
saved() { find "$W/home/wallstreetrats-key-backups/repo" -name 'rat-keys-*.json' -type f 2>/dev/null | wc -l | tr -d ' '; }
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

echo "== a backup lands on the Mac"
backup 3 >"$W/backup.json"
run; rc=$?
f=$(find "$W/home/wallstreetrats-key-backups/repo" -name 'rat-keys-*.json' -type f | head -1)
check "saved, with the count" '[ $rc = 0 ] && grep -q "OK saved 4 keys (3 rat wallets, 1 creator)" "$W/out.txt" && [ "$(saved)" = 1 ]'
check "exactly the backup JSON (no noise, no carriage returns)" 'jq -e ".keys | length == 4" "$f" >/dev/null && ! grep -q $'"'"'\r'"'"' "$f" && ! grep -q railway "$f"'
check "private: folder 0700, file 0600" '[ "$(mode "$W/home/wallstreetrats-key-backups/repo")" = 700 ] && [ "$(mode "$f")" = 600 ]'

echo "== nothing is saved when the answer is wrong"
touch "$W/fail"
run; rc=$?
check "the command failed: stop, nothing saved" '[ $rc = 1 ] && grep -q "backup command failed" "$W/out.txt" && [ "$(saved)" = 1 ]'
rm -f "$W/fail"
touch "$W/nomarkers"
run; rc=$?
check "no markers (not a backup): stop, nothing saved" '[ $rc = 1 ] && grep -q "not a complete key backup" "$W/out.txt" && [ "$(saved)" = 1 ]'
rm -f "$W/nomarkers"
printf '{"format":"rat-race-keys-v1","keys":[' >"$W/backup.json"
run; rc=$?
check "cut off mid-way: stop, nothing saved" '[ $rc = 1 ] && [ "$(saved)" = 1 ]'
backup 1 >"$W/backup.json"
run; rc=$?
check "fewer keys than the last backup: stop, nothing saved" '[ $rc = 1 ] && grep -q "last backup .* has 4" "$W/out.txt" && [ "$(saved)" = 1 ]'
sleep 1
backup 5 >"$W/backup.json"
run; rc=$?
check "more keys: a second file, the first one kept" '[ $rc = 0 ] && [ "$(saved)" = 2 ]'

echo "keys-backup-test: $fails failed"
[ "$fails" = 0 ]
