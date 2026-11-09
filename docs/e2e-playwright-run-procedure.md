# WP-063 — Playwright E2E: run procedure and current status

## Status as of 2026-09-01 (this session)

| Spec | Status | Notes |
|---|---|---|
| `e2e/specs/auth.spec.ts` | **PASSING — actually run, watched pass** | Real Keycloak login, real browser, real app. |
| `e2e/specs/test-execution.spec.ts` | Written, **skips cleanly** | Blocked by the Kong CORS gap (`docs/e2e-playwright-cors-blocker.md`); `requireApiReachable()` skips it with that exact reason rather than hanging or faking a pass. |
| `e2e/specs/ai-generation.spec.ts` | Written, **skips cleanly** | Same blocker. |

Real command output, this session:

```
$ cd frontend && npx playwright test --reporter=list
Running 3 tests using 1 worker

  -  1 [chromium] › e2e/specs/ai-generation.spec.ts:24:5 › generate AI test-case candidates for a requirement and accept one
  ✓  2 [chromium] › e2e/specs/auth.spec.ts:21:5 › a real Keycloak login lands on the project-scoped dashboard shell (5.4s)
  -  3 [chromium] › e2e/specs/test-execution.spec.ts:38:5 › record a Pass result against a test execution step

  2 skipped
  1 passed (24.0s)
```

Once a human/CI operator applies either CORS fix in
`docs/e2e-playwright-cors-blocker.md`, re-running this exact command
should make `test-execution.spec.ts` and `ai-generation.spec.ts` attempt
their real journeys instead of skipping — they were written directly
against current source (button roles, aria-labels, MUI `data-testid`s,
route paths), not guessed, but were **not watched pass** here, and may
need small selector adjustments once real data is actually flowing (per
GR-6, treat their current "written but unexecuted" status as exactly
that, not as a guaranteed pass).

## How to run it

Prerequisites:
- The backend compose stack up (`docker compose -f backend/docker-compose.yml up -d`) — Kong on `:8000`, Keycloak on `:8080`, all 18 services healthy.
- Repo-root `.env.test` populated (`TEST_KEYCLOAK_CLIENT_SECRET` etc.) — same file `backend/shared/test-utils/getServiceToken.js` already relies on.
- Project id=1 ("Default Project") seeded in userService (it already is, in this stack).

```bash
cd frontend
npm install                 # installs @playwright/test@1.59.1 (pinned)
npx playwright install chromium   # no-op if already cached
npx playwright test               # or: npm run test:e2e
```

What happens on each run:
1. `e2e/auth/global-setup.ts` creates a real, disposable Keycloak user via
   the Admin API (reusing the service account's `client_credentials`
   token — the same one `getServiceToken.js` uses), grants it
   `contributor` membership on project 1, and drives Keycloak's real
   hosted login form in a headless browser to produce a logged-in
   `storageState` every spec starts from.
2. Each spec in `e2e/specs/*.spec.ts` runs against a `craco start` dev
   server that Playwright itself starts on `:3000` if one isn't already
   running (`reuseExistingServer: true` in `playwright.config.ts` — if a
   dev server from earlier work is already up, it's reused rather than
   double-started).
3. `e2e/auth/global-teardown.ts` deletes that persona (Keycloak user +
   its project-1 membership entry) so the run leaves no residue.

Reports: `npx playwright show-report frontend/e2e-report` after a run
(the HTML report; also `frontend/e2e-results/` for traces/videos/screenshots
on failure — none of this is committed, see `frontend/.gitignore`).

## Why this suite cannot hang or break the existing test run

- `scripts/run-api-tests.sh` discovers suites via `find -type d -name
  "__tests__"`. Nothing under `frontend/e2e/` is named `__tests__` —
  confirmed: `find frontend/e2e -type d -name __tests__` returns nothing.
- `craco test` (the frontend's own `npm test`, i.e. Jest via
  react-scripts) defaults to `roots: ['<rootDir>/src']` — `frontend/e2e/`
  is a sibling of `src/`, entirely outside that root, so `npm test` never
  even looks at these files. No frontend `package.json` `"jest"` override
  changes `roots`, confirmed by reading it.
- Playwright's own suite is invoked only explicitly, via `npx playwright
  test` / `npm run test:e2e` — never part of `npm test`, `npm run build`,
  or `run-api-tests.sh`.
- The two data-journey specs cannot hang even if someone runs this suite
  blind in an environment with the same CORS gap: `requireApiReachable()`
  calls `test.skip()` (not a long `waitFor`) the moment the guard fetch
  fails, which resolves quickly (browser CORS rejection is immediate, not
  a timeout).

## Auth approach (the hardest part of this WP), resolved

The test *service account* (`backend/shared/test-utils/getServiceToken.js`,
`client_credentials` grant) cannot log into a browser session — that
grant type has no interactive login step at all. The fix, in
`frontend/e2e/auth/persona.ts`: reuse the *pattern* WP-022 already proved
(`backend/shared/test-utils/keycloakTestPersona.js`) — the same service
account holds `realm-management/manage-users`, so it can create a real,
disposable Keycloak **user** (not a service account) via the Admin API,
set a real password, and grant it real project-1 membership. That user
has a normal interactive login, which Playwright drives through
Keycloak's actual hosted login page — confirmed real via source
inspection (`GET /admin/realms/srckube/clients?clientId=mern-app`:
`publicClient=true`, `redirectUris=["http://localhost:3000/*"]`, i.e. the
app's own PKCE public client, distinct from the backend's
`node-microservice` service-account client) and confirmed working by
actually running `auth.spec.ts` end to end.
