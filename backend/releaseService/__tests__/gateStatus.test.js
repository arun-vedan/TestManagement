const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// WP-025 — GET /api/v1/releases/:id/gate-status acceptance suite.
//
// The WP's acceptance criterion is explicit: "gate status computes
// correctly against seeded data — construct BOTH a failing and a passing
// case in tests", not merely "the endpoint returns 200". So every fixture
// here is built by this suite from scratch (fresh TestPlan/TestExecution
// documents in testPlanExecutionService, a fresh Release in releaseService)
// rather than asserting against whatever the shared seeded dataset happens
// to contain right now — that dataset can and does drift between runs (see
// EXECUTION_LOG.md's hazard notes on leaked fixtures from other suites),
// which would make a hardcoded expected number brittle. The one exception
// is the maxOpenDefects case, which necessarily reads the shared
// srckube-defects data (open-defect counting is inherently
// project-wide, not fixture-scoped) — there, the suite queries the actual
// current count itself first and derives thresholds from it, rather than
// hardcoding an expected number.
//
// testPlanExecutionService is reached directly (bypasses Kong, matching its
// own __tests__/api.test.js convention). WP-021b: it is now tenant-scoped
// too (requireProjectScope() + authorize()), so tpesClient below also
// carries X-Project-Id: 1 -- every plan/execution this suite creates must
// land in the same Default Project that releaseService's own gate-status
// lookups are scoped to (releaseClient below), or evaluateMinPassRate's
// scoped TestExecution query would find nothing. releaseService is reached
// through Kong (X-Project-Id: 1, the seeded Default Project).

const TPES_URL = process.env.TEST_TPES_URL || 'http://localhost:8000';
const RELEASE_BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const PROJECT_SCOPE_HEADERS = { [PROJECT_ID_HEADER]: String(DEFAULT_PROJECT_ID) };

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

async function ensureDefaultProjectMembership(token) {
  const sub = decodeJwtPayload(token).sub;
  const userServiceClient = axios.create({
    baseURL: USER_SERVICE_URL,
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true
  });
  const listResp = await userServiceClient.get('/api/v1/projects');
  const defaultProject = listResp.data.data.find((p) => p.id === DEFAULT_PROJECT_ID);
  if (!defaultProject) {
    throw new Error(`Default Project (id=${DEFAULT_PROJECT_ID}) not found -- WP-020 backfill precondition unmet`);
  }
  await userServiceClient.post(`/api/v1/projects/${defaultProject._id}/members`, { userId: sub, role: 'admin' });
}

describe('releaseService gate-status (WP-025 acceptance)', () => {
  let tpesClient; // testPlanExecutionService, no project scope
  let releaseClient; // releaseService via Kong, X-Project-Id: 1

  const createdPlanIds = [];
  const createdExecutionIds = [];
  const createdReleaseIds = [];

  beforeAll(async () => {
    const token = await getServiceToken();
    await ensureDefaultProjectMembership(token);
    tpesClient = axios.create({ baseURL: TPES_URL, headers: { Authorization: `Bearer ${token}`, ...PROJECT_SCOPE_HEADERS }, validateStatus: () => true });
    releaseClient = axios.create({
      baseURL: RELEASE_BASE_URL,
      headers: { Authorization: `Bearer ${token}`, ...PROJECT_SCOPE_HEADERS },
      validateStatus: () => true
    });
  }, 15000);

  afterAll(async () => {
    // Clean up in dependency order: releases first (no FK, but tidy),
    // then executions, then plans — matches hazard note #5 (don't leak
    // fixtures across runs).
    for (const id of createdReleaseIds) {
      await releaseClient.delete(`/api/v1/releases/${id}`);
    }
    for (const id of createdExecutionIds) {
      await tpesClient.delete(`/api/v1/testexecution/${id}`);
    }
    for (const id of createdPlanIds) {
      await tpesClient.delete(`/api/v1/testplan/${id}`);
    }
  });

  async function makePlanWithExecution(testCases) {
    const planResp = await tpesClient.post('/api/v1/testplan', {});
    expect(planResp.status).toBe(201);
    const planId = planResp.data.data._id;
    createdPlanIds.push(planId);

    const execResp = await tpesClient.post('/api/v1/testexecution', {
      TestPlanId: planId,
      TestCases: testCases
    });
    expect(execResp.status).toBe(201);
    createdExecutionIds.push(execResp.data.data._id);

    return planId;
  }

  async function makeRelease(linkedTestPlanIds, qualityGates) {
    const resp = await releaseClient.post('/api/v1/releases', {
      name: `WP-025 gate-status fixture ${Date.now()}-${Math.random()}`,
      linkedTestPlanIds,
      qualityGates
    });
    expect(resp.status).toBe(201);
    createdReleaseIds.push(resp.data.data._id);
    return resp.data.data;
  }

  describe('minPassRate — passing case (constructed 100% pass fixture)', () => {
    it('green when actual pass rate meets the threshold', async () => {
      const planId = await makePlanWithExecution([
        { TestCaseId: 'TC-fixture-1', TestStatus: 'Pass' },
        { TestCaseId: 'TC-fixture-2', TestStatus: 'Pass' }
      ]);
      const release = await makeRelease([planId], [{ type: 'minPassRate', threshold: 80 }]);

      const resp = await releaseClient.get(`/api/v1/releases/${release._id}/gate-status`);
      expect(resp.status).toBe(200);
      expect(resp.data.data.rules).toHaveLength(1);
      const rule = resp.data.data.rules[0];
      expect(rule.type).toBe('minPassRate');
      expect(rule.details.totalTestCases).toBe(2);
      expect(rule.details.passedTestCases).toBe(2);
      expect(rule.actual).toBe(100);
      expect(rule.passed).toBe(true);
      expect(resp.data.data.overall).toBe('green');
      expect(resp.data.data.passed).toBe(true);
    });
  });

  describe('minPassRate — failing case (constructed 0% pass fixture)', () => {
    it('red when actual pass rate is below the threshold', async () => {
      const planId = await makePlanWithExecution([
        { TestCaseId: 'TC-fixture-3', TestStatus: 'Fail' },
        { TestCaseId: 'TC-fixture-4', TestStatus: 'No Run' }
      ]);
      const release = await makeRelease([planId], [{ type: 'minPassRate', threshold: 80 }]);

      const resp = await releaseClient.get(`/api/v1/releases/${release._id}/gate-status`);
      expect(resp.status).toBe(200);
      const rule = resp.data.data.rules[0];
      expect(rule.details.totalTestCases).toBe(2);
      expect(rule.details.passedTestCases).toBe(0);
      expect(rule.actual).toBe(0);
      expect(rule.passed).toBe(false);
      expect(resp.data.data.overall).toBe('red');
      expect(resp.data.data.passed).toBe(false);
    });
  });

  describe('minPassRate — no executions in linked plans is UNMET, not vacuously green', () => {
    it('red (not green) when a linked plan has zero test cases executed', async () => {
      const planResp = await tpesClient.post('/api/v1/testplan', {});
      expect(planResp.status).toBe(201);
      const planId = planResp.data.data._id;
      createdPlanIds.push(planId);

      const release = await makeRelease([planId], [{ type: 'minPassRate', threshold: 1 }]);
      const resp = await releaseClient.get(`/api/v1/releases/${release._id}/gate-status`);
      expect(resp.status).toBe(200);
      const rule = resp.data.data.rules[0];
      expect(rule.details.totalTestCases).toBe(0);
      expect(rule.passed).toBe(false);
      expect(resp.data.data.overall).toBe('red');
    });
  });

  describe('maxOpenDefects — derives thresholds from the live open-defect count', () => {
    let actualOpenHighSeverity;

    beforeAll(async () => {
      // A release with no linked plans and a very high threshold isolates
      // the maxOpenDefects rule's own actual count with no other rule
      // interfering, letting us read it back as ground truth.
      const probe = await makeRelease([], [{ type: 'maxOpenDefects', severity: 'High', threshold: 1000000 }]);
      const resp = await releaseClient.get(`/api/v1/releases/${probe._id}/gate-status`);
      expect(resp.status).toBe(200);
      actualOpenHighSeverity = resp.data.data.rules[0].actual;
      expect(typeof actualOpenHighSeverity).toBe('number');
    }, 15000);

    it('passing case: threshold set above the actual open count -> green', async () => {
      const release = await makeRelease(
        [],
        [{ type: 'maxOpenDefects', severity: 'High', threshold: actualOpenHighSeverity + 1 }]
      );
      const resp = await releaseClient.get(`/api/v1/releases/${release._id}/gate-status`);
      expect(resp.status).toBe(200);
      const rule = resp.data.data.rules[0];
      expect(rule.actual).toBe(actualOpenHighSeverity);
      expect(rule.passed).toBe(true);
      expect(resp.data.data.overall).toBe('green');
    });

    it('failing case: threshold set below the actual open count -> red (skipped if there are zero open High defects to under-cut)', async () => {
      if (actualOpenHighSeverity === 0) {
        // Nothing to under-cut — document rather than force a false fixture
        // (no open High-severity defects exist in the live dataset right
        // now). The passing-case test above still proves the rule computes
        // correctly; see EXECUTION_LOG.md for the actual observed count.
        return;
      }
      const release = await makeRelease(
        [],
        [{ type: 'maxOpenDefects', severity: 'High', threshold: actualOpenHighSeverity - 1 }]
      );
      const resp = await releaseClient.get(`/api/v1/releases/${release._id}/gate-status`);
      expect(resp.status).toBe(200);
      const rule = resp.data.data.rules[0];
      expect(rule.actual).toBe(actualOpenHighSeverity);
      expect(rule.passed).toBe(false);
      expect(resp.data.data.overall).toBe('red');
    });
  });

  describe('combined rules — overall is red if ANY rule fails, even when others pass', () => {
    it('mixed pass/fail rules -> overall red, per-rule breakdown still correct', async () => {
      const planId = await makePlanWithExecution([{ TestCaseId: 'TC-fixture-5', TestStatus: 'Pass' }]);
      const release = await makeRelease(
        [planId],
        [
          { type: 'minPassRate', threshold: 50 }, // 100% actual -> passes
          { type: 'maxOpenDefects', threshold: -1 } // impossible to satisfy -> fails
        ]
      );
      const resp = await releaseClient.get(`/api/v1/releases/${release._id}/gate-status`);
      expect(resp.status).toBe(200);
      const [passRateRule, defectsRule] = resp.data.data.rules;
      expect(passRateRule.passed).toBe(true);
      expect(defectsRule.passed).toBe(false);
      expect(resp.data.data.overall).toBe('red');
      expect(resp.data.data.passed).toBe(false);
    });
  });

  describe('no quality gates configured', () => {
    it('overall is green with an empty rule breakdown (vacuously true — nothing to fail)', async () => {
      const release = await makeRelease([], []);
      const resp = await releaseClient.get(`/api/v1/releases/${release._id}/gate-status`);
      expect(resp.status).toBe(200);
      expect(resp.data.data.rules).toEqual([]);
      expect(resp.data.data.overall).toBe('green');
    });
  });
});
