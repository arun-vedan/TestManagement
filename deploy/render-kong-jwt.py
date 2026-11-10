#!/usr/bin/env python3
"""
Points Kong's JWT credential at the realm that is actually running.

WHY THIS EXISTS. Kong validates every API token itself, in DB-less mode, using
one credential committed in srckube-kong/kong.yml. That credential hardcodes
two things that are both WRONG in production, and neither is noticed until a
real person signs in:

  key: http://localhost:8080/realms/srckube
      Kong's jwt plugin looks the credential up BY THE TOKEN'S `iss` CLAIM.
      Production tokens are issued by https://auth.vedan.io/realms/srckube, so
      no credential matches and Kong rejects the request. Measured: the login
      itself succeeded, the app shell rendered, and every single API call
      behind it returned 401.

  rsa_public_key
      The dev realm's signing key. It cannot be committed for production,
      because sanitise-realm-export.py deliberately strips the realm's
      *KeyProvider components — publishing a realm's signing material to a
      public repository would be catastrophic. Keycloak therefore MINTS NEW
      KEYS the first time it imports the realm, and those keys do not exist
      until that moment. There is nothing to commit; the value can only be
      discovered at deploy time, which is why this runs then.

So the 401s were not a misconfiguration to be corrected once. They are the
standing consequence of two deliberate decisions, and they come back every
time the realm is recreated. This script closes that gap as a deploy step.

It rewrites the file in place, by targeted text substitution rather than
through a YAML round-trip: kong.yml carries several hundred lines of comments
explaining why individual routes are shaped as they are, and yaml.safe_dump
would silently delete all of them.

Usage:
    render-kong-jwt.py <kong.yml> <issuer-url>

e.g. render-kong-jwt.py /opt/vedan/kong.yml https://auth.vedan.io/realms/srckube
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

CONSUMER = "keycloak-srckube"


def fetch_public_key(issuer: str) -> str:
    """The realm's active RS256 public key, as bare base64."""
    with urllib.request.urlopen(issuer, timeout=20) as r:
        body = json.load(r)
    key = (body.get("public_key") or "").strip()
    if not key:
        raise SystemExit(f"{issuer} returned no public_key field")
    return key


def pem(key_b64: str, indent: str) -> str:
    lines = [f"{indent}-----BEGIN PUBLIC KEY-----"]
    lines += [indent + key_b64[i:i + 64] for i in range(0, len(key_b64), 64)]
    lines.append(f"{indent}-----END PUBLIC KEY-----")
    return "\n".join(lines)


def render(text: str, issuer: str, key_b64: str) -> str:
    # Scope every edit to this one consumer. kong.yml defines a second
    # consumer (apikeys-anonymous) and ~20 jwt plugin blocks; an unscoped
    # substitution would be a coin toss over which one it hit.
    start = text.find(f"- username: {CONSUMER}")
    if start < 0:
        raise SystemExit(f"consumer '{CONSUMER}' not found — kong.yml has changed shape")

    # The consumer ends at the next top-level list item or mapping key.
    rest = text[start + 1:]
    m = re.search(r"^(?:- |\w)", rest, re.M)
    end = start + 1 + (m.start() if m else len(rest))
    block, before, after = text[start:end], text[:start], text[end:]

    # 1. The lookup key must equal the issuer Keycloak actually stamps.
    block, n = re.subn(r"(?m)^(\s*- key: ).*$", lambda mo: mo.group(1) + issuer, block)
    if n != 1:
        raise SystemExit(f"expected exactly 1 'key:' in the {CONSUMER} credential, found {n}")

    # 2. The public key must be the one the running realm signs with.
    km = re.search(r"(?m)^(\s*)rsa_public_key: \|\s*\n((?:[ \t]+.*\n?)+)", block)
    if not km:
        raise SystemExit("rsa_public_key block scalar not found")
    body_indent = re.match(r"[ \t]*", km.group(2)).group(0) or (km.group(1) + "  ")
    block = block[:km.start()] + f"{km.group(1)}rsa_public_key: |\n" + pem(key_b64, body_indent) + "\n" + block[km.end():]

    return before + block + after


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip().split("Usage:")[-1], file=sys.stderr)
        return 2
    path, issuer = Path(sys.argv[1]), sys.argv[2].rstrip("/")

    key_b64 = fetch_public_key(issuer)
    original = path.read_text()
    updated = render(original, issuer, key_b64)

    if updated == original:
        print(f"{path}: already pointed at {issuer} with the current key")
        return 0

    path.write_text(updated)
    print(f"{path}: JWT credential repointed")
    print(f"  issuer     {issuer}")
    print(f"  public key {key_b64[:24]}… ({len(key_b64)} chars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
