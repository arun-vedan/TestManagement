const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER, CORRELATION_HEADER } = require('@srckube/service-core');

// WP-024 — Audit log acceptance suite (black-box, GR-6).
//
// Proves the full write-then-read loop across all 5 entity types the WP
// brief names (test case, requirement, defect, plan, execution): each
// create/update/delete/status-change produces a correctly-attributed audit
// event, readable back through commentsService's new GET /api/v1/audit,
// project-scoped and viewer-accessible per WP-021/WP-022.
//
// The service-account token used throughout (getServiceToken()) is already
// an admin member of the seeded Default Project (id=1) -- see
// EXECUTION_LOG.md's "CURRENT VERIFIED STATE" note -- so no extra
// membership provisioning is needed here, unlike rbacMatrix.test.js which
// specifically needs multiple distinct personas/roles (a different WP-022
// concern this suite doesn't re-test).
//
// Each write request carries an explicit X-Correlation-Id so the matching
// audit event's correlationId can be asserted to be that EXACT value, not
// merely "present" -- a stronger proof that correlationId genuinely
// propagates from the originating request through to the audit record,
// rather than e.g. being coincidentally non-empty.
//
// testrepo/requirement/defects are reached directly (bypassing Kong,
// matching those services' own __tests__/api.test.js convention) so this
// suite isn't coupled to Kong's route set for services already proven
// reachable elsewhere; the audit read API itself IS reached through Kong,
// since proving its real Kong route (added by this WP) is part of the
// acceptance bar. testPlanExecutionService is reached directly with no
// project-scope header, matching its own suite's convention (WP-021 never
// rolled requireProjectScope() out to it).

const AUDIT_KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const TESTREPO_URL = process.env.TEST_TESTREPO_URL || 'http://localhost:8000';
const REQUIREMENT_URL = process.env.TEST_REQUIREMENT_URL || 'http://localhost:8000';
const DEFECT_URL = process.env.TEST_DEFECT_URL || 'http://localhost:8000';
const TPES_URL = process.env.TEST_TPES_URL || 'http://localhost:8000';

const DEFAULT_PROJECT_ID = 1;
const PROJECT_SCOPE_HEADERS = { [PROJECT_ID_HEADER]: String(DEFAULT_PROJECT_ID) };
const runId = Date.now();

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function corrHeaders(id) {
  return { [CORRELATION_HEADER]: id };
}

// requireProjectScope()'s in-process project-list cache (30s TTL, see
// service-core/middleware/projectScope.js) can occasionally make a
// just-added membership take a beat to be visible -- not a concern for this
// suite (the service account is already a standing admin member), but the
// SAME cache also fronts the audit route's own requireProjectScope() call
// on first use after a fresh container start, so a short retry on 403
// avoids a rare false failure at suite start, matching rbacMatrix.test.js's
// documented pattern.
async function withCacheRetry(fn, { retries = 5, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await fn();
    if (resp.status !== 403) return resp;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

describe('Audit log (WP-024 acceptance)', () => {
  let token;
  let actorSub;
  let auditClient; // Kong, X-Project-Id: 1
  let testrepoClient;
  let requirementClient;
  let defectClient;
  let tpesClient; // no project scope

  const createdTestCaseIds = [];
  const createdRequirementIds = [];
  const createdDefectIds = [];
  const createdTestPlanIds = [];
  const createdTestExecutionIds = [];

  beforeAll(async () => {
    token = await getServiceToken();
    actorSub = decodeJwtPayload(token).sub;

    const authHeaders = { Authorization: `Bearer ${token}` };
    auditClient = axios.create({
      baseURL: AUDIT_KONG_URL,
      headers: { ...authHeaders, ...PROJECT_SCOPE_HEADERS },
      validateStatus: () => true
    });
    testrepoClient = axios.create({
      baseURL: TESTREPO_URL,
      headers: { ...authHeaders, ...PROJECT_SCOPE_HEADERS },
      validateStatus: () => true
    });
    requirementClient = axios.create({
      baseURL: REQUIREMENT_URL,
      headers: { ...authHeaders, ...PROJECT_SCOPE_HEADERS },
      validateStatus: () => true
    });
    defectClient = axios.create({
      baseURL: DEFECT_URL,
      headers: { ...authHeaders, ...PROJECT_SCOPE_HEADERS },
      validateStatus: () => true
    });
    // WP-021b: testPlanExecutionService is now tenant-scoped too --
    // X-Project-Id required, same convention as every other client above.
    tpesClient = axios.create({
      baseURL: TPES_URL,
      headers: { ...authHeaders, ...PROJECT_SCOPE_HEADERS },
      validateStatus: () => true
    });
  }, 15000);

  afterAll(async () => {
    // Fixture cleanup (hazard #5) -- audit EVENTS themselves are
    // deliberately not cleaned up (there is no delete route for them by
    // design -- append-only), but the entities that generated them are.
    for (const id of createdTestCaseIds) {
      await testrepoClient.delete(`/api/v1/testrepo/${id}`);
    }
    for (const id of createdRequirementIds) {
      await requirementClient.delete(`/api/v1/requirement/${id}`);
    }
    for (const id of createdDefectIds) {
      await defectClient.delete(`/api/v1/defects/${id}`);
    }
    for (const id of createdTestExecutionIds) {
      await tpesClient.delete(`/api/v1/testexecution/${id}`);
    }
    for (const id of createdTestPlanIds) {
      await tpesClient.delete(`/api/v1/testplan/${id}`);
    }
  });

  async function findAuditEvent(entityType, entityId, action) {
    const resp = await withCacheRetry(() =>
      auditClient.get('/api/v1/audit', { params: { entityType, entityId, action, limit: 50 } })
    );
    expect(resp.status).toBe(200);
    return resp.data.data.find((evt) => evt.action === action && evt.entityId === entityId);
  }

  describe('read API: auth, project-scoping, append-only', () => {
    it('rejects an unauthenticated request', async () => {
      const anon = axios.create({ baseURL: AUDIT_KONG_URL, validateStatus: () => true });
      const resp = await anon.get('/api/v1/audit', { headers: PROJECT_SCOPE_HEADERS });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });

    it('rejects an authenticated request with no X-Project-Id header', async () => {
      const noScope = axios.create({
        baseURL: AUDIT_KONG_URL,
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true
      });
      const resp = await noScope.get('/api/v1/audit');
      expect(resp.status).toBe(403);
    });

    it('is append-only: no POST/PUT/PATCH/DELETE route exists at all', async () => {
      const postResp = await auditClient.post('/api/v1/audit', { actor: 'forged', entityType: 'x', entityId: 'x', action: 'create' });
      expect(postResp.status).toBe(404);

      const putResp = await auditClient.put('/api/v1/audit/000000000000000000000000', { action: 'tampered' });
      expect(putResp.status).toBe(404);

      const deleteResp = await auditClient.delete('/api/v1/audit/000000000000000000000000');
      expect(deleteResp.status).toBe(404);
    });

    it('returns 200 with a real list for an authenticated, project-scoped request', async () => {
      const resp = await withCacheRetry(() => auditClient.get('/api/v1/audit', { params: { limit: 1 } }));
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(Array.isArray(resp.data.data)).toBe(true);
    });
  });

  describe('test case: create/update/status-change/delete each produce a correctly-attributed event', () => {
    let testCaseId;
    let TestCaseId;

    it('create', async () => {
      const corrId = `wp024-tc-create-${runId}`;
      const resp = await testrepoClient.post(
        '/api/v1/testrepo',
        { TestCaseSummary: `WP-024 audit test case ${runId}`, TestCaseDescription: 'audit suite' },
        { headers: corrHeaders(corrId) }
      );
      expect(resp.status).toBe(201);
      testCaseId = resp.data.data._id;
      TestCaseId = resp.data.data.TestCaseId;
      createdTestCaseIds.push(testCaseId);

      const evt = await findAuditEvent('testcase', TestCaseId, 'create');
      expect(evt).toBeDefined();
      expect(evt.actor).toBe(actorSub);
      expect(evt.correlationId).toBe(corrId);
      expect(evt.projectId).toBe(DEFAULT_PROJECT_ID);
    });

    it('update', async () => {
      const corrId = `wp024-tc-update-${runId}`;
      const resp = await testrepoClient.put(
        `/api/v1/testrepo/${testCaseId}`,
        { TestCaseSummary: `WP-024 audit test case ${runId} (edited)` },
        { headers: corrHeaders(corrId) }
      );
      expect(resp.status).toBe(200);

      const evt = await findAuditEvent('testcase', TestCaseId, 'update');
      expect(evt).toBeDefined();
      expect(evt.actor).toBe(actorSub);
      expect(evt.correlationId).toBe(corrId);
    });

    it('status-change (draft -> review)', async () => {
      const corrId = `wp024-tc-status-${runId}`;
      const resp = await testrepoClient.put(
        `/api/v1/testrepo/${testCaseId}/status`,
        { status: 'review' },
        { headers: corrHeaders(corrId) }
      );
      expect(resp.status).toBe(200);

      const evt = await findAuditEvent('testcase', TestCaseId, 'status-change');
      expect(evt).toBeDefined();
      expect(evt.actor).toBe(actorSub);
      expect(evt.correlationId).toBe(corrId);
      expect(evt.summary).toEqual({ before: { status: 'draft' }, after: { status: 'review' } });
    });

    it('delete', async () => {
      const corrId = `wp024-tc-delete-${runId}`;
      const resp = await testrepoClient.delete(`/api/v1/testrepo/${testCaseId}`, { headers: corrHeaders(corrId) });
      expect(resp.status).toBe(200);
      createdTestCaseIds.length = 0; // already deleted, don't try again in afterAll

      const evt = await findAuditEvent('testcase', TestCaseId, 'delete');
      expect(evt).toBeDefined();
      expect(evt.actor).toBe(actorSub);
      expect(evt.correlationId).toBe(corrId);
    });
  });

  describe('requirement: create/update/status-change/delete each produce a correctly-attributed event', () => {
    let requirementId;
    let reqId;

    it('create', async () => {
      const corrId = `wp024-req-create-${runId}`;
      const resp = await requirementClient.post(
        '/api/v1/requirement',
        { requirementSummary: `WP-024 audit requirement ${runId}`, requirementDescription: 'audit suite' },
        { headers: corrHeaders(corrId) }
      );
      expect(resp.status).toBe(201);
      requirementId = resp.data.data._id;
      reqId = resp.data.data.reqId;
      createdRequirementIds.push(requirementId);

      const evt = await findAuditEvent('requirement', reqId, 'create');
      expect(evt).toBeDefined();
      expect(evt.actor).toBe(actorSub);
      expect(evt.correlationId).toBe(corrId);
    });

    it('update', async () => {
      const corrId = `wp024-req-update-${runId}`;
      const resp = await requirementClient.put(
        `/api/v1/requirement/${requirementId}`,
        { requirementSummary: `WP-024 audit requirement ${runId} (edited)` },
        { headers: corrHeaders(corrId) }
      );
      expect(resp.status).toBe(200);

      const evt = await findAuditEvent('requirement', reqId, 'update');
      expect(evt).toBeDefined();
      expect(evt.correlationId).toBe(corrId);
    });

    it('status-change (draft -> review)', async () => {
      const corrId = `wp024-req-status-${runId}`;
      const resp = await requirementClient.put(
        `/api/v1/requirement/${requirementId}/status`,
        { status: 'review' },
        { headers: corrHeaders(corrId) }
      );
      expect(resp.status).toBe(200);

      const evt = await findAuditEvent('requirement', reqId, 'status-change');
      expect(evt).toBeDefined();
      expect(evt.correlationId).toBe(corrId);
    });

    it('delete', async () => {
      const corrId = `wp024-req-delete-${runId}`;
      const resp = await requirementClient.delete(`/api/v1/requirement/${requirementId}`, { headers: corrHeaders(corrId) });
      expect(resp.status).toBe(200);
      createdRequirementIds.length = 0;

      const evt = await findAuditEvent('requirement', reqId, 'delete');
      expect(evt).toBeDefined();
      expect(evt.correlationId).toBe(corrId);
    });
  });

  describe('defect: create/update/status-change/delete each produce a correctly-attributed event', () => {
    let defectMongoId;
    let defectId;

    it('create', async () => {
      const corrId = `wp024-defect-create-${runId}`;
      const resp = await defectClient.post(
        '/api/v1/defects',
        { summary: `WP-024 audit defect ${runId}`, Priority: 'Low', Severity: 'Minor', description: 'audit suite', Status: 'New' },
        { headers: corrHeaders(corrId) }
      );
      expect(resp.status).toBe(201);
      defectMongoId = resp.data.data._id;
      defectId = resp.data.data.defectId;
      createdDefectIds.push(defectMongoId);

      const evt = await findAuditEvent('defect', defectId, 'create');
      expect(evt).toBeDefined();
      expect(evt.actor).toBe(actorSub);
      expect(evt.correlationId).toBe(corrId);
    });

    it('update', async () => {
      const corrId = `wp024-defect-update-${runId}`;
      const resp = await defectClient.put(
        `/api/v1/defects/${defectMongoId}`,
        { summary: `WP-024 audit defect ${runId} (edited)` },
        { headers: corrHeaders(corrId) }
      );
      expect(resp.status).toBe(200);

      const evt = await findAuditEvent('defect', defectId, 'update');
      expect(evt).toBeDefined();
      expect(evt.correlationId).toBe(corrId);
    });

    it('status-change (New -> Open, the one real valid edge)', async () => {
      const corrId = `wp024-defect-status-${runId}`;
      const resp = await defectClient.put(
        `/api/v1/defects/${defectMongoId}/status`,
        { status: 'Open' },
        { headers: corrHeaders(corrId) }
      );
      expect(resp.status).toBe(200);

      const evt = await findAuditEvent('defect', defectId, 'status-change');
      expect(evt).toBeDefined();
      expect(evt.correlationId).toBe(corrId);
      expect(evt.summary).toEqual({ before: { status: 'New' }, after: { status: 'Open' } });
    });

    it('delete', async () => {
      const corrId = `wp024-defect-delete-${runId}`;
      const resp = await defectClient.delete(`/api/v1/defects/${defectMongoId}`, { headers: corrHeaders(corrId) });
      expect(resp.status).toBe(200);
      createdDefectIds.length = 0;

      const evt = await findAuditEvent('defect', defectId, 'delete');
      expect(evt).toBeDefined();
      expect(evt.correlationId).toBe(corrId);
    });
  });

  describe('test plan: create/update/delete each produce a correctly-attributed event (WP-021b: projectId now verified, closing the old disclosed gap)', () => {
    let planMongoId;
    let TestPlanId;

    it('create', async () => {
      const corrId = `wp024-plan-create-${runId}`;
      const resp = await tpesClient.post('/api/v1/testplan', {}, { headers: corrHeaders(corrId) });
      expect(resp.status).toBe(201);
      planMongoId = resp.data.data._id;
      TestPlanId = resp.data.data.TestPlanId;
      createdTestPlanIds.push(planMongoId);

      const evt = await findAuditEvent('testplan', TestPlanId, 'create');
      expect(evt).toBeDefined();
      expect(evt.actor).toBe(actorSub);
      expect(evt.correlationId).toBe(corrId);
      expect(evt.projectId).toBe(DEFAULT_PROJECT_ID);
    });

    it('update', async () => {
      const corrId = `wp024-plan-update-${runId}`;
      const resp = await tpesClient.put(`/api/v1/testplan/${planMongoId}`, { objective: 'audit suite' }, { headers: corrHeaders(corrId) });
      expect(resp.status).toBe(200);

      const evt = await findAuditEvent('testplan', TestPlanId, 'update');
      expect(evt).toBeDefined();
      expect(evt.correlationId).toBe(corrId);
    });

    it('delete', async () => {
      const corrId = `wp024-plan-delete-${runId}`;
      const resp = await tpesClient.delete(`/api/v1/testplan/${planMongoId}`, { headers: corrHeaders(corrId) });
      expect(resp.status).toBe(200);
      createdTestPlanIds.length = 0;

      const evt = await findAuditEvent('testplan', TestPlanId, 'delete');
      expect(evt).toBeDefined();
      expect(evt.correlationId).toBe(corrId);
    });
  });

  describe('test execution: create/update/delete each produce a correctly-attributed event (WP-021b: projectId now verified, closing the old disclosed gap)', () => {
    let execMongoId;
    let TestExecutionId;

    it('create', async () => {
      const corrId = `wp024-exec-create-${runId}`;
      const resp = await tpesClient.post('/api/v1/testexecution', {}, { headers: corrHeaders(corrId) });
      expect(resp.status).toBe(201);
      execMongoId = resp.data.data._id;
      TestExecutionId = resp.data.data.TestExecutionId;
      createdTestExecutionIds.push(execMongoId);

      const evt = await findAuditEvent('testexecution', TestExecutionId, 'create');
      expect(evt).toBeDefined();
      expect(evt.actor).toBe(actorSub);
      expect(evt.correlationId).toBe(corrId);
      expect(evt.projectId).toBe(DEFAULT_PROJECT_ID);
    });

    it('update', async () => {
      const corrId = `wp024-exec-update-${runId}`;
      const resp = await tpesClient.put(`/api/v1/testexecution/${execMongoId}`, { assignedTo: actorSub }, { headers: corrHeaders(corrId) });
      expect(resp.status).toBe(200);

      const evt = await findAuditEvent('testexecution', TestExecutionId, 'update');
      expect(evt).toBeDefined();
      expect(evt.correlationId).toBe(corrId);
    });

    it('delete', async () => {
      const corrId = `wp024-exec-delete-${runId}`;
      const resp = await tpesClient.delete(`/api/v1/testexecution/${execMongoId}`, { headers: corrHeaders(corrId) });
      expect(resp.status).toBe(200);
      createdTestExecutionIds.length = 0;

      const evt = await findAuditEvent('testexecution', TestExecutionId, 'delete');
      expect(evt).toBeDefined();
      expect(evt.correlationId).toBe(corrId);
    });
  });

  describe('filters', () => {
    it('filters by actor', async () => {
      const resp = await withCacheRetry(() => auditClient.get('/api/v1/audit', { params: { actor: actorSub, limit: 5 } }));
      expect(resp.status).toBe(200);
      expect(resp.data.data.length).toBeGreaterThan(0);
      resp.data.data.forEach((evt) => expect(evt.actor).toBe(actorSub));
    });

    it('filters by action', async () => {
      const resp = await withCacheRetry(() => auditClient.get('/api/v1/audit', { params: { action: 'create', limit: 20 } }));
      expect(resp.status).toBe(200);
      resp.data.data.forEach((evt) => expect(evt.action).toBe('create'));
    });

    it('filters by dateFrom in the future, returning nothing', async () => {
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const resp = await withCacheRetry(() => auditClient.get('/api/v1/audit', { params: { dateFrom: future } }));
      expect(resp.status).toBe(200);
      expect(resp.data.data).toHaveLength(0);
    });

    it('filters by entityType', async () => {
      const resp = await withCacheRetry(() => auditClient.get('/api/v1/audit', { params: { entityType: 'testcase', limit: 50 } }));
      expect(resp.status).toBe(200);
      resp.data.data.forEach((evt) => expect(evt.entityType).toBe('testcase'));
    });
  });
});
