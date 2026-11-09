#!/usr/bin/env bash
#
# mongo-restore.sh (WP-064)
#
# Restores a dump produced by scripts/mongo-backup.sh into a THROWAWAY
# target — never into the live srckube-* databases. See
# docs/backup-restore-runbook.md for the full, real transcript of a tested
# restore (dump -> restore into throwaway -> count/spot-check -> teardown).
#
# TRAP THIS SCRIPT EXISTS TO GUARD AGAINST (R-07 / trap #2 in the WP-064
# brief): `mongorestore --drop` pointed at a live database name would
# destroy that database's current data. This script makes that impossible
# by construction:
#   - the restore target is never the original database name; every
#     restored database is renamed to "<TARGET_PREFIX><original-name>"
#     via mongorestore's --nsFrom/--nsTo namespace remap, so the live
#     namespace is never even addressed by the mongorestore invocation;
#   - --target-prefix is a REQUIRED, non-empty argument;
#   - before touching anything, this script queries mongod for the CURRENT
#     list of live database names and aborts the entire run (no partial
#     restore) if any computed target name collides with a live one.
#
# --drop, if passed, is scoped to mongorestore's own --drop flag, which
# only drops collections inside the (renamed, non-live) TARGET namespace —
# it makes the restore idempotent across re-runs of this script, not
# dangerous.
#
# Usage:
#   ./scripts/mongo-restore.sh --dump-dir <path> --target-prefix <prefix> [--drop] [--db <name> ...]
#
# Examples:
#   ./scripts/mongo-restore.sh --dump-dir backups/mongo/20260829T120000Z --target-prefix restoretest_
#   ./scripts/mongo-restore.sh --dump-dir backups/mongo/20260829T120000Z --target-prefix restoretest_ --db srckube-user --drop
#
# Env (same credential vars as mongo-backup.sh):
#   MONGO_BACKUP_USER, MONGO_BACKUP_PASSWORD (required, from backend/.env)
#   MONGO_BACKUP_HOST (default localhost), MONGO_BACKUP_PORT (default 27017)
#   MONGO_BACKUP_AUTH_DB (default admin), MONGO_BACKUP_CONTAINER (default mongodb)
#
# Exit status: non-zero on any failure, including the anti-clobber guard
# tripping. No silent retries.
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

usage() {
  cat <<'EOF'
Usage: mongo-restore.sh --dump-dir <path> --target-prefix <prefix> [--drop] [--db <name> ...]

  --dump-dir <path>      Directory produced by mongo-backup.sh (contains one
                          subdirectory per database, e.g. srckube-user/).
  --target-prefix <str>  REQUIRED. Non-empty prefix prepended to every
                          restored database's name, e.g. "restoretest_" ->
                          srckube-user restores into restoretest_srckube-user.
                          Refused if the resulting name collides with any
                          currently-live database.
  --db <name>             Restore only this database (may repeat). Default:
                          every subdirectory found in --dump-dir.
  --drop                 Pass --drop to mongorestore (drops the TARGET
                          namespace's collections first; never touches the
                          live namespace — see header comment).
  -h, --help              Show this help.
EOF
}

DUMP_DIR=""
TARGET_PREFIX=""
DROP_FLAG=""
DBS_ARG=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dump-dir) DUMP_DIR="${2:-}"; shift 2 ;;
    --target-prefix) TARGET_PREFIX="${2:-}"; shift 2 ;;
    --db) DBS_ARG+=("${2:-}"); shift 2 ;;
    --drop) DROP_FLAG="--drop"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown argument: $1"; usage; exit 1 ;;
  esac
done

if [ -z "$DUMP_DIR" ] || [ -z "$TARGET_PREFIX" ]; then
  err "--dump-dir and --target-prefix are both required."
  usage
  exit 1
fi
if [ ! -d "$DUMP_DIR" ]; then
  err "--dump-dir '$DUMP_DIR' does not exist."
  exit 1
fi
# Guard against an empty-after-trim or whitespace-only prefix, which would
# make target == source and defeat the whole point of this script.
TRIMMED_PREFIX="$(printf '%s' "$TARGET_PREFIX" | tr -d '[:space:]')"
if [ -z "$TRIMMED_PREFIX" ]; then
  err "--target-prefix must be non-empty (and not whitespace-only)."
  exit 1
fi

# ---------------------------------------------------------------------------
# Credentials (same pattern as mongo-backup.sh)
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
  err "See backend/.env.example."
  exit 1
fi

MONGO_BACKUP_HOST="${MONGO_BACKUP_HOST:-localhost}"
MONGO_BACKUP_PORT="${MONGO_BACKUP_PORT:-27017}"
MONGO_BACKUP_AUTH_DB="${MONGO_BACKUP_AUTH_DB:-admin}"
MONGO_BACKUP_CONTAINER="${MONGO_BACKUP_CONTAINER:-mongodb}"

# Default to `docker exec` into the container, same reasoning as
# mongo-backup.sh: a stray, unrelated, non-Docker mongod has been observed
# listening on 127.0.0.1:27017 on this project's dev host, which host-TCP
# tools can silently hit instead of the real container. See
# mongo-backup.sh's header comment for the full story. Host-TCP mode is an
# explicit opt-in via MONGO_BACKUP_ALLOW_HOST_TCP=1.
MODE=""
if docker exec "$MONGO_BACKUP_CONTAINER" sh -c 'command -v mongorestore && command -v mongosh' >/dev/null 2>&1; then
  MODE="container"
elif [ "${MONGO_BACKUP_ALLOW_HOST_TCP:-0}" = "1" ] && command -v mongorestore >/dev/null 2>&1 && command -v mongosh >/dev/null 2>&1; then
  MODE="host"
  log "==> WARNING: using host-installed mongorestore/mongosh over TCP to ${MONGO_BACKUP_HOST}:${MONGO_BACKUP_PORT}."
  log "    Make sure you've verified that port actually reaches the '${MONGO_BACKUP_CONTAINER}' container"
  log "    on this machine (see mongo-backup.sh's header comment)."
else
  err "Could not use 'docker exec ${MONGO_BACKUP_CONTAINER}' (container not running, or lacks"
  err "mongorestore/mongosh), and MONGO_BACKUP_ALLOW_HOST_TCP is not set to 1."
  err "See mongo-backup.sh's tool-discovery error for details."
  exit 1
fi
log "==> Mode: $MODE"

# ---------------------------------------------------------------------------
# Determine which databases to restore
# ---------------------------------------------------------------------------
if [ "${#DBS_ARG[@]}" -gt 0 ]; then
  DBS=("${DBS_ARG[@]}")
else
  DBS=()
  for d in "$DUMP_DIR"/*/; do
    [ -d "$d" ] || continue
    DBS+=("$(basename "$d")")
  done
fi
if [ "${#DBS[@]}" -eq 0 ]; then
  err "No database subdirectories found under $DUMP_DIR."
  exit 1
fi
log "==> Databases to restore: ${DBS[*]}"

# ---------------------------------------------------------------------------
# ANTI-CLOBBER GUARD — query the live database list and refuse to proceed
# if any computed target name already exists. Runs BEFORE any mongorestore
# invocation; if it fails, nothing has been touched.
# ---------------------------------------------------------------------------
list_databases_eval='db.adminCommand({listDatabases:1, nameOnly:true}).databases.map(d=>d.name).forEach(n=>print(n))'
if [ "$MODE" = "host" ]; then
  read_lines_into LIVE_DBS < <(mongosh --quiet \
    --host "$MONGO_BACKUP_HOST" --port "$MONGO_BACKUP_PORT" \
    --username "$MONGO_BACKUP_USER" --password "$MONGO_BACKUP_PASSWORD" \
    --authenticationDatabase "$MONGO_BACKUP_AUTH_DB" \
    --eval "$list_databases_eval" 2>/dev/null)
else
  read_lines_into LIVE_DBS < <(docker exec "$MONGO_BACKUP_CONTAINER" mongosh --quiet \
    --username "$MONGO_BACKUP_USER" --password "$MONGO_BACKUP_PASSWORD" \
    --authenticationDatabase "$MONGO_BACKUP_AUTH_DB" \
    --eval "$list_databases_eval" 2>/dev/null)
fi
if [ "${#LIVE_DBS[@]}" -eq 0 ]; then
  err "Could not enumerate live databases (mongod unreachable?). Refusing to restore"
  err "without being able to positively confirm the target names are safe."
  exit 1
fi

# No associative arrays (bash 3.2 on macOS, the dev host for this project,
# lacks `declare -A`) — the target name is a pure function of db + prefix,
# so just recompute it wherever needed via target_for().
target_for() { printf '%s%s' "$TARGET_PREFIX" "$1"; }

for db in "${DBS[@]}"; do
  target="$(target_for "$db")"
  if [ "$target" = "$db" ]; then
    err "Computed target '$target' equals the source database name '$db'."
    err "--target-prefix must actually change the name. Refusing to restore."
    exit 1
  fi
  for live in "${LIVE_DBS[@]}"; do
    if [ "$target" = "$live" ]; then
      err "GUARD TRIPPED: computed target '$target' (for source '$db') matches a"
      err "database that currently EXISTS on ${MONGO_BACKUP_HOST}:${MONGO_BACKUP_PORT}."
      err "Restoring would risk clobbering live data. Choose a different"
      err "--target-prefix. No restore has been performed (this check runs before"
      err "any mongorestore invocation)."
      exit 1
    fi
  done
done
log "==> Anti-clobber guard passed. Live databases checked: ${#LIVE_DBS[@]}."
for db in "${DBS[@]}"; do
  log "    $db  ->  $(target_for "$db")"
done

# total_doc_count <dbname> — sums countDocuments() across every collection
# in <dbname>, via whichever mode is active. Used below as a self-check:
# mongorestore can exit 0 while having silently restored zero documents
# (observed while building this script — a directory-layout mismatch made
# it print "don't know what to do with file ..., skipping" for every .bson
# file and still exit 0 with "0 document(s) restored successfully"), so
# exit-code alone is not sufficient evidence of a working restore.
total_doc_count() {
  local dbname="$1"
  local eval_js='var t=0; db.getCollectionNames().forEach(function(c){t+=db.getCollection(c).countDocuments();}); print(t);'
  if [ "$MODE" = "host" ]; then
    mongosh --quiet \
      --host "$MONGO_BACKUP_HOST" --port "$MONGO_BACKUP_PORT" \
      --username "$MONGO_BACKUP_USER" --password "$MONGO_BACKUP_PASSWORD" \
      --authenticationDatabase "$MONGO_BACKUP_AUTH_DB" \
      "$dbname" --eval "$eval_js" 2>/dev/null
  else
    docker exec "$MONGO_BACKUP_CONTAINER" mongosh --quiet \
      --username "$MONGO_BACKUP_USER" --password "$MONGO_BACKUP_PASSWORD" \
      --authenticationDatabase "$MONGO_BACKUP_AUTH_DB" \
      "$dbname" --eval "$eval_js" 2>/dev/null
  fi
}

# ---------------------------------------------------------------------------
# Restore each database into its renamed target.
#
# mongorestore's --nsFrom/--nsTo rename only works when its positional
# argument is a PARENT directory whose immediate child is a directory named
# exactly like the source db (this is how it infers the source namespace) —
# pointing it straight at the db's own dump subfolder does not work
# (verified: it logs "don't know what to do with file" for every .bson and
# restores nothing, yet still exits 0). So each db is staged into an
# isolated, throwaway parent directory containing only that one db's
# subfolder (never a directory with sibling db folders — --nsInclude scopes
# correctly even with siblings present, verified separately, but isolating
# per db keeps every restore invocation trivially auditable and avoids any
# possibility of an unmatched sibling namespace being touched).
# ---------------------------------------------------------------------------
FAILED=()
for db in "${DBS[@]}"; do
  target="$(target_for "$db")"
  src_dir="$DUMP_DIR/$db"
  if [ ! -d "$src_dir" ]; then
    err "Expected dump directory '$src_dir' not found for db '$db'."
    FAILED+=("$db")
    continue
  fi
  src_count="$(total_doc_count "$db")"
  log "==> Restoring $db (source has ${src_count:-?} document(s)) -> $target ..."
  restore_ok=1
  if [ "$MODE" = "host" ]; then
    STAGE="$(mktemp -d "${TMPDIR:-/tmp}/mongo-restore-XXXXXX")"
    mkdir -p "$STAGE/$db"
    cp -R "$src_dir/." "$STAGE/$db/"
    if ! mongorestore \
      --host "$MONGO_BACKUP_HOST" --port "$MONGO_BACKUP_PORT" \
      --username "$MONGO_BACKUP_USER" --password "$MONGO_BACKUP_PASSWORD" \
      --authenticationDatabase "$MONGO_BACKUP_AUTH_DB" \
      --nsInclude "${db}.*" --nsFrom "${db}.*" --nsTo "${target}.*" \
      $DROP_FLAG \
      "$STAGE" >"$DUMP_DIR/.restore-${db}.log" 2>&1; then
      restore_ok=0
    fi
    rm -rf "$STAGE"
  else
    CONTAINER_TMP="/tmp/mongo-restore-$$-${db}"
    if docker exec "$MONGO_BACKUP_CONTAINER" mkdir -p "$CONTAINER_TMP/$db" \
      && docker cp "$src_dir/." "$MONGO_BACKUP_CONTAINER:$CONTAINER_TMP/$db/" >"$DUMP_DIR/.restore-${db}.log" 2>&1 \
      && docker exec "$MONGO_BACKUP_CONTAINER" mongorestore \
        --username "$MONGO_BACKUP_USER" --password "$MONGO_BACKUP_PASSWORD" \
        --authenticationDatabase "$MONGO_BACKUP_AUTH_DB" \
        --nsInclude "${db}.*" --nsFrom "${db}.*" --nsTo "${target}.*" \
        $DROP_FLAG \
        "$CONTAINER_TMP" >>"$DUMP_DIR/.restore-${db}.log" 2>&1; then
      :
    else
      restore_ok=0
    fi
    docker exec "$MONGO_BACKUP_CONTAINER" rm -rf "$CONTAINER_TMP" >/dev/null 2>&1 || true
  fi

  if [ "$restore_ok" -eq 0 ]; then
    err "  mongorestore failed for $db -> $target — see $DUMP_DIR/.restore-${db}.log"
    FAILED+=("$db")
    continue
  fi

  target_count="$(total_doc_count "$target")"
  if [ "${src_count:-0}" != "${target_count:-0}" ]; then
    err "  DOCUMENT COUNT MISMATCH for $db -> $target: source=${src_count:-?} target=${target_count:-?}"
    err "  See $DUMP_DIR/.restore-${db}.log"
    FAILED+=("$db")
  else
    log "    OK: $target has ${target_count} document(s), matching source."
  fi
done

if [ "${#FAILED[@]}" -gt 0 ]; then
  err "Restore FAILED for: ${FAILED[*]}"
  exit 1
fi

log "==> Restore complete. Restored into throwaway database(s):"
for db in "${DBS[@]}"; do
  log "    $(target_for "$db")"
done
log "==> These are NOT live databases. Verify, then drop them yourself when done, e.g.:"
for db in "${DBS[@]}"; do
  log "    mongosh --host $MONGO_BACKUP_HOST --port $MONGO_BACKUP_PORT -u \$MONGO_BACKUP_USER -p \$MONGO_BACKUP_PASSWORD --authenticationDatabase $MONGO_BACKUP_AUTH_DB $(target_for "$db") --eval 'db.dropDatabase()'"
done
exit 0
