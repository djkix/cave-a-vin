#!/bin/sh
# Dump quotidien de la base, jamais un fichier tronqué : le nom définitif
# n'apparaît qu'après un pg_dump ET un gzip réussis. Le dump est fait avec
# --clean --if-exists, il se restaure donc par-dessus un schéma existant.
set -eu
mkdir -p /backups
while true; do
  ts=$(date +%Y%m%d-%H%M%S)
  raw="/backups/cave-${ts}.sql.part"
  tmp="/backups/cave-${ts}.sql.gz.tmp"
  final="/backups/cave-${ts}.sql.gz"
  # busybox ash n'a pas PIPESTATUS : on dumpe d'abord, on compresse ensuite,
  # afin de tester chaque code de retour séparément.
  if pg_dump --clean --if-exists > "$raw"; then
    if gzip -c "$raw" > "$tmp"; then
      rm -f "$raw"
      mv "$tmp" "$final"
    else
      rm -f "$raw" "$tmp"
      echo "backup failed" >&2
    fi
  else
    rm -f "$raw"
    echo "backup failed" >&2
  fi
  find /backups -name 'cave-*.sql.gz' -mtime "+${BACKUP_RETENTION_DAYS}" -delete
  sleep "${BACKUP_INTERVAL_SECONDS}"
done
