# srckubetest — Test Management Platform

A self-hosted test management application: React frontend, Kong API gateway, Keycloak
identity provider, and 14 Node.js/Express microservices (MongoDB + Redis) covering
requirements, test cases, test plans, test execution, defects, and supporting
services (comments, links, attachments, custom fields, automation scripts).

See [`ENTERPRISE_TRANSFORMATION_STRATEGY.md`](ENTERPRISE_TRANSFORMATION_STRATEGY.md)
for a full architecture assessment and transformation roadmap, and
[`TRANSFORMATION_KICKOFF_PLAN.md`](TRANSFORMATION_KICKOFF_PLAN.md) for the sprint-by-sprint
execution plan currently in progress.

## Architecture

```text
frontend/        React 18 + TypeScript SPA (CRA/CRACO), MUI, Keycloak-authenticated
srckube-kong/    Kong 3.4 API gateway (declarative config in kong.yml)
keycloak-themes/ Self-hosted Keycloak + Postgres, vendored Kalisio login themes
backend/
  automationService/    Versioned automation scripts (embedded Cucumber/Gherkin editor backend)
  commentsService/      Polymorphic comments
  defectService/        Defects
  fieldsService/        Custom/dynamic field definitions
  folderService/        Folder hierarchy
  linkIssueService/     Bidirectional links between tracked items
  moduleService/        Top-level module grouping
  objectRepo/            UI element locator store (for automation)
  requirementService/   Requirements
  testExecutionService/ Test runs
  testPlanService/       Test plans
  testRepoService/       Canonical test case repository
  uploadService/         GridFS file attachments
  userService/            Users + Keycloak admin-API proxy
```

All backend services are gatewayed through Kong at `/api/v1/<resource>`. The frontend
talks only to the gateway (`REACT_APP_API_BASE_URL`), never directly to a service.

## Local development setup

Requires Docker Desktop and Node 18+.

### 1. Create the shared Docker network (one-time)

```bash
docker network create src-kube-network
```

### 2. Start Keycloak (identity provider)

```bash
cd keycloak-themes
docker compose up -d
```

Wait for `docker logs keycloak` to report `Keycloak ... started`. Admin console:
`http://localhost:8080` (admin / see `keycloak-themes/docker-compose.yml` for the
current password — do not commit real credentials here). The `srckube` realm and
`node-microservice` client must exist before the backend services will accept
tokens; if starting from a blank Postgres volume, you'll need to create the realm
and client yourself (no realm-export file is currently checked into this repo — see
the strategy doc's Section 10 for why this is flagged as a gap).

### 3. Start the API gateway

```bash
cd srckube-kong
docker compose up -d
```

Proxy: `http://localhost:8000`.

The Kong **Admin API is not published** (WP-101). It binds to the container's
loopback, because it requires no authentication and, in DB-less mode, a single
`POST /config` replaces the entire gateway configuration — an unauthenticated
caller able to reach it could strip every `jwt` plugin and leave all services
anonymous. Kong Manager (`8002`) and the TLS admin listener (`8444`) are
unpublished for the same reason.

The gateway's configuration is `srckube-kong/kong.yml`, which is
version-controlled, so the Admin API is not how you change anything here:

```sh
# edit srckube-kong/kong.yml, then
docker exec kong kong reload
docker exec kong kong health
```

The Kong image ships no HTTP client, so `docker exec kong curl ...` does not
work. If you genuinely need the Admin API over HTTP, use OpenResty's client:

```sh
docker exec kong /usr/local/openresty/bin/resty -e \
  'local h=require("resty.http").new()
   local r=h:request_uri("http://127.0.0.1:8001/routes")
   print(r.body)'
```

### 4. Start the backend services

```bash
cd backend
docker compose up -d --build
```

This starts MongoDB, Redis, and 13 of the 14 services (`statusService` currently has
no implementation — see the strategy doc's Technical Debt Register, TD-03/0.2.3).

**If you rebuild or recreate any backend container after Kong has already started**,
restart Kong afterward (`cd srckube-kong && docker compose restart`) — Kong caches
upstream DNS resolutions and will otherwise keep routing to stale container IPs
(see TD-21 in the strategy doc).

### 5. Start the frontend

```bash
cd frontend
npm install
npm start
```

Serves on `http://localhost:3000`.

## Environment variables

Each backend service reads `config/config.env`, which is **not committed to git**
(see `config/config.env.example` for the variable list with placeholder values).
Key variables:

| Variable | Purpose |
|---|---|
| `MONGO_URI` | Per-service MongoDB connection string |
| `JWT_SECRET` | Legacy JWT signing secret (`userService` only — being retired) |
| `KeyCloak_URI` | Keycloak base URL. **Must be `http://localhost:8080`** for services that only validate incoming tokens (matches the token issuer), but **must be `http://keycloak:8080`** for `userService`, which also makes outbound calls to Keycloak's admin API from inside its container |
| `KeyCloak_Realm` | Always `srckube` |
| `KeyCloak_Secret` | The `node-microservice` client secret, as registered in Keycloak |
| `KeyCloak_publicKey` | The realm's RS256 public key, used for offline bearer-token signature verification — **must match the actual running Keycloak realm's key**, not a value inherited from a different environment |
| `Redis_URI` | Only used by `userService` |

Frontend env (`frontend/.env*`): `REACT_APP_API_BASE_URL` (the Kong gateway),
`REACT_APP_KEYCLOAK_BASE_URL`.

## Known local-dev pitfalls (see the strategy doc's Technical Debt Register for full detail)

- **Port 27017 conflict**: if you have a local (non-Docker) MongoDB already running
  on your machine, it will shadow the Dockerized one on `localhost:27017` for
  host-level tools (`mongosh`, `mongodump`), even though container-to-container
  traffic is unaffected. Use `docker exec mongodb mongosh ...` to reach the
  Dockerized instance specifically.
- **10 of 14 services hardcode their Keycloak config** directly in
  `keycloak-config.js` rather than reading it from `config/config.env` — if you
  change Keycloak settings, check both places (TD-19/TD-04 in the strategy doc;
  being consolidated into a shared library in Sprint 1.1).

## Testing

This repository has substantial test coverage: black-box HTTP suites against the
live stack (run with `scripts/run-api-tests.sh`), Jest unit suites per service,
frontend Jest suites, and a Playwright end-to-end suite (`cd frontend && npx
playwright test`).

**CI is not yet wired up on this remote.** The previous GitLab pipeline ran a
backend syntax check, a require check, a frontend build and SAST/secret-detection;
that config was removed when the project moved to GitHub, and an equivalent GitHub
Actions workflow still has to be written. Until it is, `scripts/run-api-tests.sh`
is the verification step to run before claiming a change is done.
