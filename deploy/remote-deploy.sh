#!/usr/bin/env bash
#
# Everything the deploy does ON THE SERVER. Ships in the bundle and is invoked
# by one line of the workflow.
#
# WHY THIS IS A FILE AND NOT INLINE YAML. It was inline, and the step failed
# four times for four different reasons. Two of those were not bugs in the
# logic at all: a multi-line function with a line continuation, and an
# `exec > >(tee ...)` process substitution. Both run correctly under bash on
# this very box -- verified by extracting the step's script and running it as
# the deploy user -- and both died under appleboy/ssh-action, which does not
# execute a multi-line shell construct the way bash does.
#
# So inline shell in that action is reliable only for single, simple lines.
# Anything with a function, a continuation, a redirect of the shell's own
# descriptors, or a heredoc belongs in a file. A file is also testable: this
# script can be run by hand on the server, which is how every one of those
# failures was finally pinned down.
#
# Usage:  remote-deploy.sh <image-tag>
set -euo pipefail

TAG="${1:?usage: remote-deploy.sh <image-tag>}"
cd /opt/vedan

COMPOSE_FILES="-f docker-compose.prod.yml -f docker-compose.edge.yml"
ENV_FILES="--env-file .env --env-file .env.tag --env-file .env.runtime"

# ---------------------------------------------------------------- logging ---
# Bounded: a log nobody prunes becomes the reason a disk fills, and a full
# Docker VM has already taken Kong and MongoDB down on this box once.
if [ -f deploy.log ] && [ "$(stat -c %s deploy.log)" -gt 2000000 ]; then
  tail -c 500000 deploy.log > deploy.log.tmp
  mv -f deploy.log.tmp deploy.log
fi
exec 3>&1
exec >> deploy.log 2>&1
# The tail is echoed back to the caller on the way out, so the Actions output
# still shows what happened. `|| true` because a trap must never be the thing
# that decides a step failed.
trap 'rc=$?; { tail -80 /opt/vedan/deploy.log >&3; } || true; exit $rc' EXIT
set -x

echo "=== $(date -u +%FT%TZ) deploy $TAG ==="

# ------------------------------------------------------------ preflight -----
# .env lives ONLY on the server: it holds the Keycloak client secret, the
# Mongo and Postgres passwords, and the admin credentials.
test -f .env || { echo "FATAL: /opt/vedan/.env is missing"; exit 1; }

echo "IMAGE_TAG=$TAG" > .env.tag

# Must exist before any --env-file reference. Created through a rename, not
# `touch`: touch on an existing file needs write permission on the FILE, and a
# file left behind by root makes it fail -- which is what killed one deploy
# after this file was first created by hand as root. A rename needs write
# permission on the DIRECTORY, which the deploy user owns.
if [ ! -f .env.runtime ]; then
  : > .env.runtime.tmp
  mv -f .env.runtime.tmp .env.runtime
fi

# `sed -n ...p`, not `grep | cut`: a grep that matches nothing exits 1, and
# under `set -o pipefail` that aborts with NO message, which is
# indistinguishable from failing somewhere else entirely.
AUTH_HOST=$(sed -n 's/^AUTH_HOST=//p' .env | head -1 | tr -d '\r')
test -n "$AUTH_HOST" || { echo "FATAL: AUTH_HOST missing from .env"; exit 1; }
ISSUER="https://${AUTH_HOST}/realms/srckube"

# ---------------------------------------------------------------- images ----
# shellcheck disable=SC2086
docker compose $ENV_FILES $COMPOSE_FILES pull --quiet
# shellcheck disable=SC2086
docker compose $ENV_FILES $COMPOSE_FILES up -d --remove-orphans

# ------------------------------------------------- keycloak theme mounts ----
# A bind mount resolves to an INODE when the container starts, and the unpack
# step replaces themes/ and realm/ wholesale, so the new directories are new
# inodes. A container compose did not recreate stays mounted on the directory
# that was DELETED. Keycloak is never recreated, because its configuration
# does not change between deploys -- so it served a theme directory that no
# longer existed, fell back to parent=base, and rendered a login page with no
# form on it. The page was 200 and every file on disk was correct.
#
# Detected by ASKING KEYCLOAK whether it can see its own theme, rather than by
# comparing file hashes before and after the extract. The hash version was
# written as a marker file after the extract, so when the unpack step failed
# *between* replacing themes/ and writing the marker, this script concluded
# "unchanged" and left Keycloak serving the stock login page. A check of the
# real invariant cannot be wrong about it, and it self-heals no matter which
# earlier step failed or was skipped.
if docker exec keycloak test -f /opt/keycloak/themes/kdk/login/login.ftl 2>/dev/null; then
  echo "keycloak can see the kdk theme"
else
  echo "keycloak CANNOT see the kdk theme (stale mount) -- restarting"
  docker restart keycloak
  # Polls $ISSUER, the PUBLIC url, not http://localhost:8080. Production
  # publishes no container ports at all -- generate-prod-compose.py strips
  # every `ports:` so nothing but Traefik binds to the host -- so
  # localhost:8080 on the host is refused outright (curl exit 7). The first
  # version of this loop used it and therefore never checked readiness at
  # all: it just slept the full 50 x (4 + 3) seconds and carried on, which
  # added about six minutes to every deploy that touched the theme and came
  # close to ssh-action's ten-minute command timeout. A readiness check that
  # cannot ever succeed is worse than none, because it looks like one.
  for _ in $(seq 1 50); do
    if curl -fsS --max-time 4 "$ISSUER" >/dev/null 2>&1; then
      break
    fi
    sleep 3
  done
  docker exec keycloak test -f /opt/keycloak/themes/kdk/login/login.ftl \
    || { echo "FATAL: keycloak still cannot see the kdk theme after a restart"; exit 1; }
  echo "theme visible after restart"
fi

# ------------------------------------------------------- the realm's key ----
# Keycloak is started, not necessarily ready: it imports the realm and builds
# its key set on first boot, and the key below does not exist until then.
ready=no
for _ in $(seq 1 40); do
  if curl -fsS --max-time 5 "$ISSUER" >/dev/null 2>&1; then
    ready=yes
    break
  fi
  sleep 3
done
test "$ready" = yes || { echo "FATAL: $ISSUER never became ready"; exit 1; }

# The SAME key is needed in two places and both reject tokens without it.
# Kong validates at the edge; each of the 18 services validates again,
# offline, through keycloak-connect's realm-public-key. Fixing only Kong turns
# 401 into 403 and the app is still unusable -- measured, not predicted.
#
# It cannot be committed: sanitise-realm-export.py strips the realm's
# *KeyProvider components, because publishing a realm's signing material to a
# public repository would be catastrophic. Keycloak therefore mints fresh keys
# when it first imports the realm, so the value only exists from here on.
KEY=$(curl -fsS --max-time 10 "$ISSUER" | python3 -c 'import json,sys; print(json.load(sys.stdin)["public_key"])')
test -n "$KEY" || { echo "FATAL: realm returned no public_key"; exit 1; }

env_before=$(sha256sum .env.runtime | cut -d' ' -f1)
printf 'KEYCLOAK_REALM_PUBLIC_KEY=%s\n' "$KEY" > .env.runtime.tmp
mv -f .env.runtime.tmp .env.runtime
env_after=$(sha256sum .env.runtime | cut -d' ' -f1)

kong_before=$(sha256sum kong.yml | cut -d' ' -f1)
python3 render-kong-jwt.py kong.yml "$ISSUER"
kong_after=$(sha256sum kong.yml | cut -d' ' -f1)

# Re-apply only on a real change. Compose recreates just the containers whose
# configuration differs, so in steady state this does nothing.
if [ "$env_before" != "$env_after" ]; then
  echo "realm public key changed -- re-applying so the services pick it up"
  # shellcheck disable=SC2086
  docker compose $ENV_FILES $COMPOSE_FILES up -d --remove-orphans
else
  echo "realm public key unchanged"
fi

# Kong reads kong.yml once, at boot, so a changed file means nothing until it
# restarts. A restart also re-resolves the bind mount, which is why Kong never
# hit the stale-inode problem above.
if [ "$kong_before" != "$kong_after" ]; then
  docker restart kong
  for _ in $(seq 1 30); do
    if [ "$(docker inspect -f '{{.State.Health.Status}}' kong 2>/dev/null)" = healthy ]; then
      break
    fi
    sleep 2
  done
  docker inspect -f 'kong health: {{.State.Health.Status}}' kong
else
  echo "kong.yml unchanged -- no restart needed"
fi

# Images accumulate at 19 per deploy; an unpruned host fills quietly and then
# nothing starts. Images only -- never volumes, which hold the data.
docker image prune -f --filter "until=168h"

echo "=== $(date -u +%FT%TZ) deploy $TAG complete ==="
