// WP-F06 Task 2 -- expandSteps() unit tests.
//
// HARNESS NOTE: every other suite in this service (api.test.js,
// sharedStep.test.js, etc.) is a black-box HTTP suite against the running
// container, because those files are proving routing/auth/tenant-scoping
// behavior that only exists once the whole container is wired up.
// expandSteps() itself is a plain, exported function with one collaborator
// (SharedStep.find) -- there is nothing here that needs a live container or
// a live Mongo connection, and this repo already has exactly this style of
// test for another pure module with a DB collaborator: shared/service-core's
// __tests__/advancedResults.test.js mocks its model's `find` and asserts on
// how it was called. This file follows that same precedent rather than the
// container-based one, and it's what makes the brief's literal requirement
// ("spy on SharedStep.find; assert callCount === 1") possible to satisfy at
// all -- a call count can't be observed from outside the container's process
// boundary.
//
// The mock below is not a dumb stub: it actually filters FIXTURES by the
// `_id`/`projectId` keys present in whatever filter object expandSteps()
// passes to SharedStep.find, the same way real MongoDB would. That's what
// makes the projectId-removal and dangling-reference non-vacuity probes
// (Step 8) land on the right test instead of everything staying green
// because the mock always returns the same canned array regardless of input.

jest.mock('../models/SharedStep', () => ({ find: jest.fn() }));

const SharedStep = require('../models/SharedStep');
const { expandSteps } = require('../utils/expandSteps');

const PROJECT_1 = 1;
const PROJECT_2 = 2;

const SS_LOGIN = '507f1f77bcf86cd799439011'; // project 1, 2 rows
const SS_OTHER_PROJECT = '507f1f77bcf86cd799439022'; // project 2
const SS_DANGLING = '507f1f77bcf86cd799439099'; // doesn't exist in FIXTURES

const FIXTURES = [
  {
    _id: SS_LOGIN,
    projectId: PROJECT_1,
    title: 'Log in as admin',
    steps: [
      { testStep: 'Open /login', Expected: 'Login form' },
      { testStep: 'Submit admin creds', Expected: 'Redirected to dashboard' },
    ],
  },
  {
    _id: SS_OTHER_PROJECT,
    projectId: PROJECT_2,
    title: 'Project 2 secret setup',
    steps: [{ testStep: 'Project 2 only step', Expected: 'should never leak' }],
  },
];

beforeEach(() => {
  SharedStep.find.mockReset();
  // Real-Mongo-shaped behavior: filters FIXTURES by whatever `_id.$in` and
  // (if present) `projectId` keys are actually in the filter object passed
  // in. Crucially, if the production code stops including a `projectId`
  // key in the filter at all (Step 8's probe 2), this mock does NOT filter
  // by project -- exactly like a real `SharedStep.find({_id: {$in:[...]}})`
  // with no projectId clause would return docs from every project.
  SharedStep.find.mockImplementation((filter) => ({
    lean: async () => FIXTURES.filter((s) => {
      if (!filter._id || !filter._id.$in.includes(String(s._id))) return false;
      if (Object.prototype.hasOwnProperty.call(filter, 'projectId') && s.projectId !== filter.projectId) {
        return false;
      }
      return true;
    }),
  }));
});

describe('expandSteps', () => {
  it('leaves a case with no references untouched', async () => {
    const doc = {
      TestCaseId: 'TC-1',
      TestSteps: [{ testStep: 'Plain step A', Expected: 'A ok' }],
    };
    const input = [JSON.parse(JSON.stringify(doc))];

    const out = await expandSteps(input, PROJECT_1);

    expect(out).toEqual([doc]);
    expect(SharedStep.find).not.toHaveBeenCalled();
  });

  it("replaces a reference row with the shared step's rows, in place", async () => {
    const input = [
      {
        TestCaseId: 'TC-2',
        TestSteps: [
          { testStep: 'Plain A', Expected: 'exp A' },
          { sharedStepId: SS_LOGIN },
          { testStep: 'Plain B', Expected: 'exp B' },
        ],
      },
    ];

    const [out] = await expandSteps(input, PROJECT_1);

    expect(out.TestSteps).toHaveLength(4);
    expect(out.TestSteps[0]).toMatchObject({ testStep: 'Plain A' });
    expect(out.TestSteps[1]).toMatchObject({ testStep: 'Open /login' });
    expect(out.TestSteps[2]).toMatchObject({ testStep: 'Submit admin creds' });
    expect(out.TestSteps[3]).toMatchObject({ testStep: 'Plain B' });
  });

  it('marks every expanded row with its origin', async () => {
    const input = [{ TestCaseId: 'TC-3', TestSteps: [{ sharedStepId: SS_LOGIN }] }];

    const [out] = await expandSteps(input, PROJECT_1);

    expect(out.TestSteps[0]).toMatchObject({
      sharedStepId: SS_LOGIN,
      sharedStepTitle: 'Log in as admin',
      sharedStepIndex: 0,
    });
    expect(out.TestSteps[1]).toMatchObject({
      sharedStepId: SS_LOGIN,
      sharedStepTitle: 'Log in as admin',
      sharedStepIndex: 1,
    });
  });

  it('drops a reference to a shared step that no longer exists rather than emitting a blank row', async () => {
    const input = [
      {
        TestCaseId: 'TC-4',
        TestSteps: [
          { testStep: 'Plain A', Expected: 'exp A' },
          { sharedStepId: SS_DANGLING },
          { testStep: 'Plain B', Expected: 'exp B' },
        ],
      },
    ];

    const [out] = await expandSteps(input, PROJECT_1);

    expect(out.TestSteps).toHaveLength(2);
    expect(out.TestSteps.some((s) => s.testStep === undefined)).toBe(false);
    expect(out.TestSteps.map((s) => s.testStep)).toEqual(['Plain A', 'Plain B']);
  });

  it('never expands a shared step from another project', async () => {
    const input = [
      {
        TestCaseId: 'TC-5',
        TestSteps: [{ sharedStepId: SS_OTHER_PROJECT }],
      },
    ];

    // Expanding for project 1, but SS_OTHER_PROJECT belongs to project 2.
    const [out] = await expandSteps(input, PROJECT_1);

    expect(out.TestSteps).toHaveLength(0);
    expect(JSON.stringify(out)).not.toMatch(/should never leak/);
  });

  // Review fix round 1, minor finding 2: this branch (Array.isArray(docs)
  // ? docs : [docs]) is reachable but had zero callers and zero coverage.
  // Every real call site today (controllers/testrepo.js) always passes an
  // array, even for a single test case -- but the tolerant signature is
  // being kept because a plausible single-doc caller could land in Task 3,
  // and an untested branch that silently does the wrong thing (e.g.
  // returns an array when given a plain object) would be worse than no
  // branch at all. This exercises it directly rather than leaving it dead.
  it('accepts a single document (not wrapped in an array) and returns that same shape, expanded', async () => {
    const doc = { TestCaseId: 'TC-6', TestSteps: [{ sharedStepId: SS_LOGIN }] };

    const out = await expandSteps(doc, PROJECT_1);

    expect(Array.isArray(out)).toBe(false);
    expect(out).toBe(doc); // mutated in place; the same object is returned, not a copy
    expect(out.TestSteps).toHaveLength(2);
    expect(out.TestSteps[0]).toMatchObject({ testStep: 'Open /login', sharedStepIndex: 0 });
    expect(out.TestSteps[1]).toMatchObject({ testStep: 'Submit admin creds', sharedStepIndex: 1 });
  });

  it('resolves all referenced shared steps in one query regardless of how many cases reference them', async () => {
    const docs = Array.from({ length: 5 }, (_, i) => ({
      TestCaseId: `TC-${100 + i}`,
      TestSteps: [
        { sharedStepId: SS_LOGIN },
        { sharedStepId: SS_LOGIN },
        { sharedStepId: SS_LOGIN },
      ],
    }));

    await expandSteps(docs, PROJECT_1);

    expect(SharedStep.find).toHaveBeenCalledTimes(1);
  });
});
