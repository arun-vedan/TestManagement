const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-040 — hand-verified figures: "every endpoint returns correct numbers
// against seeded data -- hand-verify one of each in tests".
//
// WHY THIS SUITE SEEDS ITS OWN PROJECT. It used to assert hand-counted totals
// against project 1 -- the shared dev project people and other suites keep
// writing to. Every new defect or run moved a figure, so it failed 6 of 7
// tests in every full sweep (project 1 grew from 3 defects to 4, a workload
// from 7 to 8, a pass-rate bucket aged out of its window). A sweep that is
// always red teaches everyone to ignore sweeps, which is how a real regression
// gets through. Asserting deltas against project 1 would still race any
// concurrent writer.
//
// So each run creates a fresh organization + project, seeds the small dataset
// below through the real APIs, and asserts EXACT figures derived by hand from
// it. Nothing else writes to that project, so the figures cannot drift, and the
// project and everything in it are purged afterwards (fixtureCleanup).
//
// THE DATASET (every expected number below is derived from this, by hand)
//
//   Requirements R1..R5.   Test cases C1..C4.   Plans P1, P2.
//
//   Links, requirement <-> case:
//     R1 <-> C1   written in BOTH directions, as the UI's double-write does
//     R2  -> C2
//     R3  -> C2, R3 -> C3
//     R4  -> C4
//     R5  -> TC-NOT-IN-THIS-PROJECT   (dangling id; must be ignored)
//
//   Executions, created in this order (latest result per case wins):
//     E1  plan P1, user A:  C1 Pass,  C2 Pass
//     E2  plan P1, user A:  C3 Fail,  C4 Blocked
//     E3  plan P2, user B:  C1 InProgress          <- newer than E1's Pass
//
//   Latest status per case: C1 InProgress, C2 Pass, C3 Fail, C4 Blocked.
//
//   Defects:  D1 New/High,  D2 Open/High,  D3 Closed/Low.
//   Links, defect -> ...:
//     D1 -> R1 and D1 -> C1   (reaches R1 by both edges: must count once)
//     D2 -> R2
//     D3 -> C3                (case edge only: reaches R3 through C3)

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const MODULE = { TEST_CASE: 1, REQUIREMENT: 2, DEFECT: 5 };
const runId = Date.now();
const USER_A = `hvf-user-a-${runId}`;
const USER_B = `hvf-user-b-${runId}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// requireProjectScope() caches membership per (caller, project) for
// PROJECT_SCOPE_CACHE_TTL_MS, so the first write into a brand-new project can
// briefly see 403. Same retry the tenant-isolation suites use.
async function withScopeRetry(fn, { retries = 10, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await fn();
    if (resp.status !== 403) return resp;
    await sleep(delayMs);
  }
  return resp;
}

function seriesValue(data, seriesId, category) {
  const idx = data.categories.indexOf(category);
  if (idx < 0) throw new Error(`category ${category} not in ${JSON.stringify(data.categories)}`);
  return data.series.find((s) => s.id === seriesId).data[idx];
}

describe('reportingService hand-verified figures (own seeded project)', () => {
  let client;
  const ids = {};

  async function create(path, body, label) {
    const resp = await withScopeRetry(() => client.post(path, body));
    if (resp.status !== 201 && resp.status !== 200) {
      throw new Error(`seeding ${label} failed: ${resp.status} ${JSON.stringify(resp.data)}`);
    }
    return resp.data.data;
  }

  async function link(sourceId, srcModule, destinationId, destinationModule) {
    return create(
      '/api/v1/linkIssue',
      { sourceId, srcModule, destinationId, destinationModule, linkType: 'relates-to' },
      `link ${sourceId} -> ${destinationId}`
    );
  }

  beforeAll(async () => {
    const token = await getServiceToken();
    const userClient = axios.create({
      baseURL: USER_SERVICE_URL,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });

    const org = await userClient.post('/api/v1/organizations', {
      name: `HVF org ${runId}`,
      key: `hvf-org-${runId}`
    });
    expect(org.status).toBe(201);
    trackOrganization(org.data.data._id);

    const project = await userClient.post('/api/v1/projects', {
      name: `HVF project ${runId}`,
      key: `hvf-proj-${runId}`,
      organizationId: org.data.data._id
    });
    expect(project.status).toBe(201);
    ids.projectId = project.data.data.id;
    trackProject(ids.projectId);

    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: String(ids.projectId) },
      validateStatus: () => true
    });

    // --- requirements and cases ---
    for (const n of [1, 2, 3, 4, 5]) {
      const r = await create('/api/v1/requirement', { requirementSummary: `HVF requirement ${n}`, requirementDescription: 'hand-verified figures fixture' }, `R${n}`);
      ids[`R${n}`] = r.reqId;
    }
    for (const n of [1, 2, 3, 4]) {
      const c = await create('/api/v1/testrepo', { TestCaseSummary: `HVF case ${n}`, TestCaseDescription: 'hand-verified figures fixture' }, `C${n}`);
      ids[`C${n}`] = c.TestCaseId;
    }

    // --- requirement <-> case links ---
    await link(ids.R1, MODULE.REQUIREMENT, ids.C1, MODULE.TEST_CASE);
    await link(ids.C1, MODULE.TEST_CASE, ids.R1, MODULE.REQUIREMENT); // the mirrored half
    await link(ids.R2, MODULE.REQUIREMENT, ids.C2, MODULE.TEST_CASE);
    await link(ids.R3, MODULE.REQUIREMENT, ids.C2, MODULE.TEST_CASE);
    await link(ids.R3, MODULE.REQUIREMENT, ids.C3, MODULE.TEST_CASE);
    await link(ids.R4, MODULE.REQUIREMENT, ids.C4, MODULE.TEST_CASE);
    await link(ids.R5, MODULE.REQUIREMENT, 'TC-NOT-IN-THIS-PROJECT', MODULE.TEST_CASE);

    // --- plans and executions (order matters: latest result wins) ---
    const p1 = await create('/api/v1/testplan', { testPlanName: 'HVF plan 1' }, 'P1');
    const p2 = await create('/api/v1/testplan', { testPlanName: 'HVF plan 2' }, 'P2');
    ids.P1 = p1.TestPlanId;
    ids.P2 = p2.TestPlanId;

    const run = (planMongoId, assignedTo, cases, label) =>
      create(
        '/api/v1/testexecution',
        {
          TestPlanId: planMongoId,
          assignedTo,
          TestCases: cases.map(([key, TestStatus]) => ({ TestCaseId: ids[key], TestStatus }))
        },
        label
      );
    ids.E1 = await run(p1._id, USER_A, [['C1', 'Pass'], ['C2', 'Pass']], 'E1');
    await sleep(50); // distinct timestamps, so "latest wins" is unambiguous
    ids.E2 = await run(p1._id, USER_A, [['C3', 'Fail'], ['C4', 'Blocked']], 'E2');
    await sleep(50);
    ids.E3 = await run(p2._id, USER_B, [['C1', 'InProgress']], 'E3');

    // --- defects and their links ---
    const d1 = await create('/api/v1/defects', { summary: 'HVF defect 1', Status: 'New', Severity: 'High' }, 'D1');
    const d2 = await create('/api/v1/defects', { summary: 'HVF defect 2', Status: 'Open', Severity: 'High' }, 'D2');
    const d3 = await create('/api/v1/defects', { summary: 'HVF defect 3', Status: 'Closed', Severity: 'Low' }, 'D3');
    ids.D1 = d1.defectId;
    ids.D2 = d2.defectId;
    ids.D3 = d3.defectId;
    await link(ids.D1, MODULE.DEFECT, ids.R1, MODULE.REQUIREMENT);
    await link(ids.D1, MODULE.DEFECT, ids.C1, MODULE.TEST_CASE);
    await link(ids.D2, MODULE.DEFECT, ids.R2, MODULE.REQUIREMENT);
    await link(ids.D3, MODULE.DEFECT, ids.C3, MODULE.TEST_CASE);

    // Fresh compute of every cached report for this project.
    const refresh = await client.post('/api/v1/reports/refresh');
    expect(refresh.status).toBe(200);
    expect(refresh.data.reports.every((r) => r.success)).toBe(true);
  }, 90000);

  // Segments from the latest status per case:
  //   R1: C1 InProgress           -> not fully verified
  //   R2: C2 Pass                 -> executed, all passing
  //   R3: C2 Pass + C3 Fail       -> executed, failing (any failing wins)
  //   R4: C4 Blocked              -> not fully verified
  //   R5: only a dangling case id -> no tests linked
  // C1's older Pass (E1) must NOT make R1 passing: E3 is newer.
  it('coverage: 5 requirements, 4 tested; segments 1 / 2 / 1 / 1', async () => {
    const resp = await client.get('/api/v1/reports/coverage');
    expect(resp.status).toBe(200);
    expect(resp.data.data).toMatchObject({ label: 'Requirement coverage', total: 5, tested: 4, untested: 1 });
    expect(resp.data.data.segments).toEqual({
      noTestsLinked: 1,
      notFullyVerified: 2,
      executedFailing: 1,
      executedPassing: 1
    });
    expect(resp.data.data.breakdown.data.map((b) => [b.id, b.value])).toEqual([
      ['noTestsLinked', 1],
      ['notFullyVerified', 2],
      ['executedFailing', 1],
      ['executedPassing', 1]
    ]);
  });

  // 3 defects, statuses resolved by name through the project's own workflow
  // (seeded at project creation). All created seconds ago -> 0-7 days.
  it('defect-summary: New 1 / Open 1 / Closed 1; High 2 / Low 1; all 0-7 days', async () => {
    const resp = await client.get('/api/v1/reports/defect-summary');
    expect(resp.status).toBe(200);
    const { data } = resp.data;
    expect(data.total).toBe(3);

    const statusCounts = {};
    data.byStatus.categories.forEach((c, i) => {
      statusCounts[c] = data.byStatus.series[0].data[i];
    });
    expect(statusCounts).toEqual({ New: 1, Open: 1, Closed: 1 });

    const severity = Object.fromEntries(data.bySeverity.data.map((d) => [d.id, d.value]));
    expect(severity).toEqual({ High: 2, Low: 1 });

    expect(data.byAge.categories).toEqual(['0-7 days', '8-30 days', '31-90 days', '90+ days']);
    expect(data.byAge.series[0].data).toEqual([3, 0, 0, 0]);
  });

  // Executed = any status other than '' / 'No Run'.
  //   P1: E1 Pass, Pass; E2 Fail, Blocked -> executed 4, passed 2, blocked 1
  //   P2: E3 InProgress                   -> executed 1, passed 0, blocked 0
  it('plan-progress: P1 executed 4 / passed 2 / blocked 1; P2 executed 1 / passed 0 / blocked 0', async () => {
    const resp = await client.get('/api/v1/reports/plan-progress');
    expect(resp.status).toBe(200);
    const { data } = resp.data;
    expect(data.categories).toEqual([ids.P1, ids.P2]);
    expect(seriesValue(data, 'executed', ids.P1)).toBe(4);
    expect(seriesValue(data, 'passed', ids.P1)).toBe(2);
    expect(seriesValue(data, 'blocked', ids.P1)).toBe(1);
    expect(seriesValue(data, 'executed', ids.P2)).toBe(1);
    expect(seriesValue(data, 'passed', ids.P2)).toBe(0);
    expect(seriesValue(data, 'blocked', ids.P2)).toBe(0);
  });

  // Every test-case entry counts toward the day its execution was created
  // (UTC); a day with no executions is null, not 0%. All three executions are
  // created within seconds: 5 entries, 2 Pass -> 40%. If a run straddles UTC
  // midnight the entries split across two days; the expectation below is
  // grouped from the executions' own createdAt for exactly that case.
  it('pass-rate-trend: the seeded day is 40% (2 Pass of 5 entries); other days are null', async () => {
    const resp = await client.get('/api/v1/reports/pass-rate-trend', { params: { days: 7 } });
    expect(resp.status).toBe(200);
    const { data } = resp.data;

    const entries = [
      [ids.E1, ['Pass', 'Pass']],
      [ids.E2, ['Fail', 'Blocked']],
      [ids.E3, ['InProgress']]
    ];
    const byDay = {};
    entries.forEach(([execution, statuses]) => {
      const day = new Date(execution.createdAt).toISOString().slice(0, 10);
      byDay[day] = byDay[day] || { pass: 0, total: 0 };
      statuses.forEach((s) => {
        byDay[day].total += 1;
        if (s === 'Pass') byDay[day].pass += 1;
      });
    });
    const days = Object.keys(byDay);
    if (days.length === 1) {
      expect(byDay[days[0]]).toEqual({ pass: 2, total: 5 });
    }

    data.xLabels.forEach((day, i) => {
      const expected = byDay[day] ? Math.round((byDay[day].pass / byDay[day].total) * 10000) / 100 : null;
      expect([day, data.series[0].data[i]]).toEqual([day, expected]);
    });
    days.forEach((day) => expect(data.xLabels).toContain(day));
  });

  // Completed = every entry is Pass or Fail.
  //   user A: E1 (Pass, Pass) completed; E2 (Fail, Blocked) not -> 2 / 1
  //   user B: E3 (InProgress) not                               -> 1 / 0
  it('workload: user A assigned 2 / completed 1; user B assigned 1 / completed 0', async () => {
    const resp = await client.get('/api/v1/reports/workload');
    expect(resp.status).toBe(200);
    const { data } = resp.data;
    expect(data.categories.slice().sort()).toEqual([USER_A, USER_B].sort());
    expect(seriesValue(data, 'assigned', USER_A)).toBe(2);
    expect(seriesValue(data, 'completed', USER_A)).toBe(1);
    expect(seriesValue(data, 'assigned', USER_B)).toBe(1);
    expect(seriesValue(data, 'completed', USER_B)).toBe(0);
  });

  // Same ground truth as coverage, row by row. Defects:
  //   R1: D1 via the direct edge AND via C1 -> listed once
  //   R2: D2 direct
  //   R3: D3 via C3 only (no direct edge)   -> proves the case path is walked
  //   R4, R5: none
  it('traceability: rows carry linked cases with latest status and deduplicated defects', async () => {
    const resp = await client.get('/api/v1/reports/traceability');
    expect(resp.status).toBe(200);
    const { data } = resp.data;
    expect(data.total).toBe(5);
    const row = Object.fromEntries(data.rows.map((r) => [r.reqId, r]));
    const caseStatuses = (r) => Object.fromEntries(r.testCases.map((tc) => [tc.TestCaseId, tc.status]));
    const defectIds = (r) => r.defects.map((d) => d.defectId).sort();

    expect(caseStatuses(row[ids.R1])).toEqual({ [ids.C1]: 'InProgress' });
    expect(row[ids.R1].segment).toBe('notFullyVerified');
    expect(defectIds(row[ids.R1])).toEqual([ids.D1]);
    expect(row[ids.R1].defects[0]).toMatchObject({ Status: 'New', Severity: 'High' });

    expect(caseStatuses(row[ids.R2])).toEqual({ [ids.C2]: 'Pass' });
    expect(row[ids.R2].segment).toBe('executedPassing');
    expect(defectIds(row[ids.R2])).toEqual([ids.D2]);

    expect(caseStatuses(row[ids.R3])).toEqual({ [ids.C2]: 'Pass', [ids.C3]: 'Fail' });
    expect(row[ids.R3].testCount).toBe(2);
    expect(row[ids.R3].segment).toBe('executedFailing');
    expect(defectIds(row[ids.R3])).toEqual([ids.D3]);

    expect(caseStatuses(row[ids.R4])).toEqual({ [ids.C4]: 'Blocked' });
    expect(row[ids.R4].segment).toBe('notFullyVerified');
    expect(row[ids.R4].defects).toEqual([]);

    expect(row[ids.R5]).toMatchObject({ testCount: 0, testCases: [], defects: [], segment: 'noTestsLinked' });

    // R3 end to end: the rows' segment tally equals coverage's for this project.
    const coverage = await client.get('/api/v1/reports/coverage');
    const tally = { noTestsLinked: 0, notFullyVerified: 0, executedFailing: 0, executedPassing: 0 };
    data.rows.forEach((r) => {
      tally[r.segment] += 1;
    });
    expect(tally).toEqual(coverage.data.data.segments);
  });

  // release-readiness reuses releaseService's own gate evaluation. Open =
  // a status with no onward transition is terminal: D1 New and D2 Open are
  // open, D3 Closed is not -> actual 2 against a threshold of 0 -> red.
  it('release-readiness: a maxOpenDefects:0 release sees 2 open defects and rolls up red', async () => {
    const release = await create(
      '/api/v1/releases',
      { name: `HVF release ${runId}`, qualityGates: [{ type: 'maxOpenDefects', threshold: 0 }] },
      'release'
    );

    const gate = await client.get(`/api/v1/releases/${release._id}/gate-status`);
    expect(gate.status).toBe(200);
    expect(gate.data.data.overall).toBe('red');
    expect(gate.data.data.rules[0].actual).toBe(2);

    expect((await client.post('/api/v1/reports/refresh')).status).toBe(200);
    const resp = await client.get('/api/v1/reports/release-readiness');
    expect(resp.status).toBe(200);
    const { data } = resp.data;
    expect(data.total).toBe(1);
    expect(data.rollup.data.map((d) => [d.id, d.value])).toEqual(
      expect.arrayContaining([['green', 0], ['red', 1]])
    );
    expect(data.releases.find((r) => r.releaseId === release.releaseId)).toMatchObject({
      overall: 'red',
      passed: false,
      ruleCount: 1
    });
  });
});

// Purge the fixture project and every document that belongs to it.
afterAll(() => {
  purgeTrackedFixtures();
});
