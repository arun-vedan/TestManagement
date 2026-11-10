#!/usr/bin/env python3
"""
Turns a Keycloak realm export into something safe to commit and import.

WHY THIS EXISTS. WP-151: a fresh clone cannot boot. The only realm exports
live under gitignored /backups/, and README.md describes days of manual
admin-console work to recreate the realm by hand. Committing an export fixes
that — but a raw export is one of the most sensitive files this project can
produce, so it cannot simply be copied in.

WHAT A RAW EXPORT CONTAINS, measured rather than assumed. Keycloak's
partial-export is documented as excluding users, and on this realm it did
not: it carried a user, four KeyProvider components (the realm's RSA and AES
signing material), the node-microservice client secret, and the SMTP
password. Committing that would have published the realm's signing keys to a
public repository.

WHAT IS REMOVED, and why each one:

  users            Real people and test personas. Also the point of the
                   exercise: a fresh environment should start empty, not
                   inherit someone's account.
  components       KeyProvider entries hold the realm's signing and
                   encryption keys. Keycloak regenerates them on first boot
                   of a fresh realm, so removing them loses nothing and
                   publishing them would be catastrophic.
  client secrets   Replaced with a placeholder the import resolves from the
                   environment. A committed client secret is a credential in
                   git, which is exactly what this migration was trying to
                   escape.
  smtpServer       The password, specifically. The rest of the SMTP config is
                   not secret, but it is environment-specific, so the whole
                   block goes and configure-keycloak-email.js puts it back.
  identityProviders Google's client secret would live here. None configured
                   yet; removed anyway so it cannot appear later by accident.

WHAT IS KEPT: clients, roles, groups, authentication flows, required actions,
and the realm settings that took real work to get right — the registration
flow with always_set_password_on_register_form, the terms required action,
and the first-broker-login hardening that disables email-based account
linking.
"""

import json
import sys
from pathlib import Path

PLACEHOLDER = "${KEYCLOAK_SECRET}"


def sanitise(realm: dict) -> tuple[dict, list[str]]:
    removed: list[str] = []

    n = len(realm.pop("users", []) or [])
    if n:
        removed.append(f"users: {n}")

    comps = realm.get("components") or {}
    for key in list(comps):
        if key.endswith("KeyProvider"):
            removed.append(f"components[{key.split('.')[-1]}]: {len(comps[key])}")
            comps.pop(key)
    if not comps:
        realm.pop("components", None)

    secrets = 0
    for client in realm.get("clients") or []:
        if client.get("secret"):
            client["secret"] = PLACEHOLDER
            secrets += 1
        # Registration access tokens are bearer credentials in their own right.
        client.pop("registrationAccessToken", None)
    if secrets:
        removed.append(f"client secrets replaced: {secrets}")

    if realm.pop("smtpServer", None):
        removed.append("smtpServer (incl. password)")

    n = len(realm.pop("identityProviders", []) or [])
    removed.append(f"identityProviders: {n}")
    realm.pop("identityProviderMappers", None)

    # Ids tie the export to the instance it came from; a fresh import should
    # mint its own rather than collide with an existing realm.
    realm.pop("id", None)

    return realm, removed


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: sanitise-realm-export.py <raw-export.json> <output.json>", file=sys.stderr)
        return 2

    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    realm = json.loads(src.read_text())
    realm, removed = sanitise(realm)

    out = json.dumps(realm, indent=2, sort_keys=True)

    # Refuse to write anything that still looks like a credential. A sanitiser
    # that silently misses something is worse than none, because it is trusted.
    #
    # Checks KEY NAMES, not a substring of the whole document. The first
    # version matched any occurrence of "password" and refused on
    # `always_set_password_on_register_form` (the WP-137 setting, which must
    # be KEPT) and on fourteen webAuthnPolicyPasswordless* flags. A guard that
    # cries wolf gets disabled, so it has to be exact.
    def offending(node, path=""):
        if isinstance(node, dict):
            for k, v in node.items():
                kl = k.lower()
                is_secret_key = kl in ("secret", "privatekey", "registrationaccesstoken") or (
                    kl == "password" and "smtp" in path.lower()
                )
                if is_secret_key and isinstance(v, str) and v and v != PLACEHOLDER:
                    yield f"{path}.{k}"
                yield from offending(v, f"{path}.{k}")
        elif isinstance(node, list):
            for item in node:
                yield from offending(item, f"{path}[]")

    leaks = list(offending(realm))
    if leaks:
        print("REFUSING TO WRITE — credential-bearing keys survived:", file=sys.stderr)
        for leak in leaks:
            print(f"  {leak}", file=sys.stderr)
        return 1

    dst.write_text(out + "\n")
    print(f"wrote {dst}")
    for r in removed:
        print(f"  removed {r}")
    print(f"  kept: {len(realm.get('clients') or [])} clients, "
          f"{len(realm.get('authenticationFlows') or [])} auth flows, "
          f"{len(realm.get('requiredActions') or [])} required actions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
