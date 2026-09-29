# The nightly backup job (infra/railway.backup.json). pg_dump must be at least the database's major version:
# Railway's Postgres is 18. This major is the one source of truth: scripts/setup-mac.sh installs the same client on
# the Mac (restore drill), CI tests on it, and scripts/check-guards.mjs keeps them equal. If Railway's database major
# changes, bump it here (setup and the job both stop and say so if you forget).
FROM postgres:18-alpine
RUN apk add --no-cache age curl
COPY infra/backup/backup.sh /usr/local/bin/rat-backup
RUN chmod 755 /usr/local/bin/rat-backup
USER postgres
ENTRYPOINT ["/usr/local/bin/rat-backup"]
