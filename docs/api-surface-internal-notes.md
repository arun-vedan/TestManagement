# API surface — internal notes

**Repo-only. Do not move any of this into `backend/*/openapi.yaml`.**

Those spec files are served **unauthenticated** at `/openapi/<service>.yaml` and
`/docs/<service>` through Kong, so anything written in them is public. This file
exists because the notes below are worth keeping and were previously in the
specs themselves.

Found during the 2026-10-11 authorization audit (see `EXECUTION_LOG.md`) and
removed from the published specs on the owner's decision: keep the API docs
public, move the internal-architecture commentary here.

## Why this mattered

The specs described, to anyone who could reach the host, **where the
authentication is thin and how to get around it**. None of it leaked a
credential, and endpoint shapes are discoverable from the frontend anyway — but
telling a stranger which single sub-route has no authentication of its own, and
publishing the address that skips the gateway, is unnecessary generosity to
somebody choosing a target.

Three classes were removed.

### 1. The direct-to-container `servers:` entry (all 8 specs)

Every spec listed a second server:

```yaml
  - url: http://localhost:3001          # the port varied per service
    description: Direct to the container, bypassing Kong (dev/debug only).
```

That advertises an ingress which skips the gateway, and with it every `jwt`
plugin. It was also already wrong by the time it was removed: WP-101 pointed the
black-box suites at Kong, and the published host ports are slated to go
(`backend/docker-compose.yml`), after which these addresses resolve to nothing
from outside the compose network.

The specs now declare only `http://localhost:8000` — Kong, the path every real
consumer uses.

### 2. "A direct-to-service call bypassing Kong gets 403 instead"

Response descriptions across the specs explained that Kong answers `401` for a
missing token while the service itself answers `403`, and which address produces
which.

The underlying fact is still true and still useful to us:

- **Through Kong**: no/invalid bearer token → **401**, rejected by the `jwt`
  plugin; the request never reaches the service.
- **Direct to a container**: → **403**, from the service's own
  `keycloak.protect()`.

Kong and the services disagree on the status code for "no/bad token" by design.
Any consumer-facing documentation should describe only the gateway's behaviour,
because that is the only path a consumer has.

### 3. `POST /api/v1/apikeys/verify` has no `keycloak.protect()` of its own

This was the sharpest disclosure, and it appeared **twice** in
`userService/openapi.yaml` — once in the top-level description and once on the
endpoint.

The fact: `/api/v1/apikeys/verify` is called container-to-container by every
other service's `requireAuth()` middleware, and carries no `keycloak.protect()`.
That is deliberate — **verifying a credential cannot itself require a
credential** — and it is not an open door:

- Kong's strict `apiKeysRoute` `jwt` plugin covers the whole
  `/api/v1/apikeys` prefix, so reaching it through the gateway still needs a
  valid JWT.
- The route has its own `verifyApiKey` middleware.
- An unknown or wrong `(keyId, secret)` pair always returns the same generic
  `{valid: false}`, so it cannot be used as an oracle.

The exposure was never the design; it was publishing "this one sub-route has
zero authentication of its own" alongside the container address that reaches it.

## Standing rule

When writing an `openapi.yaml`, assume an adversary reads it. Document what a
consumer needs in order to call the API correctly. Do not document:

- alternative ingresses, especially any that skip the gateway;
- which middleware is or is not mounted on a given route;
- why a particular route is exempt from a control;
- internal container hostnames or ports.

Any of those belong here, or in a comment in the source file that implements
them.

## Related

- `EXECUTION_LOG.md`, 2026-10-11 — the authorization audit that found this, and
  the tenancy sweep (`backend/userService/__tests__/tenancySweep.test.js`) that
  now checks the boundary empirically on every run.
- `srckube-kong/docker-compose.yml` — the Admin API lockdown, same audit.
- `/healthz/<service>` is also unauthenticated. That is a deliberate WP-061
  decision, its payload is minimal (status, service name, Mongo/Redis
  reachability), and it is recorded here only so the decision stays visible
  rather than being assumed.
