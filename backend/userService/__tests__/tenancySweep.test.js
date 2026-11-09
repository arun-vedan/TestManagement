const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// Systematic tenancy sweep: no endpoint serves one tenant's data to another.
//
// WHY THIS EXISTS. Two serious exposures were found in two days, both
// incidentally while verifying something else:
//
//   - /api/v1/users/kcUser and /kcUsers returned any account's full Keycloak
//     representation, INCLUDING EMAIL, to any signed-in stranger, and /kcUsers
//     with an empty filter returned every user in the realm (fixed, 1257bc7).
//   - Kong's Admin API was unauthenticated on 0.0.0.0:8001, and in DB-less mode
//     POST /config accepts writes -- unauthenticated control of the gateway
//     (fixed, srckube-kong f2b2713).
//
// Both were missed by static review. The route tables looked right: every
// /api/v1 route carries Kong's jwt plugin, and the handful of routes without
// requireProjectScope() are all the documented "authorization lives in the
// controller" pattern. kcUsers WAS that pattern -- a controller that was
// supposed to check and simply did not. No amount of reading the middleware
// chain reveals that.
//
// So this suite asks the question empirically instead, against every
// /api/v1 route Kong exposes: given a real, authenticated identity that
// belongs to NOTHING, does anything hand back data?
//
// WHAT COUNTS AS A PASS. 401, 403, 404, 400 and 5xx are all fine -- the
// endpoint refused, or needs input, or its backend is unavailable. A 200 with
// an EMPTY collection is also fine and is the correct answer for the
// deliberately caller-scoped endpoints (GET /organizations and GET /projects
// return [] for someone with no memberships, by design -- see WP-110).
//
// The failure is a 200 carrying content. That is the shape kcUsers had, and
// the shape this suite would have caught.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const runId = Date.now();

// Every /api/v1 path Kong routes, from srckube-kong/kong.yml. Kept as an
// explicit list rather than parsed at runtime so that ADDING a Kong route does
// not silently add an unaudited endpoint: a new route is invisible to this
// suite until someone adds it here, and the count assertion below fails when
// the gateway grows, which is the prompt to do so.
const KONG_API_PATHS = [
    '/api/v1/ai',
    '/api/v1/apikeys',
    '/api/v1/apikeys/demo',
    '/api/v1/attachment',
    '/api/v1/audit',
    '/api/v1/automation',
    '/api/v1/casetemplate',
    '/api/v1/comments',
    '/api/v1/dataset',
    '/api/v1/defects',
    '/api/v1/environments',
    '/api/v1/fields',
    '/api/v1/folders',
    '/api/v1/invites',
    '/api/v1/issuestatus',
    '/api/v1/linkIssue',
    '/api/v1/modules',
    '/api/v1/notifications',
    '/api/v1/objectrepo',
    '/api/v1/organizations',
    '/api/v1/projects',
    '/api/v1/releases',
    '/api/v1/reports',
    '/api/v1/requirement',
    '/api/v1/savedviews',
    '/api/v1/sharedstep',
    '/api/v1/testexecution',
    '/api/v1/testexecution/ingest',
    '/api/v1/testplan',
    '/api/v1/testrepo',
    '/api/v1/users/directory',
    '/api/v1/users/kcUser'
];

// Returns a description of why a response is a leak, or null if it is fine.
function leakReason(resp) {
    if (resp.status !== 200) return null;
    const body = resp.data;
    if (body === null || body === undefined || body === '') return null;

    // The envelope every service uses: { success, count?, data }
    const data = body.data;
    if (Array.isArray(data)) {
        return data.length > 0 ? `200 with ${data.length} records` : null;
    }
    if (data && typeof data === 'object') {
        return Object.keys(data).length > 0 ? '200 with a populated data object' : null;
    }
    if (typeof body.count === 'number') {
        return body.count > 0 ? `200 with count=${body.count}` : null;
    }
    // Reports answer { success, data: {...} } handled above; anything else
    // that is a 200 with no recognisable envelope is reported rather than
    // assumed safe, so a new response shape cannot slip through as a pass.
    if (typeof body === 'object' && Object.keys(body).length > 2) {
        return `200 with an unrecognised payload (${Object.keys(body).slice(0, 6).join(',')})`;
    }
    return null;
}

describe('tenancy sweep: no endpoint serves another tenant data to an outsider', () => {
    let outsider;
    let outsiderToken;
    let foreignProjectId;
    let orgId;
    let projectMongoId;

    beforeAll(async () => {
        const adminToken = await getServiceToken();
        const admin = axios.create({
            baseURL: KONG_URL,
            headers: { Authorization: `Bearer ${adminToken}` },
            validateStatus: () => true
        });

        // A populated project the outsider has nothing to do with. Populated
        // deliberately: an empty project would make every endpoint return an
        // empty list and the suite would pass without proving anything.
        const org = await admin.post('/api/v1/organizations', {
            name: `tenancy-sweep org ${runId}`,
            key: `tsweep-${runId}`
        });
        expect(org.status).toBe(201);
        orgId = org.data.data._id;
        trackOrganization(orgId);

        const proj = await admin.post('/api/v1/projects', {
            name: `tenancy-sweep project ${runId}`,
            key: `tsw${String(runId).slice(-6)}`,
            organizationId: orgId
        });
        expect(proj.status).toBe(201);
        foreignProjectId = proj.data.data.id;
        projectMongoId = proj.data.data._id;
        trackProject(foreignProjectId);

        const scoped = axios.create({
            baseURL: KONG_URL,
            headers: { Authorization: `Bearer ${adminToken}`, 'X-Project-Id': String(foreignProjectId) },
            validateStatus: () => true
        });
        // Enough content that a leak would have something to return.
        await scoped.post('/api/v1/requirement', {
            requirementSummary: `sweep secret requirement ${runId}`,
            requirementDescription: 'must never be visible to an outsider'
        });
        await scoped.post('/api/v1/testrepo', {
            TestCaseSummary: `sweep secret case ${runId}`,
            TestCaseDescription: 'must never be visible to an outsider',
            testSteps: [{ testStep: 'a', Expected: 'b' }]
        });
        await scoped.post('/api/v1/defects', {
            summary: `sweep secret defect ${runId}`,
            Severity: 'High',
            Status: 'New'
        });

        // The outsider: a real, verified, authenticated identity that belongs
        // to no organization and no project.
        outsider = await createTestPersona('tenancy-sweep-outsider');
        outsiderToken = await outsider.getToken();
    }, 180000);

    afterAll(async () => {
        if (outsider) await outsider.cleanup();
    });

    function outsiderClient(projectId) {
        return axios.create({
            baseURL: KONG_URL,
            headers: {
                Authorization: `Bearer ${outsiderToken}`,
                ...(projectId ? { 'X-Project-Id': String(projectId) } : {})
            },
            timeout: 20000,
            validateStatus: () => true
        });
    }

    it('the leak detector is not blind: it flags the exact shape of the bug it exists for', () => {
        // A sweep that cannot recognise a leak passes just as happily as a
        // secure stack. These are the real response bodies the fixed
        // endpoints used to return, verified live before 1257bc7.
        const oldKcUser = {
            status: 200,
            data: {
                success: true,
                data: {
                    id: '7200ccb3-b853-4fa2-a2cb-92156305fb03',
                    username: 'someone-elses-account',
                    email: 'victim-secret-address@example.invalid',
                    emailVerified: true,
                    enabled: true,
                    requiredActions: []
                }
            }
        };
        expect(leakReason(oldKcUser)).toMatch(/populated data object/);

        const oldRealmDump = {
            status: 200,
            data: { success: true, count: 47, data: [{ id: 'a', username: 'a' }, { id: 'b', username: 'b' }] }
        };
        expect(leakReason(oldRealmDump)).toMatch(/2 records/);

        // And it must NOT flag the legitimate answers, or the sweep would be
        // unusable noise: refusals, and the deliberately caller-scoped
        // endpoints that correctly return an empty collection (WP-110).
        expect(leakReason({ status: 403, data: { error: 'No access' } })).toBeNull();
        expect(leakReason({ status: 404, data: { error: 'not found' } })).toBeNull();
        expect(leakReason({ status: 200, data: { success: true, count: 0, data: [] } })).toBeNull();
        expect(leakReason({ status: 503, data: { error: 'unavailable' } })).toBeNull();
    });

    it('the audited list still covers every /api/v1 route Kong exposes', () => {
        // Guards the list itself. A new Kong route would otherwise be exempt
        // from this sweep forever, silently.
        const fs = require('fs');
        const path = require('path');
        const kongYml = fs.readFileSync(
            path.resolve(__dirname, '../../../srckube-kong/kong.yml'),
            'utf8'
        );
        const live = new Set(
            (kongYml.match(/^\s*-\s*(\/api\/v1\/[A-Za-z0-9/_-]+)\s*$/gm) || []).map((l) =>
                l.replace(/^\s*-\s*/, '').trim()
            )
        );
        const unaudited = [...live].filter((p) => !KONG_API_PATHS.includes(p));
        expect({ unauditedKongRoutes: unaudited }).toEqual({ unauditedKongRoutes: [] });
    }, 30000);

    it('serves no data to an outsider who sends no project header', async () => {
        const client = outsiderClient(null);
        const leaks = {};
        for (const p of KONG_API_PATHS) {
            // eslint-disable-next-line no-await-in-loop
            const resp = await client.get(p);
            const reason = leakReason(resp);
            if (reason) leaks[p] = reason;
        }
        expect(leaks).toEqual({});
    }, 240000);

    it("serves no data to an outsider who points X-Project-Id at someone else's project", async () => {
        // The interesting case: a valid token plus a valid, populated project
        // id the caller has no membership of. This is what a curious customer
        // would try first.
        const client = outsiderClient(foreignProjectId);
        const leaks = {};
        for (const p of KONG_API_PATHS) {
            // eslint-disable-next-line no-await-in-loop
            const resp = await client.get(p);
            const reason = leakReason(resp);
            if (reason) leaks[p] = reason;
        }
        expect(leaks).toEqual({});
    }, 240000);

    it("never echoes the foreign project's content in any response body", async () => {
        // A belt-and-braces check against a partial leak that keeps the
        // envelope shape: search every response for the fixture strings, which
        // exist nowhere else in the database.
        const needles = [`sweep secret requirement ${runId}`, `sweep secret case ${runId}`, `sweep secret defect ${runId}`];
        const client = outsiderClient(foreignProjectId);
        const offenders = {};
        for (const p of KONG_API_PATHS) {
            // eslint-disable-next-line no-await-in-loop
            const resp = await client.get(p);
            const text = JSON.stringify(resp.data || '');
            const hit = needles.find((n) => text.includes(n));
            if (hit) offenders[p] = hit;
        }
        expect(offenders).toEqual({});
    }, 240000);

    it('refuses an outsider write to a foreign project', async () => {
        // Reads are the obvious risk; a write that lands in another tenant is
        // worse, so the same question is asked of the write path.
        const client = outsiderClient(foreignProjectId);
        const writes = [
            ['/api/v1/requirement', { requirementSummary: 'outsider write', requirementDescription: 'x' }],
            ['/api/v1/testrepo', { TestCaseSummary: 'outsider write', TestCaseDescription: 'x' }],
            ['/api/v1/defects', { summary: 'outsider write', Severity: 'Low', Status: 'New' }],
            ['/api/v1/linkIssue', { sourceId: 'Req-1', srcModule: 2, destinationId: 'TC-1', destinationModule: 1, summary: 'x' }]
        ];
        const accepted = {};
        for (const [p, body] of writes) {
            // eslint-disable-next-line no-await-in-loop
            const resp = await client.post(p, body);
            if (resp.status >= 200 && resp.status < 300) accepted[p] = resp.status;
        }
        expect(accepted).toEqual({});
    }, 120000);

    it('refuses an outsider access to the foreign project and organization directly', async () => {
        const client = outsiderClient(null);
        const project = await client.get(`/api/v1/projects/${projectMongoId}`);
        expect([403, 404]).toContain(project.status);
        const org = await client.get(`/api/v1/organizations/${orgId}`);
        expect([403, 404]).toContain(org.status);
        const members = await client.get(`/api/v1/organizations/${orgId}/members`);
        expect([403, 404]).toContain(members.status);
    }, 60000);

    // ANONYMOUS probes. Added after the first version of this suite shipped,
    // because its conclusion -- "all 32 /api/v1 routes carry Kong's jwt
    // plugin" -- was true and yet incomplete. Two routes carry a jwt plugin
    // configured with `config.anonymous`, which does NOT reject an
    // unauthenticated request: it waves it through to a pass-through consumer
    // and leaves the decision to the service. Checking plugin NAMES could
    // never have caught that, and every other test here uses an
    // authenticated outsider, so this path was unexercised.
    //
    // The design is deliberate (WP-032/WP-033: a CI job posts results with an
    // X-Api-Key and no human identity) and it holds -- the service refuses.
    // These tests exist so it keeps holding, since the gateway is not the
    // thing enforcing it.
    describe('routes where Kong permits anonymous pass-through', () => {
        const ANONYMOUS_ROUTES = ['/api/v1/testexecution/ingest', '/api/v1/apikeys/demo'];

        it('still refuse a caller with no credentials at all', async () => {
            const anon = axios.create({ baseURL: KONG_URL, timeout: 20000, validateStatus: () => true });
            const results = {};
            for (const p of ANONYMOUS_ROUTES) {
                // eslint-disable-next-line no-await-in-loop
                const resp = await anon.post(p, {});
                results[p] = resp.status;
                expect(leakReason(resp)).toBeNull();
            }
            // Refused by the SERVICE, not by Kong: 403 from its own auth
            // middleware, or 404 where the sub-route does not exist. A 2xx
            // here would mean an unauthenticated write reached the product.
            Object.entries(results).forEach(([p, status]) => {
                expect({ path: p, ok: status >= 400 }).toEqual({ path: p, ok: true });
            });
        }, 60000);

        it('still refuse a bogus API key', async () => {
            const anon = axios.create({
                baseURL: KONG_URL,
                headers: { 'X-Api-Key': `not-a-real-key-${runId}` },
                timeout: 20000,
                validateStatus: () => true
            });
            const resp = await anon.post('/api/v1/testexecution/ingest', {});
            expect(resp.status).toBeGreaterThanOrEqual(400);
            expect(leakReason(resp)).toBeNull();
        }, 60000);

        it("the strict sibling route is unaffected and still rejected at the gateway", async () => {
            // Guards the prefix-matching that keeps /ingest's permissive rule
            // from widening to all of /api/v1/testexecution. Kong matches the
            // LONGEST prefix, so a change to either route's path could
            // silently hand the whole collection the anonymous rule.
            const anon = axios.create({ baseURL: KONG_URL, timeout: 20000, validateStatus: () => true });
            const resp = await anon.post('/api/v1/testexecution', {});
            expect(resp.status).toBe(401);
        }, 60000);
    });

    it('the sweep is not vacuous: a legitimate member DOES see the content', async () => {
        // Without this, every assertion above would pass against a broken
        // stack that returns 500 to everybody.
        const adminToken = await getServiceToken();
        const member = axios.create({
            baseURL: KONG_URL,
            headers: { Authorization: `Bearer ${adminToken}`, 'X-Project-Id': String(foreignProjectId) },
            validateStatus: () => true
        });
        const reqs = await member.get('/api/v1/requirement');
        expect(reqs.status).toBe(200);
        expect(JSON.stringify(reqs.data)).toContain(`sweep secret requirement ${runId}`);
    }, 60000);
});

afterAll(() => {
    purgeTrackedFixtures();
});
