# @rat/cli

Operator CLI. Owned by WS08. Run with `pnpm --filter @rat/cli rat <command>` (reads the same env as the worker).

| Command | What |
|---|---|
| `status` | mode, kill switch, bucket balances, cap usage, fund share owed, rat keys, rats, loops |
| `kill [--reason]` / `resume` | database kill switch |
| `keys import --role creator\|fund` | reads the private key from stdin (never argv), must match `CREATOR_PUBKEY` / `FUND_PUBKEY`, stored encrypted |
| `ledger [--limit]` | balances, sums by reason, recent entries |
| `dry-run-reset --yes` | deletes all DRY RUN paper data, returns paper keys |
| `stocks-sync` | loads `config/stocks.json` into the database |
| `alert-test` | sends a test alert |
| `sweep --to <cold> [--confirm "<phrase>"]` | **emergency only**. Prints the plan; executes only with the exact phrase `SWEEP ALL RATS TO <cold>`. DRY RUN simulates. Never run by the bot. Refuses the bot's own wallets and program addresses as `<cold>`. Sweeps active, frozen and failed rats. |
