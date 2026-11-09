// WP-063 — real, disposable Keycloak identity for a BROWSER E2E session.
//
// The hardest part of this WP: auth is Keycloak (keycloak-js,
// `onLoad: 'login-required'` in src/index.tsx), not a form the app lets you
// stub, and the existing test *service account*
// (backend/shared/test-utils/getServiceToken.js, client_credentials grant)
// cannot log into a browser session at all — client_credentials has no
// interactive login step; there is no username/password/consent screen to
// drive for it. It's suited to server-to-server backend test calls (which
// is exactly what it's used for elsewhere in this repo), not to a real
// browser navigating Keycloak's own hosted login page.
//
// The fix: reuse the *pattern* WP-022 already proved
// (backend/shared/test-utils/keycloakTestPersona.js) — the service
// account's client_credentials token holds realm-management/manage-users,
// so it can create a real, throwaway Keycloak USER via the Admin API, set a
// real password on it, and delete it again afterward. That user has a real
// interactive login: Playwright's browser can navigate to the app, get
// redirected to Keycloak's actual hosted login page (not a stub), and type
// this user's real username/password into the real form, exactly like a
// human would. This file is that same pattern, adapted for browser use:
// unlike keycloakTestPersona.js it does NOT fetch a ROPC token itself (the
// browser flow does its own Authorization Code + PKCE exchange against the
// 'mern-app' public client — a different client than the backend's
// 'node-microservice' service account, confirmed via
// GET /admin/realms/srckube/clients?clientId=mern-app: publicClient=true,
// redirectUris=["http://localhost:3000/*"]) — it only creates the account,
// grants it project-1 membership, and hands back the raw credentials for
// global-setup.ts to type into the login form.
import axios from 'axios';
import path from 'path';
import dotenv from 'dotenv';

// Load repo-root .env.test the same way the backend's own test-utils do
// (backend/shared/test-utils/getServiceToken.js) -- guarded so a value
// already present in the environment always wins over the file.
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env.test') });

const KEYCLOAK_URL = process.env.TEST_KEYCLOAK_URL || 'http://localhost:8080';
const REALM = process.env.TEST_KEYCLOAK_REALM || 'srckube';
const CLIENT_ID = process.env.TEST_KEYCLOAK_CLIENT_ID || 'node-microservice';
const USER_SERVICE_URL = process.env.E2E_USER_SERVICE_URL || 'http://localhost:8000/api/v1';

function clientSecret(): string {
  const secret = process.env.TEST_KEYCLOAK_CLIENT_SECRET;
  if (!secret) {
    throw new Error(
      'TEST_KEYCLOAK_CLIENT_SECRET is not set — see backend/shared/test-utils/getServiceToken.js ' +
        'for how to configure it (repo-root .env.test, or export directly).'
    );
  }
  return secret;
}

export async function getServiceToken(): Promise<string> {
  const resp = await axios.post(
    `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`,
    new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'client_credentials',
      client_secret: clientSecret(),
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return resp.data.access_token;
}

export interface E2EPersona {
  userId: string; // Keycloak sub, also the Mongo project member's userId
  username: string;
  password: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates a real Keycloak user (interactive-login-capable, unlike the
 * client_credentials service account) and grants it project membership on
 * the real seeded project id=1 ("Default Project"), so a browser session
 * logging in as this user lands on a page with a valid X-Project-Id: 1
 * scope instead of 403ing everywhere. Defaults to 'contributor' -- enough
 * for the journeys this file's original WP covered: recording a test
 * execution result (authorize('write') on testPlanExecutionService) and
 * the WP-051 AI generation flow (authorize('read')/authorize('write') on
 * requirementService/testRepoService via aiService) —
 * backend/shared/service-core/permissions.js's ROLES/roleCan, confirmed
 * against the live rbacMembers.test.js suite.
 *
 * Wave B-3/B-4 -- `role` is now a parameter (not always 'contributor')
 * because 'contributor' has no 'delete' in that same RBAC matrix
 * (permissions.js), and entity-creation.spec.ts's delete/clone journey
 * genuinely needs to click the real Delete UI, not just prove it's hidden.
 * The shared global-setup.ts persona (used by every OTHER spec in this
 * suite via storageState) is deliberately left at its default
 * 'contributor' -- see e2e/support/api.ts's header comment on why
 * inflating that shared persona's role would be the wrong fix. A journey
 * needing more calls this with an explicit role and logs in as its own,
 * throwaway persona instead (e2e/support/login.ts).
 */
export async function createE2EPersona(
  labelPrefix: string,
  role: 'contributor' | 'manager' | 'admin' = 'contributor',
  // `keepRequiredActions` exists for exactly one caller:
  // specs/termsAcceptance.spec.ts, which must receive a persona in the state
  // a REAL new user is in — terms pending — in order to drive that page.
  // Every other caller wants it cleared, so clearing is the default and
  // opting out is explicit and noisy.
  options: { keepRequiredActions?: boolean } = {}
): Promise<E2EPersona> {
  const serviceToken = await getServiceToken();
  const adminHeaders = { Authorization: `Bearer ${serviceToken}` };

  const username = `wp063-e2e-${labelPrefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const password = `E2ePass!${Math.random().toString(36).slice(2)}${Date.now()}`;

  await axios.post(
    `${KEYCLOAK_URL}/admin/realms/${REALM}/users`,
    { username, enabled: true, email: `${username}@example.invalid`, emailVerified: true },
    { headers: { ...adminHeaders, 'Content-Type': 'application/json' } }
  );

  const lookup = await axios.get(`${KEYCLOAK_URL}/admin/realms/${REALM}/users`, {
    headers: adminHeaders,
    params: { username, exact: true },
  });
  const userId: string | undefined = lookup.data?.[0]?.id;
  if (!userId) {
    throw new Error(`Failed to look up newly created Keycloak E2E persona '${username}'`);
  }

  // Clear the realm's DEFAULT required actions from this persona.
  //
  // TERMS_AND_CONDITIONS has been a realm default action since WP-130
  // (commit 2feb0fe sets it `enabled: true, defaultAction: true`), so
  // Keycloak attaches it to EVERY newly created user — including
  // admin-created fixtures like this one. A user with a pending required
  // action does not come back to the app after submitting the login form; it
  // lands on /login-actions/required-action?execution=TERMS_AND_CONDITIONS,
  // so global-setup.ts's waitForURL for the app origin times out and the
  // whole Playwright suite fails in setup, before a single spec runs.
  //
  // This MUST be a PUT after creation, not `requiredActions: []` in the POST
  // above: Keycloak applies the realm defaults regardless of what the create
  // call specifies. That was established the expensive way in WP-130, where
  // it took out 10 backend tests whose failures read as RBAC regressions —
  // see backend/shared/test-utils/keycloakTestPersona.js:101-104.
  //
  // Clearing it per-persona rather than turning the realm flag off is
  // deliberate, and matches keycloakTestPersona.js and
  // userService/__tests__/firstLoginBootstrap.test.js. Accepting terms is
  // real product behaviour that a human performs in a browser; this persona
  // has no browser at this point in setup. Disabling the realm default to
  // make setup pass would silently remove terms acceptance from live signup,
  // and nothing in the suite asserts it is on, so nobody would notice.
  //
  // The terms flow itself is covered on purpose by
  // e2e/specs/termsAcceptance.spec.ts, which creates a persona WITHOUT
  // clearing this and drives the real page.
  if (!options.keepRequiredActions) {
    await axios.put(
      `${KEYCLOAK_URL}/admin/realms/${REALM}/users/${userId}`,
      { requiredActions: [] },
      { headers: { ...adminHeaders, 'Content-Type': 'application/json' } }
    );
  }

  await axios.put(
    `${KEYCLOAK_URL}/admin/realms/${REALM}/users/${userId}/reset-password`,
    { type: 'password', value: password, temporary: false },
    { headers: { ...adminHeaders, 'Content-Type': 'application/json' } }
  );

  // Resolve project id=1's Mongo _id (userService's Project.id is a plain
  // Number field, distinct from _id) and add this persona as a member.
  const projectsResp = await axios.get(`${USER_SERVICE_URL}/projects`, { headers: adminHeaders });
  const projectList = Array.isArray(projectsResp.data) ? projectsResp.data : projectsResp.data?.data || [];
  const project1 = projectList.find((p: any) => p.id === 1);
  if (!project1) {
    throw new Error('Project id=1 ("Default Project") was not found via GET /api/v1/projects — is the stack seeded?');
  }

  await axios.post(
    `${USER_SERVICE_URL}/projects/${project1._id}/members`,
    { userId, role },
    { headers: { ...adminHeaders, 'Content-Type': 'application/json' } }
  );

  // ORGANIZATION membership, which project membership does NOT imply.
  //
  // Project membership alone makes this persona correctly SCOPED to project 1
  // — every /api/v1 call with X-Project-Id: 1 authorises fine. But
  // `GET /api/v1/projects` is scoped by ORGANIZATION membership, not project
  // membership (userService/controllers/projects.js:76 filters on
  // `Organization.find({'members.userId': tokenSub})`), and its own comment
  // records that a caller in no organization receives an empty list. That is
  // intended behaviour from WP-110, not a bug.
  //
  // Consequences when this was missing, both measured rather than reasoned:
  //   - the project switcher rendered its fallback label "Project 1" instead
  //     of "Default Project" (ProjectSwitcher.tsx:51 substitutes a synthetic
  //     option when the fetched list doesn't contain the current id), so
  //     auth.spec.ts could never pass
  //   - usePermissions resolved no role, so role-gated UI never rendered —
  //     which after the source-panel redesign means the "New" and
  //     "More actions" menus do not exist at all, and every spec that creates
  //     anything through them is unreachable
  //
  // Probed directly: with project membership only, GET /api/v1/projects
  // returned 200 with count 0; adding org_member returned count 2 including
  // id=1 "Default Project".
  //
  // `org_member`, deliberately not `org_admin`: this grants visibility of the
  // organization's projects without inflating what the persona can do inside
  // them. The per-project `role` argument above stays the only thing deciding
  // that. (The API rejects anything other than org_admin/org_member with a
  // 400 naming both, which is how the role vocabulary was confirmed.)
  await axios.post(
    `${USER_SERVICE_URL}/organizations/${project1.organizationId}/members`,
    { userId, role: 'org_member' },
    { headers: { ...adminHeaders, 'Content-Type': 'application/json' } }
  );

  return { userId, username, password, cleanup: () => deleteE2EPersona(userId) };
}

/**
 * Standalone teardown, callable from a separate process/invocation (Playwright's
 * globalTeardown runs as its own script, not a closure surviving from
 * globalSetup) — global-teardown.ts reads the userId written to
 * e2e/.auth/persona-runtime.json by global-setup.ts and passes it here.
 * Best-effort, mirroring keycloakTestPersona.js: a run that already failed
 * mid-test shouldn't also fail loudly on teardown. Removes the project
 * membership entry too (not just the Keycloak user) so this suite doesn't
 * leave the same kind of stale-member residue visible on project 1 today
 * from earlier WP-022 runs (confirmed live: ~a dozen leftover
 * 'wp022-persona-*' contributor entries on project 1 as of 2026-09-01).
 */
export async function deleteE2EPersona(userId: string): Promise<void> {
  const freshToken = await getServiceToken().catch(() => undefined);
  if (!freshToken) return;
  const headers = { Authorization: `Bearer ${freshToken}` };

  const projectsResp = await axios.get(`${USER_SERVICE_URL}/projects`, { headers }).catch(() => undefined);
  const projectList = Array.isArray(projectsResp?.data) ? projectsResp!.data : projectsResp?.data?.data || [];
  const project1 = projectList.find((p: any) => p.id === 1);
  if (project1) {
    await axios
      .delete(`${USER_SERVICE_URL}/projects/${project1._id}/members/${userId}`, { headers })
      .catch(() => {});

    // ...and the ORGANIZATION membership createE2EPersona now also adds.
    // Without this the org accumulates members whose Keycloak identity has
    // been deleted — exactly the residue the comment above records from
    // WP-022, one level up. Deleting the Keycloak user does not cascade: the
    // membership is a Mongo document keyed by a sub that no longer resolves,
    // so it would sit there indefinitely and inflate every organization
    // member list a human looks at.
    if (project1.organizationId) {
      await axios
        .delete(`${USER_SERVICE_URL}/organizations/${project1.organizationId}/members/${userId}`, { headers })
        .catch(() => {});
    }
  }
  await axios.delete(`${KEYCLOAK_URL}/admin/realms/${REALM}/users/${userId}`, { headers }).catch(() => {});
}
