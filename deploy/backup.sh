#!/usr/bin/env bash
set -e

# Directories
PROJECT_DIR="/opt/social-bot"
DATA_DIR="${PROJECT_DIR}/data"
BACKUP_DIR="${DATA_DIR}/backups"

# Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

# Date string for the backup filename
DATE_STR=$(date +%F)
BACKUP_FILE="${BACKUP_DIR}/app-${DATE_STR}.db"

echo "Starting database backup..."

# Use SQLite's online backup API to safely dump the DB even if it's in use
sqlite3 "${DATA_DIR}/app.db" ".backup '${BACKUP_FILE}'"

echo "Backup created at ${BACKUP_FILE}"

# Keep only the last 7 days of backups
echo "Cleaning up backups older than 7 days..."
find "${BACKUP_DIR}" -name "app-*.db" -type f -mtime +7 -exec rm {} \;

echo "Backup complete!"
