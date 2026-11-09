#!/usr/bin/env bash
#
# run-api-tests.sh (WP-002)
#
# Runs every __tests__ suite in the repo (discovered dynamically, not
# hardcoded) against the LIVE compose stack. This is the local/manual
# verification path for the black-box HTTP suites (Jest + axios against a
# real running service, per GR-6), because no CI runner with
# docker-in-docker/service capability was ever established for this
# project —
# so unlike backend/shared/service-core's pure unit tests, the black-box
# suites are NOT run in CI today and this script is the substitute
# verification step every WP should run before claiming done.
#
# What it does, in order:
#   1. Fail fast if Kong and Keycloak aren't reachable (clear message, no
#      confusing mid-suite auth errors).
#   2. Fail fast if TEST_KEYCLOAK_CLIENT_SECRET isn't resolvable (already
#      exported, or loadable from repo-root .env.test).
#   3. Dynamically discover every __tests__ directory under the repo
#      (excluding node_modules and automationFramework, matching the
#      convention used by scripts/check-requires.js and the existing
#      backend-syntax-check CI job).
#   4. Run `npm test` in each suite's package root, in turn, capturing its
#      output so it can be scanned for HTTP 429 evidence afterward.
#   5. Print a summary and exit non-zero if any suite failed.
#
# WP-002c — HTTP 429 (rate limit) detection:
#   backend/shared/service-core/security.js's per-service rate limiter
#   defaults to 100 requests / 10 min in production; RATE_LIMIT_MAX
#   (backend/.env) raises that ceiling for local/test but running this
#   script repeatedly inside a short window can still exhaust it. A tripped
#   limiter returns HTTP 429, which reads as a wall of assertion failures —
#   easily and dangerously mistaken for a real code regression (or,
#   worse, "fixed" by a lucky re-run that isn't actually proof of anything).
#   So every suite's output is scanned for 429 evidence after it runs. If
#   any is found, this script prints an unambiguous "rate limited, not a
#   code failure" banner naming the affected suite(s) and still exits
#   non-zero — a 429 makes the run INCONCLUSIVE, not a pass, and this
#   script does NOT auto-retry. The operator must restart the affected
#   container(s) (`docker compose -f backend/docker-compose.yml restart
#   <service>`) and re-run manually.
#
# Usage: ./scripts/run-api-tests.sh
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

KONG_URL="${KONG_URL:-http://localhost:8000}"
KEYCLOAK_URL="${TEST_KEYCLOAK_URL:-http://localhost:8080}"
KEYCLOAK_REALM="${TEST_KEYCLOAK_REALM:-srckube}"

log()  { printf '%s\n' "$*"; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# 1. Stack reachability
# ---------------------------------------------------------------------------
log "==> Checking that the live stack is reachable..."

if ! curl -s -o /dev/null --max-time 5 "$KONG_URL/api/v1/requirement"; then
  err "Kong (${KONG_URL}) is not reachable."
  err "Start the backend compose stack first, e.g.:"
  err "  docker compose -f backend/docker-compose.yml up -d"
  err "  (and the srckube-kong / keycloak-themes compose stacks, if not already up)"
  exit 1
fi
log "    Kong is reachable at ${KONG_URL}."

if ! curl -s -o /dev/null --max-time 5 "$KEYCLOAK_URL/realms/${KEYCLOAK_REALM}"; then
  err "Keycloak (${KEYCLOAK_URL}, realm '${KEYCLOAK_REALM}') is not reachable."
  err "Start the Keycloak compose stack first (see keycloak-themes/docker-compose.yml)."
  exit 1
fi
log "    Keycloak is reachable at ${KEYCLOAK_URL}."

# ---------------------------------------------------------------------------
# 2. Test credentials
# ---------------------------------------------------------------------------
log "==> Checking test credentials..."

if [ -z "${TEST_KEYCLOAK_CLIENT_SECRET:-}" ] && [ -f "$REPO_ROOT/.env.test" ]; then
  set -a
  # shellcheck disable=SC1090,SC1091
  source "$REPO_ROOT/.env.test"
  set +a
fi

if [ -z "${TEST_KEYCLOAK_CLIENT_SECRET:-}" ]; then
  err "TEST_KEYCLOAK_CLIENT_SECRET is not set and could not be loaded from .env.test."
  err "Copy .env.test.example (repo root) to .env.test and fill in the real Keycloak"
  err "client secret for the 'node-microservice' service account (realm: ${KEYCLOAK_REALM}),"
  err "or export TEST_KEYCLOAK_CLIENT_SECRET directly in your shell/CI."
  exit 1
fi
log "    TEST_KEYCLOAK_CLIENT_SECRET is set."
export TEST_KEYCLOAK_CLIENT_SECRET

# ---------------------------------------------------------------------------
# 3. Discover suites dynamically (no hardcoded list)
# ---------------------------------------------------------------------------
log "==> Discovering __tests__ suites..."

find_pkg_root() {
  # Walk up from $1 until a package.json is found, or we hit the repo root.
  local d="$1"
  while [ "$d" != "$REPO_ROOT" ] && [ "$d" != "/" ] && [ "$d" != "." ]; do
    if [ -f "$d/package.json" ]; then
      printf '%s\n' "$d"
      return 0
    fi
    d="$(dirname "$d")"
  done
  if [ -f "$REPO_ROOT/package.json" ] && [ "$d" = "$REPO_ROOT" ]; then
    printf '%s\n' "$REPO_ROOT"
    return 0
  fi
  return 1
}

PKG_ROOTS_FILE="$(mktemp)"
trap 'rm -f "$PKG_ROOTS_FILE"' EXIT

find "$REPO_ROOT" -type d -name "__tests__" \
    -not -path "*/node_modules/*" \
    -not -path "*/automationFramework/*" \
  | sort \
  | while IFS= read -r test_dir; do
      pkg_root="$(find_pkg_root "$(dirname "$test_dir")")"
      if [ -z "$pkg_root" ]; then
        err "Could not find a package.json above ${test_dir}, skipping."
        continue
      fi
      printf '%s\n' "$pkg_root"
    done \
  | sort -u > "$PKG_ROOTS_FILE"

SUITE_COUNT=$(wc -l < "$PKG_ROOTS_FILE" | tr -d ' ')
if [ "$SUITE_COUNT" -eq 0 ]; then
  err "No __tests__ directories found under ${REPO_ROOT}. Nothing to run."
  exit 1
fi
log "    Found ${SUITE_COUNT} suite(s):"
while IFS= read -r pkg_root; do
  log "      - ${pkg_root#"$REPO_ROOT"/}"
done < "$PKG_ROOTS_FILE"

# ---------------------------------------------------------------------------
# 4. Run each suite
# ---------------------------------------------------------------------------
FAILED_FILE="$(mktemp)"
RATE_LIMITED_FILE="$(mktemp)"
SUITE_OUT_DIR="$(mktemp -d)"
trap 'rm -f "$PKG_ROOTS_FILE" "$FAILED_FILE" "$RATE_LIMITED_FILE"; rm -rf "$SUITE_OUT_DIR"' EXIT
PASS_COUNT=0
FAIL_COUNT=0

# Deliberately NOT a bare "429" match: Jest's own suite-timing summary line
# ("Time: 0.429 s") and slow-test duration annotations ("(429 ms)") contain
# that exact digit sequence too, and a naive numeric match false-positives on
# them (confirmed empirically while building this script — see
# EXECUTION_LOG.md's WP-002c entry). Instead, match the two forms 429
# evidence actually takes in this suite's output:
#   1. Jest's own failure-diff format for `expect(resp.status).toBe(200)`
#      (or similar) against a real 429 response: "Received: 429".
#   2. express-rate-limit's literal default response body, verified via a
#      live instance: "Too many requests, please try again later."
RATE_LIMIT_PATTERN='Received: *429\b|[Tt]oo [Mm]any [Rr]equests'

while IFS= read -r pkg_root; do
  rel="${pkg_root#"$REPO_ROOT"/}"
  log ""
  log "==> Running suite: ${rel}"
  suite_out="${SUITE_OUT_DIR}/$(printf '%s' "$rel" | tr '/' '_').log"
  # set -o pipefail (already set above) makes this if's status the exit
  # status of `npm test`, not of `tee` — output is captured for the 429
  # scan below without hiding it from the operator's terminal.
  # CI=true is mandatory here, not cosmetic. Suites are discovered by
  # scanning for every __tests__ directory in the repo, which now includes
  # frontend ones (WP-042 added Components/charts/__tests__). The frontend's
  # `npm test` is `craco test`, and without CI=true that launches Jest's
  # INTERACTIVE WATCH MODE, which never exits -- silently hanging this whole
  # script rather than failing it. Found 2026-08-30 after run-api-tests.sh
  # started timing out at 10+ minutes. CI=true also makes CRA treat lint
  # warnings as errors, matching what the frontend-build CI job
  # does, so a suite passing here means the same thing it means in CI.
  if (cd "$pkg_root" && CI=true npm test --silent) 2>&1 | tee "$suite_out"; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '%s\n' "$rel" >> "$FAILED_FILE"
  fi

  if grep -Eq "$RATE_LIMIT_PATTERN" "$suite_out"; then
    printf '%s\n' "$rel" >> "$RATE_LIMITED_FILE"
  fi
done < "$PKG_ROOTS_FILE"

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
RATE_LIMITED_COUNT=$(wc -l < "$RATE_LIMITED_FILE" | tr -d ' ')

log ""
log "==================================================================="
log "run-api-tests.sh summary: ${PASS_COUNT} suite(s) passed, ${FAIL_COUNT} suite(s) failed."
if [ "$FAIL_COUNT" -gt 0 ]; then
  log "Failed suites:"
  while IFS= read -r f; do
    log "  - ${f}"
  done < "$FAILED_FILE"
fi

if [ "$RATE_LIMITED_COUNT" -gt 0 ]; then
  log "==================================================================="
  log "RATE LIMITED — NOT A CODE FAILURE."
  log "${RATE_LIMITED_COUNT} suite(s) show HTTP 429 evidence in their output:"
  while IFS= read -r f; do
    log "  - ${f}"
  done < "$RATE_LIMITED_FILE"
  log ""
  log "HTTP 429 means express-rate-limit tripped, not that application code"
  log "is broken. This run is INCONCLUSIVE either way — a 429 is not proof"
  log "of a passing suite any more than it is proof of a failing one, and a"
  log "later green re-run does not retroactively validate this one."
  log ""
  log "Do NOT re-run in a loop hoping for a clean pass, and do NOT dismiss"
  log "any non-429 failures above as \"probably also just rate limiting\"."
  log "Fix: restart the affected service container(s), e.g.:"
  log "  docker compose -f backend/docker-compose.yml restart <service>"
  log "then re-run this script by hand. This script never auto-retries."
  log "==================================================================="
  exit 1
fi

if [ "$FAIL_COUNT" -gt 0 ]; then
  log "==================================================================="
  exit 1
fi
log "==================================================================="
exit 0
