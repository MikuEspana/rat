# Backup and restore

The database is the source of truth: rats, the ledger, encrypted keys, attempts.

## Backups
- Supabase daily backups on (Project > Database > Backups). Point-in-time recovery if your plan has it.
- Before launch and before any risky change: a manual dump
  ```
  pg_dump "$DATABASE_URL" --format=custom --file=rat-$(date +%Y%m%d-%H%M).dump
  ```
  The dump contains encrypted keys: keep it private. It is useless without `KEY_ENCRYPTION_KEY`, and the master key is useless without it.

## Restore
1. `rat kill --reason restore` (or `KILL_SWITCH=true`) and stop the worker service.
2. `pg_restore --clean --if-exists --dbname="$DATABASE_URL" rat-YYYYMMDD-HHMM.dump`
3. Start the worker. On start it re-checks every in-flight attempt by signature (nothing is double sent: a rat is never retried while an attempt can land, and the rat wallet is read on-chain before any retry).
4. `rat status`, then `rat resume`.

Transactions that landed after the backup are picked up by the wallet watch (signatures on the creator wallet) and the hire/claim reconciliation.
