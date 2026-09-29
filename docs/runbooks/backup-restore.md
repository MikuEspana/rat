# Backup and restore

The database is the source of truth: rats, the ledger, encrypted keys, attempts. It is Railway Postgres (`deploy.md` step 1).

| Layer | Where | Kept | Covers |
|---|---|---|---|
| Railway volume backups | inside Railway | Daily 6 days, Weekly 1 month | a bad deploy or a data mistake |
| Nightly encrypted dump (`infra/backup/`) | your bucket, outside Railway | your lifecycle rule (30 days suggested) | losing the Railway project, the volume or the account |

Every dump contains the rats' encrypted keys. It is encrypted again before it leaves Railway, and even decrypted it is useless without `KEY_ENCRYPTION_KEY` (and the master key is useless without it).

## Railway volume backups (one time)
Postgres service > **Backups**: turn on **Daily** and **Weekly**. Optional: **Enable PITR** (point-in-time recovery, about 4 weeks).

## Nightly encrypted offsite dump (one time)
Every night at 03:30 UTC a Railway cron service runs `infra/backup/backup.sh`:
1. `pg_dump` over the private network (custom format),
2. checks the archive can be read and holds every money table,
3. encrypts it with `age` to your public key (the private key never touches Railway),
4. uploads `rat/rat-YYYYMMDD-HHMMSS.dump.age` to your bucket in one signed request (the store checks its SHA-256),
5. exits.

Any failure sends one Telegram alert, `backup_failed`, naming the step (settings, database, dump, encrypt, upload) and leaking no secret. The job never deletes anything; old files go by the bucket's lifecycle rule.

### 1. Your encryption key (on your own machine)
```
age-keygen -o ~/rat-backup.key      # prints: Public key: age1...
```
- `~/rat-backup.key` is the **private** key: put it in your password manager and keep one offline copy. Without it nobody can read any backup, you included.
- Optional: a second key (a second person, or a key kept in a safe). Put both public keys in `BACKUP_AGE_RECIPIENT`, separated by a space; either one can decrypt.
- Only the public key (`age1...`) goes to Railway. The job refuses a private key.

### 2. A bucket outside Railway
Any S3-compatible store: Backblaze B2, Cloudflare R2, AWS S3.
- A **private** bucket, used for nothing else.
- A **lifecycle rule** that deletes files 30 days after upload.
- An access key **limited to this bucket**. If your provider can make a key that uploads but cannot delete, use that one.
- Its S3 endpoint and region are shown in the bucket details. Examples: B2 `https://s3.us-west-004.backblazeb2.com` and region `us-west-004`; R2 `https://<account id>.r2.cloudflarestorage.com` and region `auto`.

### 3. The Railway service
**+ New > GitHub Repo** (this repo), name it `backup`. Settings > Config file path: `infra/railway.backup.json` (its own image, `infra/backup/Dockerfile`, and no restarts: a failed night alerts and waits for the next one).

Variables (the first three are references, so no password is copied):
```
DATABASE_URL=${{Postgres.DATABASE_URL}}
TELEGRAM_BOT_TOKEN=${{worker.TELEGRAM_BOT_TOKEN}}
TELEGRAM_CHAT_ID=${{worker.TELEGRAM_CHAT_ID}}
BACKUP_AGE_RECIPIENT=age1...                  your public key(s)
BACKUP_S3_ENDPOINT=https://...                from the bucket details
BACKUP_S3_REGION=...                          auto for R2
BACKUP_S3_BUCKET=...
BACKUP_S3_ACCESS_KEY_ID=...                   [SECRET]
BACKUP_S3_SECRET_ACCESS_KEY=...               [SECRET]
BACKUP_HEARTBEAT_URL=                         optional, see "Missed nights"
```

Settings > **Cron Schedule**:
1. First `*/5 * * * *`: a run starts within 5 minutes. Check the logs end with `backup: ok rat/rat-...dump.age`, and that the file is in the bucket.
2. See one alert: set `BACKUP_S3_BUCKET` to a wrong name, wait for the next run, expect `backup_failed ... at step 'upload'` in Telegram. Put the right name back.
3. Then `30 3 * * *` (03:30 UTC every night).

If you ever upgrade the database past Postgres 16, change `infra/backup/Dockerfile` to the same major (`postgres:17-alpine`, ...). If you forget, the job alerts at step `check_versions`.

### Missed nights
The job alerts whenever it runs and fails. If it never starts at all (service removed, schedule cleared), nothing inside Railway can tell you. For that, optional: a free check at healthchecks.io (it has a Telegram integration) with a 1 day period, and its ping URL in `BACKUP_HEARTBEAT_URL`. The job pings it after every good backup; a missed day alerts you.

## Restore drill (once before launch, then monthly)
Proves the backups really restore, and times it. Nothing touches production.
1. Download the newest `rat/rat-YYYYMMDD-HHMMSS.dump.age` from the bucket's web console.
2. An empty scratch Postgres on your machine:
   ```
   docker run -d --name rat-drill -e POSTGRES_PASSWORD=drill -p 55432:5432 postgres:16
   ```
3. From the repo (needs `psql`, `pg_restore` and `age`):
   ```
   infra/backup/restore-check.sh rat-YYYYMMDD-HHMMSS.dump.age ~/rat-backup.key postgres://postgres:drill@localhost:55432/postgres
   ```
   It refuses any database that already has tables (so it can never write over production), decrypts, restores, checks every table and the migrations, and prints each table's rows, the newest ledger entry and `PASS` with the restore time.
4. Compare the rats count with `rat status` on production (the backup is up to a day old).
5. `docker rm -f rat-drill` and delete the downloaded file.

`infra/backup/selftest.sh` runs the whole loop with nothing real (a simulated launch in a local Postgres, a local S3 server that checks signatures, a fake Telegram), including the failure alerts. CI runs it on every push.

## Restore (incident)
1. `rat kill --reason restore` (or `KILL_SWITCH=true`) and stop the worker service.
2. Pick the source:
   - A recent mistake: Postgres service > Backups > **Restore** a volume backup (or PITR to a moment). Railway stages it; review and **Deploy**.
   - The project or volume is gone: a new PostgreSQL service named `Postgres` (the references keep working), then from your machine:
     ```
     age -d -i ~/rat-backup.key -o rat.dump rat-YYYYMMDD-HHMMSS.dump.age
     railway connect Postgres --tunnel-only          # prints a local connection URL; keep it running
     pg_restore --no-owner --no-privileges --exit-on-error --dbname="<that URL>" rat.dump
     ```
     Then create the API's read-only user again (`deploy.md` step 1, item 4): database users are not part of a dump.
3. Start the worker. On start it re-checks every in-flight attempt by signature (nothing is double sent: a rat is never retried while an attempt can land, and the rat wallet is read on-chain before any retry).
4. `rat status`, then `rat resume`.

Transactions that landed after the backup are picked up by the wallet watch (signatures on the creator wallet) and the hire/claim reconciliation.
