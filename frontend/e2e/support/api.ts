// WP-063b — server-side API access for E2E fixture setup/teardown.
//
// The specs in this suite drive the REAL app in a REAL browser as the
// disposable 'contributor' persona (e2e/auth/persona.ts). Two of the three
// journeys need data that project 1 is not seeded with (a test execution
// run that actually has a test case attached; a requirement to generate
// against), and both journeys CREATE data as a side effect of the user
// action they are testing. Neither may be left behind — ~800 leaked fixture
// documents had to be purged earlier in this programme, so every document a
// spec creates is tracked and deleted in its own teardown.
//
// Fixtures are created/removed through the same public REST API the browser
// itself talks to (Kong :8000), never by writing to Mongo directly, so a
// fixture can never be in a shape the API would not have produced.
//
// The credential here is the client_credentials SERVICE token, not the
// persona's. Two reasons:
//   1. The persona is deliberately a 'contributor', and contributor has no
//      'delete' in the RBAC matrix (backend/shared/service-core/
//      permissions.js) — it literally cannot clean up after itself. Keeping
//      the persona at 'contributor' is the point (it is the role the
//      journeys are meant to exercise), so teardown uses a separate,
//      more-privileged identity rather than inflating the persona's role.
//   2. Setup runs before the browser exists; there is no session to borrow.
// The service token is never injected into the browser — the app's own
// calls are made with the persona's real Keycloak session, unchanged.
import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';
import { getServiceToken } from '../auth/persona';

/** The seeded project every spec in this suite runs against ("Default Project"). */
export const PROJECT_ID = 1;

const API_BASE = process.env.E2E_API_BASE_URL || 'http://localhost:8000/api/v1';

/**
 * An axios client aimed at Kong, pre-scoped to project 1. `X-Project-Id` is
 * required by requireProjectScope() on every project-scoped route — without
 * it these calls 400/403 exactly the way the browser's would.
 */
export async function serviceApi(): Promise<AxiosInstance> {
  const token = await getServiceToken();
  return axios.create({
    baseURL: API_BASE,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Project-Id': String(PROJECT_ID),
      'Content-Type': 'application/json',
    },
    // Fixture setup should fail loudly and immediately, not hang a 45s test.
    timeout: 20_000,
  });
}

/**
 * The Keycloak sub of the persona this run logged in as, written by
 * e2e/auth/global-setup.ts. Used to stamp fixtures as belonging to the
 * logged-in user (e.g. a test execution's `assignedTo`, which the Test
 * Execution page resolves to a username via /users/kcUser — an unresolvable
 * id there fails the page's whole initial load, so this must be a real,
 * currently-existing Keycloak user).
 */
export function personaUserId(): string {
  const runtimePath = path.join(__dirname, '..', '.auth', 'persona-runtime.json');
  if (!fs.existsSync(runtimePath)) {
    throw new Error(
      `Persona runtime state not found at ${runtimePath} — e2e/auth/global-setup.ts should have written it. ` +
        'Run the suite through `npx playwright test` (which runs globalSetup) rather than invoking a spec directly.'
    );
  }
  const { userId } = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
  if (!userId) throw new Error(`No userId recorded in ${runtimePath}`);
  return userId;
}
