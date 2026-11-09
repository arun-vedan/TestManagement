// WP-F07a Task 3 -- substituteSteps() unit tests, and the `?substitute=
// <rowIndex>` route behaviour on both GET /api/v1/testrepo and
// GET /api/v1/testrepo/:id.
//
// Two harnesses in one file, same split placeholders.test.js/
// expandSteps.test.js already use:
//
// substituteSteps() itself (utils/substituteSteps.js) is a plain, pure
// function with zero collaborators -- nothing here needs a live container
// or Mongo, so it gets a fast in-process unit section.
//
// The route-level behaviour -- opt-in via query param, R4's expand-before-
// substitute ordering against a REAL shared step, R2's `expand=steps`-alone
// guard, the two 400 error cases, and R3's authored-text regression guard
// -- needs the live container: real routing, a real bound Dataset, and a
// real SharedStep expansion. Follows this service's established black-box
// HTTP convention (api.test.js/dataset.test.js/placeholders.test.js):
// reached directly against the running container (BASE_URL), bypassing
// Kong, since keycloak.protect() verifies the JWT itself independent of
// Kong.
const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { substituteSteps } = require('../utils/substituteSteps');

describe('substituteSteps (pure)', () => {
  it('substitutes a matched placeholder in both testStep and Expected, and keeps the authored text alongside it', () => {
    const docs = [{
      TestCaseId: 'TC-1',
      TestSteps: [{ testStep: 'Log in as {{username}}', Expected: '{{username}} sees the dashboard' }],
    }];

    const [out] = substituteSteps(docs, ['username'], ['alice']);

    expect(out.TestSteps[0]).toMatchObject({
      testStep: 'Log in as alice',
      Expected: 'alice sees the dashboard',
      authoredTestStep: 'Log in as {{username}}',
      authoredExpected: '{{username}} sees the dashboard',
      substituted: true,
    });
  });

  it('leaves an unmatched placeholder visible as {{name}}, never blanked (R5)', () => {
    const docs = [{
      TestCaseId: 'TC-2',
      TestSteps: [{ testStep: 'Log in as {{username}}, role {{role}}', Expected: 'ok' }],
    }];

    // Single-line break: falling back to '' instead of `match` for an
    // unmatched name here would produce 'Log in as alice, role ' --
    // indistinguishable from an author who simply left that text blank.
    const [out] = substituteSteps(docs, ['username'], ['alice']);

    expect(out.TestSteps[0].testStep).toBe('Log in as alice, role {{role}}');
  });

  it('substitutes every repeated occurrence of the same placeholder in one string', () => {
    const docs = [{
      TestCaseId: 'TC-3',
      TestSteps: [{ testStep: '{{role}} logs in, then {{role}} logs out', Expected: 'ok' }],
    }];

    const [out] = substituteSteps(docs, ['role'], ['admin']);

    expect(out.TestSteps[0].testStep).toBe('admin logs in, then admin logs out');
  });

  it('leaves a step with no placeholders unchanged apart from the substituted marker and authored-text mirror', () => {
    const docs = [{ TestCaseId: 'TC-4', TestSteps: [{ testStep: 'plain', Expected: 'plain ok' }] }];

    const [out] = substituteSteps(docs, ['username'], ['alice']);

    expect(out.TestSteps[0]).toMatchObject({
      testStep: 'plain',
      Expected: 'plain ok',
      authoredTestStep: 'plain',
      authoredExpected: 'plain ok',
      substituted: true,
    });
  });

  it('does not mutate a document it was not given (no accidental shared-reference mutation)', () => {
    const original = { TestCaseId: 'TC-5', TestSteps: [{ testStep: '{{x}}', Expected: '{{x}}' }] };
    const clone = JSON.parse(JSON.stringify(original));

    substituteSteps([clone], ['x'], ['value']);

    // original (never passed in) is untouched.
    expect(original.TestSteps[0].testStep).toBe('{{x}}');
    expect(original.TestSteps[0].substituted).toBeUndefined();
  });
});

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const runId = Date.now();

const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

describe('?substitute=<rowIndex> on the read routes (WP-F07a Task 3)', () => {
  let client;
  const createdTestCaseIds = [];
  const createdDatasetIds = [];
  const createdSharedStepIds = [];

  beforeAll(async () => {
    const token = await getServiceToken();
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });
  }, 30000);

  afterAll(async () => {
    // Test cases BEFORE the datasets/shared steps they reference -- both
    // Task 1's dataset delete guard and WP-F06's shared-step delete guard
    // refuse a delete while a referencing test case still exists, so
    // deleting referencers first is required for this cleanup to actually
    // succeed rather than leak a document every run.
    for (const id of createdTestCaseIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testrepo/${id}`, withScope(1)).catch(() => {});
    }
    for (const id of createdDatasetIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/dataset/${id}`, withScope(1)).catch(() => {});
    }
    for (const id of createdSharedStepIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/sharedstep/${id}`, withScope(1)).catch(() => {});
    }
  }, 30000);

  // Shared fixture: a dataset with two rows, and a bound test case whose
  // own step text references 'username' (present in both rows) and
  // 'missingCol' (present in neither -- the R5 case).
  let datasetId;
  let testCaseId;
  let testCaseMongoId;

  beforeAll(async () => {
    const dataset = await client.post(
      '/api/v1/dataset',
      {
        title: `WP-F07a substitute fixture dataset ${runId}`,
        columns: ['username', 'role'],
        rows: [['alice', 'admin'], ['bob', 'viewer']],
      },
      withScope(1)
    );
    expect(dataset.status).toBe(201);
    datasetId = dataset.data.data._id;
    createdDatasetIds.push(datasetId);

    const tc = await client.post(
      '/api/v1/testrepo',
      {
        TestCaseSummary: `WP-F07a substitute fixture case ${runId}`,
        TestCaseDescription: 'x',
        datasetId,
        TestSteps: [
          { testStep: 'Log in as {{username}}', Expected: '{{username}} sees {{missingCol}}' },
        ],
      },
      withScope(1)
    );
    expect(tc.status).toBe(201);
    testCaseMongoId = tc.data.data._id;
    testCaseId = tc.data.data.TestCaseId;
    createdTestCaseIds.push(testCaseMongoId);
  }, 30000);

  // R3's regression guard -- the single most valuable test in this task.
  // A plain read, no query params at all, must return authored text with
  // every {{placeholder}} intact. If substitution ever became the
  // default, or a substituted value leaked back into a stored document
  // and was read back here, this is what would catch it.
  it('a read with no substitute param returns authored text with placeholders intact (R3 regression guard)', async () => {
    const res = await client.get(`/api/v1/testrepo/${testCaseMongoId}`, withScope(1));
    expect(res.status).toBe(200);
    expect(res.data.data.TestSteps[0].testStep).toBe('Log in as {{username}}');
    expect(res.data.data.TestSteps[0].Expected).toBe('{{username}} sees {{missingCol}}');
    expect(res.data.data.TestSteps[0].substituted).toBeUndefined();
    expect(res.data.data.TestSteps[0].authoredTestStep).toBeUndefined();
  });

  it('?substitute=0 substitutes row 0 and keeps authored text alongside it', async () => {
    const res = await client.get(`/api/v1/testrepo/${testCaseMongoId}?substitute=0`, withScope(1));
    expect(res.status).toBe(200);
    const step = res.data.data.TestSteps[0];
    expect(step.substituted).toBe(true);
    expect(step.testStep).toBe('Log in as alice');
    expect(step.authoredTestStep).toBe('Log in as {{username}}');
    // 'missingCol' has no matching column -- R5: left visible, not blanked.
    expect(step.Expected).toBe('alice sees {{missingCol}}');
    expect(step.authoredExpected).toBe('{{username}} sees {{missingCol}}');
  });

  it('?substitute=1 substitutes row 1 (a different row than row 0)', async () => {
    const res = await client.get(`/api/v1/testrepo/${testCaseMongoId}?substitute=1`, withScope(1));
    expect(res.status).toBe(200);
    expect(res.data.data.TestSteps[0].testStep).toBe('Log in as bob');
  });

  it('an out-of-range row index is 400, not a silent empty substitution', async () => {
    const res = await client.get(`/api/v1/testrepo/${testCaseMongoId}?substitute=99`, withScope(1));
    expect(res.status).toBe(400);
  });

  it('a non-numeric substitute value is 400', async () => {
    const res = await client.get(`/api/v1/testrepo/${testCaseMongoId}?substitute=notanumber`, withScope(1));
    expect(res.status).toBe(400);
  });

  // Fix round 1 (review, Important) -- `Number(rawIndex)` coerces every
  // one of these into a valid-looking non-negative integer (`Number('')
  // === 0`, `Number('0x1') === 1`, `Number('+0') === 0`), so before this
  // fix each one silently substituted a real row instead of rejecting.
  // The empty-string case is the realistic one: a client UI with an unset
  // "which row?" dropdown sends exactly `?substitute=`, and the author
  // would see substituted values they never asked for with no error to
  // explain why. resolveSubstitutionRow() now accepts only a canonical
  // non-negative decimal integer string (utils regex CANONICAL_ROW_INDEX
  // in controllers/testrepo.js) and rejects everything else, including
  // these, with 400 -- the same 400 an out-of-range index already gets.
  it.each([
    ['', '', 'empty string (e.g. an unset row-picker dropdown)'],
    ['0x1', '0x1', 'hex'],
    // '+' is form-encoded space in a URL query string (qs.parse('a=+0')
    // -> {a: ' 0'}, verified live) -- %2B is required to send a literal
    // '+' byte, which is the actual case Number('+0') === 0 exercises.
    ['%2B0', '+0', 'leading plus'],
    ['-1', '-1', 'negative'],
    ['1.5', '1.5', 'decimal'],
  ])("rejects a non-canonical substitute value %s (%s) with 400, not a silent substitution", async (encoded) => {
    const res = await client.get(`/api/v1/testrepo/${testCaseMongoId}?substitute=${encoded}`, withScope(1));
    expect(res.status).toBe(400);
  });

  // And the mirror image of every case above: a legitimate '0' must still
  // work -- the classic bug in this exact fix is a strict-parsing rewrite
  // whose validation (or a stray `if (!rowIndex)` downstream) treats a
  // real, intentional row 0 as falsy/empty and rejects or skips it too.
  it("still accepts a legitimate '0' after the strict-parsing fix", async () => {
    const res = await client.get(`/api/v1/testrepo/${testCaseMongoId}?substitute=0`, withScope(1));
    expect(res.status).toBe(200);
    expect(res.data.data.TestSteps[0].testStep).toBe('Log in as alice');
  });

  it('a case with no datasetId plus ?substitute=0 is 400', async () => {
    const tc = await client.post(
      '/api/v1/testrepo',
      { TestCaseSummary: `WP-F07a unbound substitute case ${runId}`, TestCaseDescription: 'x' },
      withScope(1)
    );
    expect(tc.status).toBe(201);
    createdTestCaseIds.push(tc.data.data._id);

    const res = await client.get(`/api/v1/testrepo/${tc.data.data._id}?substitute=0`, withScope(1));
    expect(res.status).toBe(400);
  });

  // R2, premise 3 -- the guard protecting execution enrichment
  // (backend/testPlanExecutionService) and the AI service
  // (backend/aiService), the only two callers of `expand=steps` alone.
  // Neither may ever receive substituted text.
  it('?expand=steps ALONE never substitutes', async () => {
    const res = await client.get(`/api/v1/testrepo/${testCaseMongoId}?expand=steps`, withScope(1));
    expect(res.status).toBe(200);
    const step = res.data.data.TestSteps[0];
    expect(step.testStep).toBe('Log in as {{username}}');
    expect(step.Expected).toBe('{{username}} sees {{missingCol}}');
    expect(step.substituted).toBeUndefined();
    expect(step.authoredTestStep).toBeUndefined();
  });

  it('?expand=steps alone never substitutes on the list route either', async () => {
    const res = await client.get(
      `/api/v1/testrepo?TestCaseId=${testCaseId}&expand=steps`,
      withScope(1)
    );
    expect(res.status).toBe(200);
    const doc = res.data.data.find((d) => d.TestCaseId === testCaseId);
    expect(doc).toBeDefined();
    expect(doc.TestSteps[0].testStep).toBe('Log in as {{username}}');
    expect(doc.TestSteps[0].substituted).toBeUndefined();
  });

  it('?substitute=0 also works on the list route, without a separate expand=steps', async () => {
    const res = await client.get(
      `/api/v1/testrepo?TestCaseId=${testCaseId}&substitute=0`,
      withScope(1)
    );
    expect(res.status).toBe(200);
    const doc = res.data.data.find((d) => d.TestCaseId === testCaseId);
    expect(doc).toBeDefined();
    expect(doc.TestSteps[0].testStep).toBe('Log in as alice');
    expect(doc.TestSteps[0].substituted).toBe(true);
  });

  // R4 -- the ordering requirement most likely to be gotten backwards. A
  // shared step's OWN text carries a placeholder; it only exists as plain
  // testStep/Expected text once the reference row has been expanded, so
  // expansion must run before substitution ever sees it.
  it('substitutes a placeholder that lives only inside an expanded shared step (R4)', async () => {
    const shared = await client.post(
      '/api/v1/sharedstep',
      {
        title: `WP-F07a substitute shared step ${runId}`,
        steps: [{ testStep: 'Confirm role {{role}}', Expected: '{{role}} dashboard shown' }],
      },
      withScope(1)
    );
    expect(shared.status).toBe(201);
    createdSharedStepIds.push(shared.data.data._id);

    const tc = await client.post(
      '/api/v1/testrepo',
      {
        TestCaseSummary: `WP-F07a substitute shared-step case ${runId}`,
        TestCaseDescription: 'x',
        datasetId,
        TestSteps: [
          { testStep: 'Open the app as {{username}}', Expected: 'ok' },
          { sharedStepId: shared.data.data._id },
        ],
      },
      withScope(1)
    );
    expect(tc.status).toBe(201);
    createdTestCaseIds.push(tc.data.data._id);

    const res = await client.get(`/api/v1/testrepo/${tc.data.data._id}?substitute=0`, withScope(1));
    expect(res.status).toBe(200);
    expect(res.data.data.TestSteps).toHaveLength(2);
    expect(res.data.data.TestSteps[0].testStep).toBe('Open the app as alice');
    // Single-line break: substituting BEFORE expanding would leave this
    // row as a bare {sharedStepId: ...} reference with no testStep/
    // Expected string at all to substitute into -- this row would come
    // back with '{{role}}' never resolved (or undefined entirely) instead
    // of the shared step's own text, substituted.
    expect(res.data.data.TestSteps[1].testStep).toBe('Confirm role admin');
    expect(res.data.data.TestSteps[1].Expected).toBe('admin dashboard shown');
    expect(res.data.data.TestSteps[1].authoredTestStep).toBe('Confirm role {{role}}');
  });
});
