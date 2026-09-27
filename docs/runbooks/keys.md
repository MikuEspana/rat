# Keys

Only one secret lives in the host env: `KEY_ENCRYPTION_KEY`. Every private key is stored AES-256-GCM encrypted in the database. **Back up the master key** (password manager). Losing it means losing every rat wallet.

## Import the creator and fund keys
`CREATOR_PUBKEY` and `FUND_PUBKEY` must be set first; the import refuses a key that does not match.
```
rat keys import --role creator   # paste the private key (base58 or JSON array), then Ctrl-D
rat keys import --role fund
```
The key is read from stdin, never from the command line, and never printed.

## Fill the rat key pool (addresses ending in RAT)
The built-in grinder does ~11k tries/s on 2 threads (one `RAT` key every ~20s). For thousands of keys, pre-grind with the Solana CLI on a trusted machine (much faster), then import:
```
solana-keygen grind --ends-with RAT:3000     # writes <pubkey>.json files into the current folder
rat keys import-dir ./                       # verifies the suffix, encrypts, then overwrites and deletes each file
```
Small top-ups: `rat keys grind --count 50`. Check: `rat keys pool`. The worker alerts below `KEYPOOL_MIN` and grinds in the background.

## Rotate the master key
1. Generate a new key. In the env set `KEY_ENCRYPTION_KEY_PREVIOUS=<old>`, `KEY_VERSION_PREVIOUS=<old version>`, `KEY_ENCRYPTION_KEY=<new>`, `KEY_VERSION=<old + 1>`.
2. `rat kill --reason "key rotation"`
3. `rat keys rotate`
4. Remove `KEY_ENCRYPTION_KEY_PREVIOUS` and `KEY_VERSION_PREVIOUS`, redeploy the worker, `rat resume`.
