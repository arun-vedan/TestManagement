#!/usr/bin/env bash
# wip-snapshot.sh -- commit any uncommitted work as a clearly-labelled WIP
# commit, so an abrupt stop (session/rate limit, crash) can never lose it.
#
# WHY THIS EXISTS
# This project's agents have repeatedly been terminated mid-task by hard
# account rate limits, with no warning and no way to poll remaining quota --
# the limit only surfaces as an HTTP 429 at the moment it hits. Several
# agents died holding substantial uncommitted work; one batch of three lost
# nothing only because the orchestrator manually reconstructed and committed
# it afterwards.
#
# The fix is not to predict the limit (impossible) but to make an
# interruption survivable: snapshot early, snapshot often. A messy WIP commit
# is trivially cleaned up later; unrecoverable work is not.
#
# Usage:
#   ./scripts/wip-snapshot.sh                 # snapshot everything uncommitted
#   ./scripts/wip-snapshot.sh "WP-040 aggregates half done"
#
# Safe by design:
#   - never rewrites history, never resets, never stashes, never force-pushes
#   - never commits config.env / .env.test / backend/.env (gitignored anyway)
#   - exits 0 doing nothing when the tree is already clean
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NOTE="${1:-}"
if [ -z "$(git status --porcelain)" ]; then
  echo "wip-snapshot: tree already clean, nothing to snapshot."
  exit 0
fi

echo "wip-snapshot: uncommitted paths:"
git status --short | sed 's/^/  /'

git add -A
MSG="WIP snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ -n "$NOTE" ] && MSG="$MSG -- $NOTE"

git commit -q -m "$MSG

Automatic safety snapshot from scripts/wip-snapshot.sh. This is NOT a
reviewed change: it captures whatever was in the working tree so that an
abrupt interruption (hard account rate limit, crash) cannot lose it.

Squash, amend or split this into proper commits when the work is finished.
If the work turned out to be unwanted, revert this commit -- do not reset,
per GR-2."

echo "wip-snapshot: committed $(git rev-parse --short HEAD)"
