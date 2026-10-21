#!/usr/bin/env bash
# Daily logical backup of the central PostgreSQL database.
#   DATABASE_URL  connection string (default: postgres://store:store@localhost:5432/store)
#   BACKUP_DIR    target directory (default: ./backups)
#   KEEP_DAYS     retention in days (default: 30)
# Schedule with cron / Windows Task Scheduler, e.g.:  15 1 * * *  /opt/store/apps/server/scripts/backup-db.sh
set -euo pipefail
DATABASE_URL="${DATABASE_URL:-postgres://store:store@localhost:5432/store}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/store-$(date +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --no-owner --file="$file.partial" "$DATABASE_URL"
# Verify the archive is readable before declaring success.
pg_restore --list "$file.partial" > /dev/null
mv "$file.partial" "$file"
find "$BACKUP_DIR" -name 'store-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "Backup written: $file"
