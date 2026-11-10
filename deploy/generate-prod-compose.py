#!/usr/bin/env python3
"""
Generates deploy/docker-compose.prod.yml from the three development compose
files.

WHY GENERATED, NOT HAND-WRITTEN. There are 24 services. A hand-maintained
production copy drifts from the development one the first time somebody adds
an environment variable to a service and only edits one file — and the drift
is invisible until that service misbehaves in production only. Transforming
the real files means the two cannot disagree about what a service needs; they
can only disagree about the things this script deliberately changes, which are
listed below and nowhere else.

Re-run it after changing any dev compose file, and commit the result.

WHAT IT CHANGES, and why each one matters:

  build: -> image:       Production pulls prebuilt images from GHCR. The VPS
                         has 2 vCPU and no source tree; building 18 Node
                         images and a CRA bundle there would take tens of
                         minutes and can OOM mid-deploy, taking the running
                         site down with it.

  ports: removed         20 services publish ports to the host in dev,
                         including MongoDB on 27017. On a public IP an
                         exposed Mongo is found by scanners within hours.
                         Only Traefik binds to the host in production;
                         everything else talks over the internal network.

  mem_limit added        Nothing is capped today. MongoDB sizes its WiredTiger
                         cache at half of (RAM - 1GB) — about 3.5 GB on this
                         7.7 GB box — and the JVM takes a quarter of RAM for
                         its heap. Together they can exhaust the machine
                         before the application services start. These are
                         CEILINGS, not reservations: the sum exceeds physical
                         RAM on purpose, because actual usage is ~3.2 GB and
                         the point is to stop any one container running away.

  KeyCloak_URI rewritten 18 services hardcode http://localhost:8080. Inside a
                         container that is the container itself. It is the
                         token ISSUER, so in production it has to be the
                         public HTTPS URL or every token fails validation.
                         KeyCloak_Admin_URI stays internal — that one is a
                         real server-to-server call.

  KeyCloak_publicKey     18 services hardcode the dev realm's public key and
                         validate every token against it offline. The
                         production realm's keys are generated on its first
                         boot and cannot be committed, so this becomes an
                         environment variable the deploy fills in.

  restart: unless-stopped so a reboot brings the stack back without anyone
                         logging in.
"""

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "deploy" / "docker-compose.prod.yml"

SOURCES = [
    ROOT / "backend" / "docker-compose.yml",
    ROOT / "keycloak-themes" / "docker-compose.yml",
    ROOT / "srckube-kong" / "docker-compose.yml",
]

REGISTRY = "ghcr.io/arun-vedan/testmanagement"

# Ceilings, not reservations. Measured idle usage in brackets.
MEM_LIMITS = {
    "mongodb": "1536m",   # [361m] cache pinned to 1G below
    "keycloak": "1024m",  # [754m] heap pinned to 768m below
    "kong": "768m",       # [621m]
    "postgres": "384m",
    "redis": "256m",
    "traefik": "128m",
    "frontend": "128m",
}
DEFAULT_SERVICE_MEM = "256m"  # Node services idle at ~85m

# Credential env vars -> the variable the server's .env supplies.
# KC_DB_PASSWORD and POSTGRES_PASSWORD are deliberately the SAME variable:
# Keycloak authenticates to Postgres as that user, so two separate values can
# only ever be equal or broken, and two names is how they drift apart.
CREDENTIAL_VARS = {
    "POSTGRES_PASSWORD": "${POSTGRES_PASSWORD}",
    "KC_DB_PASSWORD": "${POSTGRES_PASSWORD}",
    "KC_BOOTSTRAP_ADMIN_USERNAME": "${KEYCLOAK_ADMIN}",
    "KC_BOOTSTRAP_ADMIN_PASSWORD": "${KEYCLOAK_ADMIN_PASSWORD}",
}

# Matches env var NAMES that hold secrets. Deliberately not a bare "KEY":
# KeyCloak_clientId, KeyCloak_Realm and KeyCloak_publicKey all contain "key"
# and none of them is secret. A guard that fires on those gets switched off.
SECRET_NAME_RE = re.compile(r"(PASSWORD|PASSWD|SECRET|_TOKEN|APIKEY|API_KEY)", re.I)


def transform(name: str, svc: dict) -> dict:
    # Prebuilt image instead of a build context.
    if "build" in svc:
        svc.pop("build")
        svc["image"] = f"{REGISTRY}/{name}:${{IMAGE_TAG:-latest}}"

    # Nothing but Traefik binds to the host.
    svc.pop("ports", None)

    svc.setdefault("restart", "unless-stopped")

    # Credentials must come from the server's .env, never from this file.
    # They were literals: the Keycloak admin password, the Postgres password
    # (committed twice, as POSTGRES_PASSWORD and KC_DB_PASSWORD), and a Kong
    # one. This repository is PUBLIC and the Keycloak admin console answers on
    # the internet at https://<AUTH_HOST>/admin, so a committed admin password
    # is a realm takeover waiting to be read. They originate in the dev compose
    # files, where localhost makes them merely untidy, and this script was
    # copying them straight into the production file.
    for key, var in CREDENTIAL_VARS.items():
        if key in (env if isinstance(env := svc.get("environment"), dict) else {}):
            env[key] = var

    # KONG_DATABASE is off: Kong runs DB-less from kong.yml, so this password
    # is never read by anything. Dead config that still reads as a credential
    # is worse than no config, because the next person has to work out which.
    if name == "kong":
        (svc.get("environment") or {}).pop("KONG_PG_PASSWORD", None)
    svc["mem_limit"] = MEM_LIMITS.get(name, DEFAULT_SERVICE_MEM)

    env = svc.get("environment")
    if isinstance(env, dict):
        # The issuer must be the public URL; the admin call stays internal.
        if "KeyCloak_URI" in env:
            env["KeyCloak_URI"] = "${KEYCLOAK_PUBLIC_URL}"
        if "KeyCloak_Admin_URI" in env:
            env["KeyCloak_Admin_URI"] = "http://keycloak:8080"
        # Every service validates tokens OFFLINE against this key, via
        # keycloak-connect's realm-public-key. All 18 of them hardcode the
        # development realm's key, and the production realm's key is a
        # different one: sanitise-realm-export.py strips the realm's
        # *KeyProvider components (a realm's signing material must never be
        # committed), so Keycloak mints fresh keys when it first imports the
        # realm. A stale key here is not a soft failure — keycloak-connect
        # rejects every token with 403 "Access denied", which is exactly what
        # production did: login succeeded, the dashboard rendered, and all
        # eight of its API calls were refused. deploy.yml fetches the real
        # value from the running realm and writes it to .env.runtime.
        if "KeyCloak_publicKey" in env:
            env["KeyCloak_publicKey"] = "${KEYCLOAK_REALM_PUBLIC_KEY}"

    return svc


def main() -> int:
    merged: dict = {}
    volumes: dict = {}
    for src in SOURCES:
        if not src.exists():
            print(f"missing source: {src}", file=sys.stderr)
            return 1
        data = yaml.safe_load(src.read_text()) or {}
        for name, svc in (data.get("services") or {}).items():
            if name in merged:
                print(f"duplicate service '{name}' across compose files", file=sys.stderr)
                return 1
            merged[name] = transform(name, svc or {})
        # Named volumes must come across too, or compose refuses the project
        # with "refers to undefined volume". Declared across three files, so
        # they are merged the same way the services are.
        for vname, vdef in (data.get("volumes") or {}).items():
            volumes.setdefault(vname, vdef)

    # Pin the two memory-hungry runtimes at the process level, not just the
    # container level. A container limit alone makes the kernel kill them;
    # telling the runtime its own budget makes them behave instead.
    if "mongodb" in merged:
        merged["mongodb"]["command"] = [
            "mongod", "--wiredTigerCacheSizeGB", "1", "--bind_ip_all",
        ]
    if "keycloak" in merged:
        kc = merged["keycloak"]
        kcenv = kc.setdefault("environment", {})
        if isinstance(kcenv, dict):
            kcenv["JAVA_OPTS_APPEND"] = "-Xms256m -Xmx768m"

    out = {
        "services": merged,
        "volumes": volumes,
        "networks": {"src-kube-network": {"external": True}},
    }

    # Refuse to write a credential into a public repository. The same reason
    # sanitise-realm-export.py refuses: a transformation that is trusted and
    # silently incomplete is more dangerous than none at all.
    leaks = []
    for sname, svc in merged.items():
        for k, v in (svc.get("environment") or {}).items():
            if SECRET_NAME_RE.search(k) and isinstance(v, str) and v and not v.startswith("${"):
                leaks.append(f"{sname}.{k}")
    if leaks:
        print("REFUSING TO WRITE — credential literals would be committed:", file=sys.stderr)
        for leak in leaks:
            print(f"  {leak}", file=sys.stderr)
        print("Add it to CREDENTIAL_VARS and supply it from the server's .env.", file=sys.stderr)
        return 1

    header = (
        "# GENERATED by deploy/generate-prod-compose.py — DO NOT EDIT BY HAND.\n"
        "# Re-run that script after changing any development compose file.\n"
        "# It explains every transformation and why each one is needed.\n"
        "#\n"
        "# This file alone is not the whole deployment: Traefik, the frontend\n"
        "# image and the routing labels live in docker-compose.edge.yml, which is\n"
        "# hand-written because it has no development counterpart to drift from.\n\n"
    )
    OUT.write_text(header + yaml.safe_dump(out, sort_keys=False, width=100))
    print(f"wrote {OUT.relative_to(ROOT)}  ({len(merged)} services)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
