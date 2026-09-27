# Keys

Only one secret lives in the host env: `KEY_ENCRYPTION_KEY`. Every private key is stored AES-256-GCM encrypted in the database. **Back up the master key** (password manager). Losing it means losing every rat wallet.

## Import the creator and fund keys
`CREATOR_PUBKEY` and `FUND_PUBKEY` must be set first; the import refuses a key that does not match.
```
rat keys import --role creator   # paste the private key (base58 or JSON array), then Ctrl-D
rat keys import --role fund
```
The key is read from stdin, never from the command line, and never printed.

## Fill the rat key pool (addresses ending in RAT): pre-grind 10,000

**Why 10,000.** The launch simulation hires ~833 rats in the first hour, and the hire cap (30 SOL/h at 0.03 SOL) allows up to 1,000/h. The old built-in grinder makes ~180 keys/h, so 3,000 keys would run out in about 4 hours. 10,000 keys cover 10+ hours of peak hiring while the worker's `solana-keygen` grinder refills in the background.

Do this on a **clean machine you trust** (up to date, no remote access tools, no unknown browser extensions), the same machine you run the CLI from. The plaintext key files only ever live on a **RAM disk**, so nothing is written to your SSD.

1. Install the Solana CLI (Agave): see https://docs.anza.xyz/cli/install. Check with `solana-keygen --version`.
2. Make a RAM disk (64 MB is plenty for 10,000 files):
   ```
   # Linux
   sudo mkdir -p /mnt/ratkeys && sudo mount -t tmpfs -o size=64m,mode=0700,uid=$(id -u) tmpfs /mnt/ratkeys && cd /mnt/ratkeys
   # macOS
   diskutil erasevolume HFS+ ratkeys $(hdiutil attach -nomount ram://131072) && cd /Volumes/ratkeys
   ```
3. Measure your speed first (the suffix is case-sensitive: exactly `RAT`):
   ```
   time solana-keygen grind --ends-with RAT:20
   ```
   10,000 keys take about 500 times that. Leave it running; you can stop and restart any time, finished files stay.
4. Grind (use every core):
   ```
   solana-keygen grind --ends-with RAT:10000 --num-threads "$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
   ```
5. Import, with the production `DATABASE_URL` and `KEY_ENCRYPTION_KEY` set in this shell only:
   ```
   rat keys import-dir .      # checks each address ends in RAT, encrypts it, zero-overwrites and deletes the file
   rat keys pool              # should show 10,000+ available
   ls                         # must be empty; delete anything the import skipped
   ```
6. Destroy the RAM disk: `cd ~ && sudo umount /mnt/ratkeys` (Linux) or `cd ~ && diskutil eject /Volumes/ratkeys` (macOS). Its contents are gone for good.

If you ground on a normal disk by mistake: `rat keys import-dir` still overwrites each file with zeros before deleting it, but on SSDs and copy-on-write filesystems that is best effort. Treat those keys as exposed only to that machine; do not reuse the folder, and wipe it (`shred -u *.json` on Linux).

## The worker's own grinder (background refill)
- The Docker image ships `solana-keygen`. With `KEYPOOL_GRINDER=auto` the worker uses it (multi-threaded, `KEYPOOL_GRIND_THREADS=0` = CPU count minus one, at low CPU priority) and falls back to the slow built-in grinder when it is missing.
- It starts a batch of `KEYPOOL_REFILL_BATCH` keys in the background whenever fewer than `KEYPOOL_REFILL_BELOW` keys are left, until `KEYPOOL_TARGET`. It never blocks claims, hires or burns.
- Each key file is written to a private folder on `/dev/shm` (RAM), imported and shredded the moment `solana-keygen` reports it. `solana-keygen` gets no secrets (only the search path and a throwaway home folder).
- Alerts: `keypool_low` (fewer than `KEYPOOL_LOW_ALERT` keys), `keypool_runway` (the pool lasts less than `KEYPOOL_RUNWAY_ALERT_HOURS` at the current hire rate), `keypool_slow_grinder` (solana-keygen missing), `keypool_grinder_error`.
- Manual top-up from the CLI: `rat keys grind --count 500` (same grinder choice; `--grinder js` forces the built-in one). Check: `rat keys pool`, `rat status` (shows the runway at the current hire rate).

## Rotate the master key
1. Generate a new key. In the env set `KEY_ENCRYPTION_KEY_PREVIOUS=<old>`, `KEY_VERSION_PREVIOUS=<old version>`, `KEY_ENCRYPTION_KEY=<new>`, `KEY_VERSION=<old + 1>`.
2. `rat kill --reason "key rotation"`
3. `rat keys rotate`
4. Remove `KEY_ENCRYPTION_KEY_PREVIOUS` and `KEY_VERSION_PREVIOUS`, redeploy the worker, `rat resume`.
