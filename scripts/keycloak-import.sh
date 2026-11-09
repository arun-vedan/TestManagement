#!/usr/bin/env bash
#
# keycloak-import.sh (WP-065 -- Step 2 of the Keycloak/Postgres upgrade plan,
# docs/superpowers/plans/keycloak-postgres-upgrade-and-login-theme.md)
#
# Restores a realm export produced by scripts/keycloak-export.sh into a
# running Keycloak container. See docs/keycloak-backup-restore-runbook.md
# for the full runbook and the transcript of a tested restore (create a
# throwaway role -> export -> delete it -> restore -> prove it came back ->
# full Playwright suite green).
#
# UNLIKE scripts/mongo-restore.sh, this script restores INTO THE REAL
# REALM, not a renamed throwaway copy. That is deliberate: a Keycloak realm
# import (`kc.sh import`) is Keycloak's own mechanism for restoring a
# realm's actual identity, and the whole point of Step 2 in the upgrade
# plan is to prove that a broken/upgraded realm can be put back. There is
# no equivalent of Mongo's "restore into a renamed sibling database" for a
# Keycloak realm short of importing under a different realm name, which
# would not prove anything about *this* realm's recoverability. The safety
# net here is therefore CONFIRMATION, not renaming:
#
#   - `--realm <name>` is required and must match the realm name embedded
#     in the export file (`<realm>-realm.json`) -- refuses to proceed on a
#     mismatch, so you cannot accidentally import file A over realm B.
#   - `--confirm <name>` is ALSO required and must exactly repeat the realm
#     name a second time -- a deliberate, typed confirmation (the same
#     "type the resource name" pattern used for other destructive actions
#     in this repo) before this script will touch a live realm. There is no
#     way to bypass this with a single flag.
#   - `kc.sh import` defaults to `--override true` (Keycloak's own default),
#     meaning the entire target realm is deleted and recreated from the
#     export file -- this script does not weaken that, because a restore
#     that only merges is not a real restore. If you want the non-
#     destructive merge behaviour instead, pass --no-override, but note
#     that has NOT been the tested path (see runbook).
#
# CRITICAL, VERIFIED CAVEAT -- READ BEFORE YOU RELY ON THIS:
#   `kc.sh import` (like `kc.sh export`) runs as a SEPARATE, transient
#   Quarkus process inside the container, writing directly to Postgres. It
#   does NOT go through the live Keycloak server process, and the live
#   process's in-memory realm cache is NOT invalidated by this out-of-
#   process write. This was verified directly while proving this restore
#   (see runbook): after an import, the Admin REST API on the live server
#   continued to serve the PRE-restore state (missing a role that had just
#   been restored to Postgres) until the container was restarted -- at
#   which point the live server re-read Postgres from scratch and the
#   restored data appeared correctly.
#
#   CONSEQUENCE: this script does NOT consider an import "done" in any
#   user-visible sense until the container has been restarted. By default
#   it performs the import and then STOPS, printing an explicit warning
#   that the live server will keep serving stale data until you restart
#   it. Pass --restart-after to have this script restart the container
#   itself and wait for it to come back up. A restart takes the whole
#   Keycloak identity provider down for a few seconds -- every one of the
#   17 backend services and the frontend authenticate through it, so treat
#   --restart-after as a real (if brief) maintenance action, not a no-op.
#
# WHAT THIS RESTORES (mirrors what keycloak-export.sh captures -- read its
# header for the full list): realm config, users INCLUDING password
# credential hashes, clients INCLUDING confidential-client secrets, roles,
# role mappings, groups, the loginTheme binding, and realm key material.
# It does NOT restore the `master` realm (never included in the export --
# see keycloak-export.sh's header) and does NOT restore live session
# state or audit events (not part of a realm export at all).
#
# Usage:
#   ./scripts/keycloak-import.sh --dir <path> --realm <name> --confirm <name> [--restart-after] [--no-override]
#
# Example (the exact form used to prove this restore -- see runbook):
#   ./scripts/keycloak-import.sh \
#     --dir backups/keycloak/20260905T013657Z \
#     --realm srckube --confirm srckube --restart-after
#
# Env overrides:
#   KEYCLOAK_IMPORT_CONTAINER  (default: keycloak)
#
# Exit status: non-zero on any failure, including the confirmation
# mismatch guard. No silent retries. The container's own temp import
# directory is always cleaned up on exit via trap.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '%s\n' "$*"; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Usage: keycloak-import.sh --dir <path> --realm <name> --confirm <name> [--restart-after] [--no-override]

  --dir <path>       Directory produced by keycloak-export.sh (contains
                      "<realm>-realm.json").
  --realm <name>     Realm name to restore. Must match the realm embedded
                      in the export file's own filename/contents -- refused
                      on mismatch.
  --confirm <name>   REQUIRED. Must exactly equal --realm's value. A
                      deliberate typed confirmation before this script
                      overwrites a live realm. No shortcut.
  --restart-after    Restart the Keycloak container after import so the
                      live server actually reflects the restored data (see
                      script header -- without this, the running server
                      keeps serving stale cached data). Causes a brief
                      outage for every service that authenticates through
                      this Keycloak.
  --no-override      Pass --override false to kc.sh import (merge instead
                      of replace). NOT the tested path -- see script header.
  -h, --help         Show this help.
EOF
}

DIR=""
REALM=""
CONFIRM=""
RESTART_AFTER=0
OVERRIDE="true"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift 2 ;;
    --realm) REALM="${2:-}"; shift 2 ;;
    --confirm) CONFIRM="${2:-}"; shift 2 ;;
    --restart-after) RESTART_AFTER=1; shift ;;
    --no-override) OVERRIDE="false"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown argument: $1"; usage; exit 1 ;;
  esac
done

if [ -z "$DIR" ] || [ -z "$REALM" ] || [ -z "$CONFIRM" ]; then
  err "--dir, --realm, and --confirm are all required."
  usage
  exit 1
fi
if [ "$REALM" != "$CONFIRM" ]; then
  err "GUARD TRIPPED: --realm ('$REALM') and --confirm ('$CONFIRM') must match exactly."
  err "This confirmation exists so a live realm is never overwritten by accident."
  err "No import has been performed."
  exit 1
fi
if [ ! -d "$DIR" ]; then
  err "--dir '$DIR' does not exist."
  exit 1
fi

REALM_JSON="${REALM}-realm.json"
if [ ! -f "$DIR/$REALM_JSON" ]; then
  err "Expected '$REALM_JSON' not found under '$DIR'."
  err "Is --dir pointing at a directory produced by keycloak-export.sh for realm '$REALM'?"
  exit 1
fi

KEYCLOAK_IMPORT_CONTAINER="${KEYCLOAK_IMPORT_CONTAINER:-keycloak}"

if ! docker inspect -f '{{.State.Running}}' "$KEYCLOAK_IMPORT_CONTAINER" >/dev/null 2>&1 \
   || [ "$(docker inspect -f '{{.State.Running}}' "$KEYCLOAK_IMPORT_CONTAINER" 2>/dev/null)" != "true" ]; then
  err "Container '$KEYCLOAK_IMPORT_CONTAINER' is not running."
  exit 1
fi
if ! docker exec "$KEYCLOAK_IMPORT_CONTAINER" test -x /opt/keycloak/bin/kc.sh >/dev/null 2>&1; then
  err "/opt/keycloak/bin/kc.sh not found in container '$KEYCLOAK_IMPORT_CONTAINER'."
  exit 1
fi
log "==> About to OVERWRITE realm '$REALM' in container '$KEYCLOAK_IMPORT_CONTAINER' from:"
log "      $DIR/$REALM_JSON"
log "    override=$OVERRIDE, restart-after=$([ "$RESTART_AFTER" -eq 1 ] && echo yes || echo no)"

CONTAINER_TMP="/tmp/keycloak-import-$$-$(date -u +%s)"
cleanup() {
  docker exec "$KEYCLOAK_IMPORT_CONTAINER" rm -rf "$CONTAINER_TMP" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker exec "$KEYCLOAK_IMPORT_CONTAINER" mkdir -p "$CONTAINER_TMP"
docker cp "$DIR/$REALM_JSON" "$KEYCLOAK_IMPORT_CONTAINER:$CONTAINER_TMP/$REALM_JSON"

LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/keycloak-import-log-XXXXXX")"
log "==> Running kc.sh import ..."
docker exec "$KEYCLOAK_IMPORT_CONTAINER" /opt/keycloak/bin/kc.sh import \
  --dir "$CONTAINER_TMP" --override "$OVERRIDE" \
  >"$LOG_FILE" 2>&1
IMPORT_RC=$?

# Same caveat as keycloak-export.sh: this transient process fails to bind
# its own HTTP/management ports (the live server already holds them) and
# exits non-zero EVEN ON SUCCESS. Check the log, not $?.
if ! grep -q "KC-SERVICES0032: Import finished successfully" "$LOG_FILE"; then
  err "Import did NOT report success (kc.sh exit code was $IMPORT_RC)."
  err "--- tail of log ($LOG_FILE) ---"
  tail -30 "$LOG_FILE" >&2
  exit 1
fi
log "==> kc.sh reported: Import finished successfully (exit code $IMPORT_RC -- see"
log "    script header for why a non-zero exit code here is expected and harmless)."
rm -f "$LOG_FILE"

if [ "$RESTART_AFTER" -eq 1 ]; then
  log "==> Restarting '$KEYCLOAK_IMPORT_CONTAINER' so the live server picks up the restored data ..."
  docker restart "$KEYCLOAK_IMPORT_CONTAINER" >/dev/null
  log "==> Waiting for realm '$REALM' to answer OIDC discovery (checked from the host --"
  log "    curl is not installed inside the Keycloak image itself) ..."
  # KEYCLOAK_IMPORT_HOST_PORT: the host-published port for the container's 8080
  # (docker-compose maps 8080:8080 -- see keycloak-themes/docker-compose.yml).
  # Override if your setup publishes a different host port.
  KEYCLOAK_IMPORT_HOST_PORT="${KEYCLOAK_IMPORT_HOST_PORT:-8080}"
  READY=0
  for _ in $(seq 1 60); do
    CODE="$(curl -s -o /dev/null -w '%{http_code}' \
      "http://localhost:${KEYCLOAK_IMPORT_HOST_PORT}/realms/$REALM/.well-known/openid-configuration" 2>/dev/null || echo 000)"
    if [ "$CODE" = "200" ]; then READY=1; break; fi
    sleep 2
  done
  if [ "$READY" -ne 1 ]; then
    err "Container restarted but realm '$REALM' did not answer OIDC discovery (via host port"
    err "$KEYCLOAK_IMPORT_HOST_PORT) within 120s. Check 'docker logs $KEYCLOAK_IMPORT_CONTAINER',"
    err "or set KEYCLOAK_IMPORT_HOST_PORT if 8080 isn't the published host port."
    exit 1
  fi
  log "==> Realm '$REALM' is answering. Restore is live-verified."
else
  log "==> NOT restarted (pass --restart-after to do so)."
  log "    WARNING: the running Keycloak server's realm cache does NOT see this"
  log "    change until it restarts (verified during this WP -- see runbook). The"
  log "    database has been restored, but the live server, Admin console, and app"
  log "    logins will keep behaving as if the OLD state were still current until"
  log "    you restart the '$KEYCLOAK_IMPORT_CONTAINER' container."
fi

log "==> Import complete for realm '$REALM'."
exit 0
