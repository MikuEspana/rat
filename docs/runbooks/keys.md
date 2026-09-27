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

**Why 10,000.** The launch simulation hires ~833 rats in the first hour, and the hire cap (30 SOL/h at 0.03 SOL) allows up to 1,000/h. 3,000 keys would run out in about 4 hours. 10,000 keys cover 10+ hours of peak hiring while the worker keeps refilling in the background.

**Measured speed** (CI, GitHub Actions runner, per CPU thread, suffix `RAT`):

| Grinder | RAT keys per hour per thread |
|---|---|
| built-in (`rat keys grind`) | ~213 |
| `solana-keygen grind --ends-with RAT` | ~65 |

`solana-keygen` is slower here because, when no prefix is given, it skips every address that is 44 characters long (about 94% of all keys), so every key it finds is 43 characters and it needs ~17x more tries per match (Agave source: `keygen/src/keygen.rs`, `skip_len_44_pubkeys`). With 8 threads the built-in grinder makes ~1,700 keys/h on similar hardware, so 10,000 keys take roughly 6 hours. Your laptop may be faster; the command prints its rate.

Do this on a **clean machine you trust** (up to date, no remote access tools, no unknown browser extensions), with the production `DATABASE_URL` and `KEY_ENCRYPTION_KEY` set in that shell only.

### Recommended: grind straight into the encrypted pool (no plaintext files at all)
```
rat keys grind --count 10000 --threads "$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
rat keys pool
```
Keys go from memory to the database encrypted, in batches of 250; nothing is written to disk in plaintext, so there is nothing to delete. You can stop it (Ctrl-C) and run it again: finished batches stay stored.

### Alternative: solana-keygen files on a RAM disk
1. Install the Solana CLI (Agave): see https://docs.anza.xyz/cli/install. Check with `solana-keygen --version`.
2. Make a RAM disk (64 MB is plenty), so plaintext files never reach your SSD:
   ```
   # Linux
   sudo mkdir -p /mnt/ratkeys && sudo mount -t tmpfs -o size=64m,mode=0700,uid=$(id -u) tmpfs /mnt/ratkeys && cd /mnt/ratkeys
   # macOS
   diskutil erasevolume HFS+ ratkeys $(hdiutil attach -nomount ram://131072) && cd /Volumes/ratkeys
   ```
3. Grind (case-sensitive, exactly `RAT`): `solana-keygen grind --ends-with RAT:10000 --num-threads "$(nproc 2>/dev/null || sysctl -n hw.ncpu)"`
4. Import: `rat keys import-dir .` (checks each address ends in RAT, encrypts it, zero-overwrites and deletes the file), then `rat keys pool`, and `ls` must show nothing (delete anything the import skipped).
5. Destroy the RAM disk: `cd ~ && sudo umount /mnt/ratkeys` (Linux) or `cd ~ && diskutil eject /Volumes/ratkeys` (macOS). Its contents are gone for good.

If key files ever land on a normal disk: `rat keys import-dir` still overwrites each file with zeros before deleting it, but on SSDs and copy-on-write filesystems that is best effort. Wipe the folder (`shred -u *.json` on Linux) and do not reuse that machine for anything untrusted.

## The worker's own grinder (background refill)
- `KEYPOOL_GRINDER=auto` (default) uses the built-in grinder: `KEYPOOL_GRIND_THREADS=0` means CPU count minus one, at most 4, each thread at low CPU priority so claims, hires and burns stay responsive. `KEYPOOL_GRINDER=solana-keygen` uses the `solana-keygen` in the Docker image instead (falls back to the built-in one if it is missing); `off` disables it.
- It starts a batch of `KEYPOOL_REFILL_BATCH` keys in the background whenever fewer than `KEYPOOL_REFILL_BELOW` keys are left, until `KEYPOOL_TARGET`. It never blocks the bot loop.
- With solana-keygen, each key file lives in a private folder on `/dev/shm` (RAM) only until it is reported: then it is imported and shredded. `solana-keygen` gets no secrets (only the search path and a throwaway home folder).
- Alerts: `keypool_low` (fewer than `KEYPOOL_LOW_ALERT` keys), `keypool_runway` (the pool lasts less than `KEYPOOL_RUNWAY_ALERT_HOURS` at the current hire rate), `keypool_grinder_error`, `keypool_keygen_missing`.
- Check: `rat keys pool`, `rat status` (shows the runway at the current hire rate). To re-measure both grinders on any machine: `pnpm --filter @rat/keys check:keygen` (throwaway keys, in-memory database).

## Rotate the master key
1. Generate a new key. In the env set `KEY_ENCRYPTION_KEY_PREVIOUS=<old>`, `KEY_VERSION_PREVIOUS=<old version>`, `KEY_ENCRYPTION_KEY=<new>`, `KEY_VERSION=<old + 1>`.
2. `rat kill --reason "key rotation"`
3. `rat keys rotate`
4. Remove `KEY_ENCRYPTION_KEY_PREVIOUS` and `KEY_VERSION_PREVIOUS`, redeploy the worker, `rat resume`.
