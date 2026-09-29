# The nightly backup job (infra/railway.backup.json). pg_dump must be at least the database's major version:
# Railway's Postgres is 16. If you upgrade the database, bump this tag (the job alerts you if you forget).
FROM postgres:16-alpine
RUN apk add --no-cache age curl
COPY infra/backup/backup.sh /usr/local/bin/rat-backup
RUN chmod 755 /usr/local/bin/rat-backup
USER postgres
ENTRYPOINT ["/usr/local/bin/rat-backup"]
