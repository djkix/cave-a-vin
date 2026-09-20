#!/bin/sh
set -eu
mkdir -p /backups
while true; do
  ts=$(date +%Y%m%d-%H%M%S)
  pg_dump | gzip > "/backups/cave-${ts}.sql.gz"
  find /backups -name 'cave-*.sql.gz' -mtime "+${BACKUP_RETENTION_DAYS}" -delete
  sleep "${BACKUP_INTERVAL_SECONDS}"
done
