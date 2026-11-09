#!/usr/bin/env bash
#
# mongo-backup.sh (WP-064)
#
# Dumps every srckube-owned MongoDB database (discovered dynamically by
# name prefix, not hardcoded) to a timestamped, gitignored directory on the
# host filesystem. This is the backup half of WP-064; see
# scripts/mongo-restore.sh for the restore half and docs/backup-restore-runbook.md
# for the full runbook (how to schedule it, RPO/RTO, and the tested-restore
# evidence).
#
# WHY "discovered dynamically, prefix-filtered": the mongod this stack talks
# to (see backend/docker-compose.yml's `mongodb` service) is a SHARED dev
# instance. `mongosh --eval 'db.adminCommand({listDatabases:1})'` against it
# turns up several databases that do NOT belong to this project (other
# local projects' data, e.g. "codeshark", "fauserdb", "authdeputy",
# "fields-service", "folders-service") plus Mongo's own system databases
# (admin/config/local). Backing those up would be scope creep at best and
# a data-handling mistake at worst, so this script dumps only databases
# whose name starts with "srckube-" — the prefix every service in
# backend/docker-compose.yml's MONGO_URI/MONGO_URI_TESTPLAN/
# MONGO_URI_TESTEXECUTION vars uses. New services that add a new
# srckube-* database are picked up automatically, with no edit here.
#
# WHAT THIS DELIVERS (read docs/backup-restore-runbook.md for the honest
# RPO/RTO discussion): this script performs an ON-DEMAND dump when you run
# it. It does NOT install a cron job or otherwise schedule itself — see the
# runbook for the cron line to add if/when someone wants a real schedule.
#
# Credentials: read from env (GR-9). Set MONGO_BACKUP_USER /
# MONGO_BACKUP_PASSWORD in backend/.env (untracked; copy from
# backend/.env.example). This script never hardcodes a password.
#
# Usage:
#   ./scripts/mongo-backup.sh
#
# Env overrides (all optional except the two credential vars):
#   MONGO_BACKUP_USER       (required, from backend/.env)
#   MONGO_BACKUP_PASSWORD   (required, from backend/.env)
#   MONGO_BACKUP_HOST       (default: localhost)
#   MONGO_BACKUP_PORT       (default: 27017)
#   MONGO_BACKUP_AUTH_DB    (default: admin)
#   MONGO_BACKUP_CONTAINER  (default: mongodb — used only as a fallback,
#                            see "TOOL DISCOVERY" below)
#   BACKUP_OUT_DIR          (default: <repo root>/backups/mongo)
#
# Exit status: non-zero on any failure (missing creds, unreachable mongod,
# a failed per-database dump). No silent retries.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '%s\n' "$*"; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }

# Portable stand-in for `mapfile -t` (bash 3.2 on macOS, the dev host for
# this project, has no mapfile builtin — see scripts/run-api-tests.sh's
# equivalent avoidance).
read_lines_into() {
  local __varname="$1"
  eval "$__varname=()"
  local __line
  while IFS= read -r __line; do
    [ -n "$__line" ] || continue
    eval "$__varname+=(\"\$__line\")"
  done
}

# ---------------------------------------------------------------------------
# 1. Credentials (GR-9: env only, never hardcoded here)
# ---------------------------------------------------------------------------
if { [ -z "${MONGO_BACKUP_USER:-}" ] || [ -z "${MONGO_BACKUP_PASSWORD:-}" ]; } \
   && [ -f "$REPO_ROOT/backend/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/backend/.env"
  set +a
fi

# WP-101 -- MONGO_ROOT_USER/MONGO_ROOT_PASSWORD are the canonical names (the
# Mongo root credentials now live only in backend/.env, since
# docker-compose.yml is tracked). MONGO_BACKUP_* is the same credential under
# an older, misleading name -- despite it, this is the ROOT user. Preferring
# the canonical pair here is what lets the deprecated alias be deleted without
# breaking backup or restore.
if [ -n "${MONGO_ROOT_USER:-}" ]; then MONGO_BACKUP_USER="${MONGO_ROOT_USER}"; fi
if [ -n "${MONGO_ROOT_PASSWORD:-}" ]; then MONGO_BACKUP_PASSWORD="${MONGO_ROOT_PASSWORD}"; fi

if [ -z "${MONGO_BACKUP_USER:-}" ] || [ -z "${MONGO_BACKUP_PASSWORD:-}" ]; then
  err "MONGO_BACKUP_USER and/or MONGO_BACKUP_PASSWORD are not set."
  err "Copy backend/.env.example to backend/.env (if you haven't) and fill in"
  err "MONGO_BACKUP_USER / MONGO_BACKUP_PASSWORD with the Mongo root credentials"
  err "configured for the 'mongodb' service in backend/docker-compose.yml"
  err "(MONGO_INITDB_ROOT_USERNAME / MONGO_INITDB_ROOT_PASSWORD), or export"
  err "both directly in your shell."
  exit 1
fi
log "==> Mongo credentials resolved (MONGO_BACKUP_USER=${MONGO_BACKUP_USER})."

MONGO_BACKUP_HOST="${MONGO_BACKUP_HOST:-localhost}"
MONGO_BACKUP_PORT="${MONGO_BACKUP_PORT:-27017}"
MONGO_BACKUP_AUTH_DB="${MONGO_BACKUP_AUTH_DB:-admin}"
MONGO_BACKUP_CONTAINER="${MONGO_BACKUP_CONTAINER:-mongodb}"

# ---------------------------------------------------------------------------
# 2. Tool discovery — trap #1: mongodump/mongorestore may not be on the host.
#
#    ALSO (discovered while building this script, on this exact dev host):
#    a stray, unrelated, NON-Docker mongod can be listening on
#    127.0.0.1:27017 / [::1]:27017 at the same time the `mongodb` container
#    publishes 0.0.0.0:27017. Both `lsof -iTCP:27017` and a direct
#    unauthenticated `mongosh --host 127.0.0.1 --port 27017` proved this:
#    the stray process serves a DIFFERENT, unrelated set of databases
#    ("codeshark", "authdeputy", "fauserdb", "fields-service",
#    "folders-service") plus a stale/divergent copy of some srckube-*
#    databases (verified: its srckube-testplan.testplans had 6 documents
#    vs. the container's 7 at the time of writing). Because the stray
#    process binds the more specific address, host-TCP connections to
#    "localhost"/"127.0.0.1" can silently land on the WRONG mongod — no
#    error, just wrong data, which is far worse than a loud failure.
#
#    The application itself is never at risk: every backend service talks
#    to the `mongodb` DOCKER SERVICE NAME on the internal src-kube-network,
#    which Docker's embedded DNS can only resolve to the actual container —
#    it never touches the host's published port. But a HUMAN or SCRIPT
#    connecting from the host over TCP can be fooled. So this script
#    defaults to talking to the container directly via `docker exec`
#    (unambiguous — addressed by container name, not by a host port that
#    might be intercepted) and only uses host-installed mongodump/mongosh
#    if MONGO_BACKUP_ALLOW_HOST_TCP=1 is explicitly set, with a warning.
# ---------------------------------------------------------------------------
MODE=""
if docker exec "$MONGO_BACKUP_CONTAINER" sh -c 'command -v mongodump && command -v mongosh' >/dev/null 2>&1; then
  MODE="container"
  log "==> Using 'docker exec ${MONGO_BACKUP_CONTAINER}' (default — see host-port-collision note above)."
elif [ "${MONGO_BACKUP_ALLOW_HOST_TCP:-0}" = "1" ] && command -v mongodump >/dev/null 2>&1 && command -v mongosh >/dev/null 2>&1; then
  MODE="host"
  log "==> WARNING: using host-installed mongodump/mongosh over TCP to ${MONGO_BACKUP_HOST}:${MONGO_BACKUP_PORT}."
  log "    On some dev hosts this port can be served by an unrelated, non-Docker mongod"
  log "    instead of the '${MONGO_BACKUP_CONTAINER}' container (see script header). You have"
  log "    opted in via MONGO_BACKUP_ALLOW_HOST_TCP=1 — make sure you've verified which"
  log "    process actually owns that port on this machine."
else
  err "Could not use 'docker exec ${MONGO_BACKUP_CONTAINER}' (container not running, or lacks"
  err "mongodump/mongosh). Start it: 'docker compose -f backend/docker-compose.yml up -d mongodb'."
  err "Host-TCP fallback is available but disabled by default because a host port collision"
  err "was observed on this project's dev machine (see script header comment) — set"
  err "MONGO_BACKUP_ALLOW_HOST_TCP=1 only if you have verified port ${MONGO_BACKUP_PORT} on"
  err "${MONGO_BACKUP_HOST} actually reaches the '${MONGO_BACKUP_CONTAINER}' container."
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Output location — a host-mounted path that survives container
#    restarts/recreation, never inside an ephemeral container.
# ---------------------------------------------------------------------------
BACKUP_OUT_DIR="${BACKUP_OUT_DIR:-$REPO_ROOT/backups/mongo}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_DIR="$BACKUP_OUT_DIR/$TIMESTAMP"
mkdir -p "$DUMP_DIR"
log "==> Dump target: $DUMP_DIR"

# ---------------------------------------------------------------------------
# 4. Discover srckube-* databases (GR-1: verify, don't assume the list)
# ---------------------------------------------------------------------------
list_databases_eval='db.adminCommand({listDatabases:1, nameOnly:true}).databases.map(d=>d.name).filter(n=>n.indexOf("srckube-")===0).forEach(n=>print(n))'

if [ "$MODE" = "host" ]; then
  read_lines_into DBS < <(mongosh --quiet \
    --host "$MONGO_BACKUP_HOST" --port "$MONGO_BACKUP_PORT" \
    --username "$MONGO_BACKUP_USER" --password "$MONGO_BACKUP_PASSWORD" \
    --authenticationDatabase "$MONGO_BACKUP_AUTH_DB" \
    --eval "$list_databases_eval" 2>/dev/null)
else
  read_lines_into DBS < <(docker exec "$MONGO_BACKUP_CONTAINER" mongosh --quiet \
    --username "$MONGO_BACKUP_USER" --password "$MONGO_BACKUP_PASSWORD" \
    --authenticationDatabase "$MONGO_BACKUP_AUTH_DB" \
    --eval "$list_databases_eval" 2>/dev/null)
fi

if [ "${#DBS[@]}" -eq 0 ]; then
  err "Discovered zero databases matching prefix 'srckube-'. Is mongod reachable"
  err "at ${MONGO_BACKUP_HOST}:${MONGO_BACKUP_PORT}, and are the credentials correct?"
  err "(This also fires if the stack has never been seeded with data — check"
  err "manually with mongosh before assuming this script is broken.)"
  exit 1
fi
log "==> Discovered ${#DBS[@]} srckube-* database(s): ${DBS[*]}"

# ---------------------------------------------------------------------------
# 5. Dump each database
# ---------------------------------------------------------------------------
FAILED=()
for db in "${DBS[@]}"; do
  log "==> Dumping $db ..."
  if [ "$MODE" = "host" ]; then
    if ! mongodump \
      --host "$MONGO_BACKUP_HOST" --port "$MONGO_BACKUP_PORT" \
      --username "$MONGO_BACKUP_USER" --password "$MONGO_BACKUP_PASSWORD" \
      --authenticationDatabase "$MONGO_BACKUP_AUTH_DB" \
      --db "$db" --out "$DUMP_DIR" >"$DUMP_DIR/.${db}.log" 2>&1; then
      err "  mongodump failed for $db — see $DUMP_DIR/.${db}.log"
      FAILED+=("$db")
    fi
  else
    CONTAINER_TMP="/tmp/mongo-backup-$$-${db}"
    if docker exec "$MONGO_BACKUP_CONTAINER" mongodump \
        --username "$MONGO_BACKUP_USER" --password "$MONGO_BACKUP_PASSWORD" \
        --authenticationDatabase "$MONGO_BACKUP_AUTH_DB" \
        --db "$db" --out "$CONTAINER_TMP" >"$DUMP_DIR/.${db}.log" 2>&1 \
      && docker cp "$MONGO_BACKUP_CONTAINER:$CONTAINER_TMP/$db" "$DUMP_DIR/$db" >>"$DUMP_DIR/.${db}.log" 2>&1; then
      docker exec "$MONGO_BACKUP_CONTAINER" rm -rf "$CONTAINER_TMP" >/dev/null 2>&1
    else
      err "  mongodump (container fallback) failed for $db — see $DUMP_DIR/.${db}.log"
      docker exec "$MONGO_BACKUP_CONTAINER" rm -rf "$CONTAINER_TMP" >/dev/null 2>&1 || true
      FAILED+=("$db")
    fi
  fi
done

# ---------------------------------------------------------------------------
# 6. Manifest + summary
# ---------------------------------------------------------------------------
{
  printf 'timestamp_utc=%s\n' "$TIMESTAMP"
  printf 'mode=%s\n' "$MODE"
  printf 'databases=%s\n' "${DBS[*]}"
  printf 'failed=%s\n' "${FAILED[*]:-}"
} > "$DUMP_DIR/MANIFEST.txt"

if [ "${#FAILED[@]}" -gt 0 ]; then
  err "Backup FAILED for: ${FAILED[*]}"
  err "Dump directory (partial): $DUMP_DIR"
  exit 1
fi

log "==> Backup complete: ${#DBS[@]} database(s) dumped to $DUMP_DIR"
log "    Manifest: $DUMP_DIR/MANIFEST.txt"
exit 0
