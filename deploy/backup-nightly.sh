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
KEYCLOAK_ROOT="${KEYCLOAK_ROOT:-/var/backups/vedan/keycloak}"
KEEP_DAYS="${KEEP_DAYS:-14}"
LOG="${BACKUP_LOG:-/var/backups/vedan/backup.log}"

mkdir -p "$BACKUP_ROOT" "$KEYCLOAK_ROOT" "$(dirname "$LOG")"

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

# Mongo is only half the data. Every user account, credential hash, client and
# authentication flow lives in POSTGRES, behind Keycloak -- so a backup set
# that covers Mongo alone restores an application nobody can log into. This is
# the half that would have been missed.
echo "--- keycloak realm (users and credential hashes live in postgres) ---"
export KEYCLOAK_BACKUP_OUT_DIR="$KEYCLOAK_ROOT"
bash scripts/keycloak-export.sh

# And verify it, because keycloak-export.sh checks its own output with `jq`,
# which is not installed on this host -- so it printed "skipping automated
# content verification" and exited 0. Its own header says not to trust the
# export until that check has run. `kc.sh export` is also the case where the
# exit code means nothing: it reports success and exits 1. Content is the only
# evidence there is.
LATEST_REALM=$(ls -1d "$KEYCLOAK_ROOT"/*/ 2>/dev/null | tail -1)
test -n "$LATEST_REALM" || { echo "FATAL: no keycloak export directory produced"; exit 1; }
python3 verify-realm-export.py "${LATEST_REALM}srckube-realm.json"

# Prune AFTER successful dumps, never before: pruning first would discard the
# last known-good copy to make room for one that might fail.
echo "--- pruning dumps older than ${KEEP_DAYS} days ---"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+${KEEP_DAYS}" -print -exec rm -rf {} + || true
find "$KEYCLOAK_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+${KEEP_DAYS}" -print -exec rm -rf {} + || true

echo "--- kept ---"
ls -1 "$BACKUP_ROOT" | sed 's/^/    mongo:    /'
ls -1 "$KEYCLOAK_ROOT" | sed 's/^/    keycloak: /'
echo "--- disk ---"
df -h "$BACKUP_ROOT" | tail -1
echo "=== $(date -u +%FT%TZ) complete ==="
