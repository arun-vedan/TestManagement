#!/usr/bin/env python3
"""
Decides whether a Keycloak realm export could actually be restored from.

WHY THIS EXISTS. keycloak-export.sh verifies its own output with `jq`, and on
the production host jq is not installed -- so it printed "skipping automated
content verification" and exited 0. Its own header says not to trust the
export until that check has run, which means the nightly backup would have
been producing files nobody had established were restorable. An unverified
backup is not a backup; it is a file.

`kc.sh export` is also the specific case where exit code means little: it
reports "Export finished successfully" and then exits 1, because the running
server already holds ports 8080/9000. keycloak-export.sh knows that and
treats it as expected. The consequence is that the CONTENT is the only
evidence available.

What is checked, and why each one would be noticed only during a disaster:

  realm, clients, authenticationFlows   absent means the structural import
                                        fails outright
  users                                 an export with zero users restores a
                                        realm nobody can log into; this is the
                                        dangerous silent case, because the file
                                        looks fine and has a plausible size
  password credentials                  users without credentials restore as
                                        accounts that exist and cannot
                                        authenticate. Service accounts legitimately
                                        have none, so they are excluded.

Exits non-zero if the export is not restorable, so the backup fails loudly
rather than accumulating useless files.

Usage: verify-realm-export.py <realm-export.json> [--allow-no-users]
"""

import json
import sys
from pathlib import Path


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    allow_no_users = "--allow-no-users" in sys.argv
    if len(args) != 1:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2

    path = Path(args[0])
    try:
        realm = json.loads(path.read_text())
    except Exception as exc:
        print(f"UNREADABLE: {path}: {exc}", file=sys.stderr)
        return 1

    users = realm.get("users") or []
    # A service account has no password by design; counting it as a credentialled
    # user would hide a realm whose real accounts all lost theirs.
    humans = [u for u in users if not str(u.get("username", "")).startswith("service-account-")]
    with_creds = [u for u in humans if u.get("credentials")]

    print(f"  realm            {realm.get('realm')}")
    print(f"  loginTheme       {realm.get('loginTheme')}")
    print(f"  clients          {len(realm.get('clients') or [])}")
    print(f"  realm roles      {len((realm.get('roles') or {}).get('realm') or [])}")
    print(f"  auth flows       {len(realm.get('authenticationFlows') or [])}")
    print(f"  required actions {len(realm.get('requiredActions') or [])}")
    print(f"  users            {len(users)} ({len(humans)} non-service)")
    print(f"  with credentials {len(with_creds)} of {len(humans)} non-service users")

    problems = []
    for key in ("realm", "clients", "authenticationFlows"):
        if not realm.get(key):
            problems.append(f"missing {key}")
    if not users and not allow_no_users:
        problems.append("zero users -- a restore would lose every account")
    if humans and not with_creds:
        problems.append("no user has password credentials -- restored accounts could not log in")

    if problems:
        print("  VERDICT: NOT RESTORABLE")
        for p in problems:
            print(f"    - {p}")
        return 1

    print("  VERDICT: restorable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
