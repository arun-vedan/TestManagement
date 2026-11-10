#!/usr/bin/env bash
#
# The scheduled wrapper around scripts/mongo-backup.sh for the production host.
#
# WHY A WRAPPER. mongo-backup.sh is deliberately dumb about where it runs: it
# takes credentials from the environment and writes a timestamped dump. It has
# no scheduling and, importantly, NO RETENTION -- nothing deletes old dumps. On
# a cron it would fill the disk, and a full disk on this box has already taken
# Kong and MongoDB down once. This supplies the three things the script leaves
# to its caller: credentials from the server's .env, a destination outside the
# deploy directory, and pruning.
#
# WHAT THIS IS NOT. It is not offsite. The dumps land on the SAME MACHINE as
# the database, so this protects against a bad migration, a dropped collection
# or a corrupted volume -- and not at all against losing the host. WP-152 is
# not complete until a copy leaves this machine, which needs a bucket only the
# owner can provide. Saying so here, rather than letting a green cron imply a
# safety that does not exist.
#
# Install (as the deploy user):
#   crontab -l 2>/dev/null | grep -q backup-nightly || \
#     (crontab -l 2>/dev/null; echo '17 2 * * * /opt/vedan/backup-nightly.sh') | crontab -
set -euo pipefail

cd /opt/vedan

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/vedan/mongo}"
KEEP_DAYS="${KEEP_DAYS:-14}"
LOG="${BACKUP_LOG:-/var/backups/vedan/backup.log}"

mkdir -p "$BACKUP_ROOT" "$(dirname "$LOG")"

# Bounded, for the same reason the deploy log is.
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1000000 ]; then
  tail -c 250000 "$LOG" > "$LOG.tmp" && mv -f "$LOG.tmp" "$LOG"
fi

exec >> "$LOG" 2>&1
echo "=== $(date -u +%FT%TZ) nightly backup ==="

# `sed -n ...p`, not `grep | cut`: a grep that matches nothing exits 1 and,
# under pipefail, kills the run with no message.
MONGO_ROOT_USER=$(sed -n 's/^MONGO_ROOT_USER=//p' .env | head -1 | tr -d '\r')
MONGO_ROOT_PASSWORD=$(sed -n 's/^MONGO_ROOT_PASSWORD=//p' .env | head -1 | tr -d '\r')
if [ -z "$MONGO_ROOT_USER" ] || [ -z "$MONGO_ROOT_PASSWORD" ]; then
  echo "FATAL: Mongo credentials missing from /opt/vedan/.env"
  exit 1
fi
export MONGO_ROOT_USER MONGO_ROOT_PASSWORD
export BACKUP_OUT_DIR="$BACKUP_ROOT"

bash scripts/mongo-backup.sh

# Prune AFTER a successful dump, never before: pruning first would discard the
# last known-good copy to make room for one that might fail.
echo "--- pruning dumps older than ${KEEP_DAYS} days ---"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+${KEEP_DAYS}" -print -exec rm -rf {} + || true

echo "--- kept ---"
ls -1 "$BACKUP_ROOT" | sed 's/^/    /'
echo "--- disk ---"
df -h "$BACKUP_ROOT" | tail -1
echo "=== $(date -u +%FT%TZ) complete ==="
