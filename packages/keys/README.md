# @rat/keys

Keys encrypted at rest. Owned by WS04.

- `vault.ts`: AES-256-GCM, random 12-byte IV, auth tag, public key bound as AAD. `MasterKeyRing` keeps old versions readable during a rotation.
- `grinder.ts`: vanity grinder on worker threads (native ed25519). Measured here: ~11k tries/s on 2 threads, so one `RAT` key (~195k tries) takes ~20s per 2 threads.
- `import-files.ts`: imports files from `solana-keygen grind --ends-with RAT:<n>` (Rust, much faster), verifies the suffix, encrypts, then overwrites and deletes each file.
- `keystore.ts`: `DbKeyStore` (creator, fund, rat signers from the encrypted `key_pool` table), `refillKeyPool`, `storeRatKeys`, `encryptRoleKey`.
- `secret-input.ts`: parses base58 or JSON-array secret keys (wallet exports, solana-keygen files).

The only secret in env is `KEY_ENCRYPTION_KEY`. Creator and fund keys are imported with the CLI and must match `CREATOR_PUBKEY` / `FUND_PUBKEY`.
