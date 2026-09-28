# @rat/cli

Operator CLI. Owned by WS08. Run with `pnpm --filter @rat/cli rat <command>` (reads the same env as the worker).

| Command | What |
|---|---|
| `status` | mode, kill switch, hire budget, cap usage, rat keys, rats, loops |
| `preflight [--live]` | one PASS / WARN / FAIL line per launch check: settings, database, RPC (and backup), Jupiter key, creator key, wallet reserve, coin mint, approved stocks + mint check, watch floor, kill switch, caps, Telegram, worker loops. Read-only. Exit code 1 if anything FAILs. `--live` = checking for a live start (DRY RUN still on, no watch floor, kill switch on or no Telegram become FAIL). |
| `kill [--reason]` / `resume` | database kill switch |
| `keys import --role creator` | reads the creator's private key from stdin (never argv), must match `CREATOR_PUBKEY`, stored encrypted |
| `keys backup --out <file> [--force]` | writes every stored key (rat wallets, creator) to a file, still encrypted; checks every key decrypts first; file is 0600 and never overwritten by accident. The rat wallets' keys exist nowhere else. |
| `keys restore --in <file>` | puts keys from a backup back into the database (every key must decrypt with `KEY_ENCRYPTION_KEY`; existing keys are kept) |
| `ledger [--limit]` | balances, sums by reason, recent entries |
| `dry-run-reset --yes` | deletes all DRY RUN paper data, returns paper keys |
| `stocks-sync` | loads `config/stocks.json` into the database |
| `alert-test` | sends a test alert |
| `sweep --to <cold> [--confirm "<phrase>"]` | **emergency only**. Prints the plan; executes only with the exact phrase `SWEEP ALL RATS TO <cold>`. DRY RUN simulates. Never run by the bot. Refuses the bot's own wallets and program addresses as `<cold>`. Sweeps active, frozen and failed rats. |
