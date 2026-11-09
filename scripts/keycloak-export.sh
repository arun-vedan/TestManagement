#!/usr/bin/env bash
#
# keycloak-export.sh (WP-065 -- Step 2 of the Keycloak/Postgres upgrade plan,
# docs/superpowers/plans/keycloak-postgres-upgrade-and-login-theme.md)
#
# Exports the srckube realm from the running Keycloak container to a
# timestamped, gitignored directory on the host filesystem. This is the
# backup half; see scripts/keycloak-import.sh for the restore half and
# docs/keycloak-backup-restore-runbook.md for the full runbook, including
# the transcript of a tested restore.
#
# METHOD: `kc.sh export --realm <realm> --users realm_file`, run via
# `docker exec` directly against the running `keycloak` container. This is
# an OFFLINE-STYLE export that reads the Postgres database directly (using
# the container's own KC_DB_* env vars) -- it does NOT go through the Admin
# REST API. That matters for what it captures:
#
#   - CAPTURED: users, INCLUDING password credential hashes (verified: the
#     export embeds each user's `credentials[].secretData`/`credentialData`,
#     e.g. argon2 hash + salt -- this is exactly what the Admin REST API's
#     GET /users does NOT return, so a REST-API-based export would silently
#     omit passwords). Also captured: clients (INCLUDING confidential
#     clients' plaintext `secret` field), realm roles, client roles, every
#     user's realmRoles/clientRoles mappings, groups, the `loginTheme`
#     binding (verified: exports as "kdk"), and the realm's own signing/
#     encryption key material under `components` (`org.keycloak.keys.
#     KeyProvider` -- this includes a raw AES secret; treat the export file
#     as at least as sensitive as the DB itself).
#   - `--users realm_file` was chosen (not `skip`, which is kc.sh's default
#     strategy and would silently omit every user) so that a restore
#     actually restores logins, not just realm/client config. For the
#     current realm size (8 users) this embeds all users directly in the
#     single realm JSON file; `--users different_files` exists for large
#     realms (500+ users) and was not needed here.
#   - NOT CAPTURED, DELIBERATELY: the `master` realm (including its own
#     admin user) is never touched -- this script always passes an explicit
#     `--realm srckube` (or $KEYCLOAK_EXPORT_REALM), and kc.sh export scopes
#     to exactly that realm. This means a restore of this export cannot by
#     itself recreate a from-scratch Keycloak instance's master admin login
#     -- it assumes master/the admin console credentials already exist
#     (they do, in keycloak-themes/docker-compose.yml, and the owner has
#     decided those stay as they are). If you ever need a master realm
#     backup too, that is a separate, explicit decision -- do not extend
#     this script to include it without discussing the blast radius (the
#     master admin's own credential hash would then live in a file this
#     script also has to protect).
#   - NOT CAPTURED: live session state, event logs, and anything Keycloak
#     stores outside the realm export model (e.g. the Postgres tables that
#     back sessions/audit events, if any survive a restart -- Keycloak
#     mostly keeps these in Infinispan memory, not exported). A realm
#     export is a config+identity backup, not a full point-in-time DB
#     snapshot; if you need the latter, pg_dump the `keycloak` Postgres
#     database directly (out of scope for this script).
#
# KNOWN HARMLESS ERROR (verified, do not treat as failure): the `kc.sh
# export` command boots a second, transient Quarkus instance inside the
# same container as the live server. It successfully exports (logs
# "KC-SERVICES0035: Export finished successfully"), then -- because the
# live process already holds ports 8080/9000 -- fails to also bind its own
# HTTP/management listeners and exits non-zero ("Unable to start the
# management interface: Address already in use"). This happens AFTER the
# export has already completed and does not affect the live server (it is
# a separate PID). Because of this, this script does NOT trust the exit
# code alone -- it greps the captured log for the explicit
# "KC-SERVICES0035: Export finished successfully" marker and fails loudly
# if that marker is absent, regardless of exit code.
#
# SECRETS (GR-9): the export contains client secrets, password hashes, and
# realm key material (see above). The output directory
# ($KEYCLOAK_BACKUP_OUT_DIR, default backups/keycloak/) is gitignored via
# the repo's existing `/backups/` entry -- the same rule that protects
# scripts/mongo-backup.sh's dumps. Never commit a raw export. This script
# never prints secret values to stdout/stderr.
#
# Usage:
#   ./scripts/keycloak-export.sh
#
# Env overrides (all optional):
#   KEYCLOAK_EXPORT_CONTAINER  (default: keycloak)
#   KEYCLOAK_EXPORT_REALM      (default: srckube)
#   KEYCLOAK_BACKUP_OUT_DIR    (default: <repo root>/backups/keycloak)
#
# Exit status: non-zero on any failure (container not running, kc.sh
# missing, export did not report success, copy-out failed). No silent
# retries. The container's own temp export directory is always cleaned up
# on exit (success or failure) via trap.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '%s\n' "$*"; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }

KEYCLOAK_EXPORT_CONTAINER="${KEYCLOAK_EXPORT_CONTAINER:-keycloak}"
KEYCLOAK_EXPORT_REALM="${KEYCLOAK_EXPORT_REALM:-srckube}"
KEYCLOAK_BACKUP_OUT_DIR="${KEYCLOAK_BACKUP_OUT_DIR:-$REPO_ROOT/backups/keycloak}"

# ---------------------------------------------------------------------------
# 1. Safety checks -- verify before doing anything
# ---------------------------------------------------------------------------
if ! docker inspect -f '{{.State.Running}}' "$KEYCLOAK_EXPORT_CONTAINER" >/dev/null 2>&1; then
  err "Container '$KEYCLOAK_EXPORT_CONTAINER' does not exist or docker is unreachable."
  err "Start it: 'docker compose -f keycloak-themes/docker-compose.yml up -d'."
  exit 1
fi
if [ "$(docker inspect -f '{{.State.Running}}' "$KEYCLOAK_EXPORT_CONTAINER" 2>/dev/null)" != "true" ]; then
  err "Container '$KEYCLOAK_EXPORT_CONTAINER' exists but is not running."
  exit 1
fi
if ! docker exec "$KEYCLOAK_EXPORT_CONTAINER" test -x /opt/keycloak/bin/kc.sh >/dev/null 2>&1; then
  err "/opt/keycloak/bin/kc.sh not found (or not executable) in container '$KEYCLOAK_EXPORT_CONTAINER'."
  err "Is this actually a Keycloak container? (image quay.io/keycloak/keycloak)"
  exit 1
fi
log "==> Container '$KEYCLOAK_EXPORT_CONTAINER' is running and has kc.sh."

# ---------------------------------------------------------------------------
# 2. Output location -- host-mounted, timestamped, gitignored (see header)
# ---------------------------------------------------------------------------
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
HOST_OUT_DIR="$KEYCLOAK_BACKUP_OUT_DIR/$TIMESTAMP"
mkdir -p "$HOST_OUT_DIR"
log "==> Export target: $HOST_OUT_DIR"

CONTAINER_TMP="/tmp/keycloak-export-$$-$(date -u +%s)"
cleanup() {
  docker exec "$KEYCLOAK_EXPORT_CONTAINER" rm -rf "$CONTAINER_TMP" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 3. Run the export inside the container (see header for the exit-code /
#    "Address already in use" caveat -- we check the log, not $?).
# ---------------------------------------------------------------------------
docker exec "$KEYCLOAK_EXPORT_CONTAINER" mkdir -p "$CONTAINER_TMP"
LOG_FILE="$HOST_OUT_DIR/.export.log"
log "==> Running kc.sh export for realm '$KEYCLOAK_EXPORT_REALM' ..."
docker exec "$KEYCLOAK_EXPORT_CONTAINER" /opt/keycloak/bin/kc.sh export \
  --dir "$CONTAINER_TMP" --realm "$KEYCLOAK_EXPORT_REALM" --users realm_file \
  >"$LOG_FILE" 2>&1
EXPORT_RC=$?

if ! grep -q "KC-SERVICES0035: Export finished successfully" "$LOG_FILE"; then
  err "Export did NOT report success (kc.sh exit code was $EXPORT_RC)."
  err "Full log: $LOG_FILE"
  err "--- tail of log ---"
  tail -20 "$LOG_FILE" >&2
  exit 1
fi
log "==> kc.sh reported: Export finished successfully (exit code $EXPORT_RC -- see"
log "    script header for why a non-zero exit code here is expected and harmless)."

# ---------------------------------------------------------------------------
# 4. Copy the export out of the container
# ---------------------------------------------------------------------------
REALM_JSON="${KEYCLOAK_EXPORT_REALM}-realm.json"
if ! docker exec "$KEYCLOAK_EXPORT_CONTAINER" test -f "$CONTAINER_TMP/$REALM_JSON" >/dev/null 2>&1; then
  err "Expected export file '$REALM_JSON' not found in container at $CONTAINER_TMP."
  err "See $LOG_FILE."
  exit 1
fi
docker cp "$KEYCLOAK_EXPORT_CONTAINER:$CONTAINER_TMP/$REALM_JSON" "$HOST_OUT_DIR/$REALM_JSON"
log "==> Copied $REALM_JSON to $HOST_OUT_DIR"

# ---------------------------------------------------------------------------
# 5. Verify contents -- don't just claim what was captured, check it.
#    Uses jq if available; degrades to a plain warning otherwise (never
#    fails the backup over a missing verification tool).
# ---------------------------------------------------------------------------
USER_COUNT="?"
CLIENT_COUNT="?"
ROLE_COUNT="?"
LOGIN_THEME="?"
if command -v jq >/dev/null 2>&1; then
  USER_COUNT="$(jq '.users | length' "$HOST_OUT_DIR/$REALM_JSON" 2>/dev/null || echo '?')"
  CLIENT_COUNT="$(jq '.clients | length' "$HOST_OUT_DIR/$REALM_JSON" 2>/dev/null || echo '?')"
  ROLE_COUNT="$(jq '.roles.realm | length' "$HOST_OUT_DIR/$REALM_JSON" 2>/dev/null || echo '?')"
  LOGIN_THEME="$(jq -r '.loginTheme' "$HOST_OUT_DIR/$REALM_JSON" 2>/dev/null || echo '?')"
  WITH_CREDS="$(jq '[.users[] | select(.credentials // [] | length > 0)] | length' "$HOST_OUT_DIR/$REALM_JSON" 2>/dev/null || echo '?')"
  log "==> Verified contents: $USER_COUNT user(s) ($WITH_CREDS with password credentials),"
  log "    $CLIENT_COUNT client(s), $ROLE_COUNT realm role(s), loginTheme=\"$LOGIN_THEME\"."
  if [ "$LOGIN_THEME" != "kdk" ]; then
    log "    NOTE: loginTheme is not 'kdk' -- if you expected it to be, the realm may"
    log "    have changed, or KEYCLOAK_EXPORT_REALM points at the wrong realm."
  fi
else
  log "==> jq not found on host -- skipping automated content verification."
  log "    Inspect $HOST_OUT_DIR/$REALM_JSON manually (or install jq) to confirm"
  log "    users/clients/roles/loginTheme before trusting this export."
fi

# ---------------------------------------------------------------------------
# 6. Manifest
# ---------------------------------------------------------------------------
{
  printf 'timestamp_utc=%s\n' "$TIMESTAMP"
  printf 'container=%s\n' "$KEYCLOAK_EXPORT_CONTAINER"
  printf 'realm=%s\n' "$KEYCLOAK_EXPORT_REALM"
  printf 'realm_json=%s\n' "$REALM_JSON"
  printf 'user_count=%s\n' "$USER_COUNT"
  printf 'client_count=%s\n' "$CLIENT_COUNT"
  printf 'realm_role_count=%s\n' "$ROLE_COUNT"
  printf 'login_theme=%s\n' "$LOGIN_THEME"
  printf 'master_realm_exported=false\n'
  printf 'contains_secrets=true (client secrets, password hashes, realm key material -- see script header)\n'
} > "$HOST_OUT_DIR/MANIFEST.txt"

log "==> Export complete: $HOST_OUT_DIR"
log "    Manifest: $HOST_OUT_DIR/MANIFEST.txt"
log "    This directory is gitignored (repo-root /backups/). Do not commit it."
exit 0
