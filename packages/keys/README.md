# @rat/keys

Keys encrypted at rest.

- `vault.ts`: AES-256-GCM, random 12-byte IV, auth tag, public key bound as AAD. `MasterKeyRing` keeps old versions readable during a rotation.
- `keystore.ts`: `DbKeyStore`: creator, fund and rat signers from the encrypted key table. `newRatKey()` makes a fresh keypair at hire time, encrypts it, stores it and reads it back before returning its public key, so a wallet's key always exists before any SOL is sent to it. Rat keys are never reused. `encryptRoleKey` for imported creator/fund keys.
- `secret-input.ts`: parses base58 or JSON-array secret keys (wallet exports).

The only secret in env is `KEY_ENCRYPTION_KEY`. Creator and fund keys are imported with the CLI and must match `CREATOR_PUBKEY` / `FUND_PUBKEY`.
