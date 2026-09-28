# Keys

Only one secret lives in the host env: `KEY_ENCRYPTION_KEY`. Every private key is stored AES-256-GCM encrypted in the database. **Back up the master key** (password manager). Losing it means losing every rat wallet.

## Import the creator key
`CREATOR_PUBKEY` must be set first; the import refuses a key that does not match. There is no fund wallet (buy and burn was removed).
```
rat keys import --role creator   # paste the private key (base58 or JSON array), then Ctrl-D
```
The key is read from stdin, never from the command line, and never printed.

## Rat wallets (nothing to prepare)
Every rat gets a brand new wallet at hire time: a fresh keypair is generated, encrypted with the master key, stored in the database and read back (decrypted) **before** its address is used. Only then is the hire transaction built and sent, so a crash right after sending can never lose the key of a funded wallet. Rat keys are never reused: a hire abandoned before any transaction retires its key.

There is no key pool to fill and no grinding. `rat status` shows how many rat keys are stored.

## Rotate the master key
1. Generate a new key. In the env set `KEY_ENCRYPTION_KEY_PREVIOUS=<old>`, `KEY_VERSION_PREVIOUS=<old version>`, `KEY_ENCRYPTION_KEY=<new>`, `KEY_VERSION=<old + 1>`.
2. `rat kill --reason "key rotation"`
3. `rat keys rotate`
4. Remove `KEY_ENCRYPTION_KEY_PREVIOUS` and `KEY_VERSION_PREVIOUS`, redeploy the worker, `rat resume`.
