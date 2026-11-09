#!/usr/bin/env bash
# seed-id-counters.sh -- seed WP-020c's atomic id counters from existing data.
#
# WHY THIS EXISTS
# WP-020c replaced read-then-write id generation (findOne().sort({id:-1})
# then +1 against a unique index, which raced under concurrency and caused a
# ~50% test-suite flake) with an atomic `counters` collection per service
# database, via service-core's getNextSequence().
#
# That fix is only safe if each counter starts at or above the highest id
# already present. On a database that already has documents but no counters,
# getNextSequence() hands out 1, 2, 3... and every insert collides with an
# existing document. service-core exports seedSequenceIfAbsent(), but nothing
# calls it at startup -- so seeding is a deployment step, and this is it.
#
# Run ONCE against any environment holding pre-existing data, at the same
# time as deploying the WP-020c change.
#
# Usage:
#   MONGO_ROOT_USER=... MONGO_ROOT_PASS=... ./scripts/seed-id-counters.sh
#   MONGO_ROOT_USER=... MONGO_ROOT_PASS=... ./scripts/seed-id-counters.sh --apply
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
MONGO_CONTAINER="${MONGO_CONTAINER:-mongodb}"
: "${MONGO_ROOT_USER:?set MONGO_ROOT_USER}"
: "${MONGO_ROOT_PASS:?set MONGO_ROOT_PASS}"
echo "seed-id-counters: mode=$([ $APPLY -eq 1 ] && echo APPLY || echo 'DRY RUN (pass --apply to write)')"
docker exec -i -e "MONGOSH_APPLY=$APPLY" "$MONGO_CONTAINER" \
  mongosh --quiet -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASS" \
  --authenticationDatabase admin < "$REPO_ROOT/scripts/lib/seed-id-counters.js"
