// WP-F06 Task 3 -- generateTestCases' style-exemplar fetch from
// testRepoService must ask for ?expand=steps.
//
// HARNESS NOTE: every other suite that touches generate-testcases
// (__tests__/generateTestCases.test.js) is black-box, against the real
// running containers (Kong -> aiService -> requirementService/
// testRepoService) -- appropriate for proving auth/scope/persistence
// behavior. It CANNOT prove this particular thing: the `mock` AI_PROVIDER
// is deterministic and network-free by construction (providers/
// mockProvider.js's own header comment) and ignores the exemplar text
// entirely when building its response, so a black-box test can observe
// that generate-testcases returns well-formed candidates but not that the
// *request this service made to testRepoService* asked for expanded step
// text. Proving that requires inspecting the outbound request itself,
// which only an in-process test can do -- same reasoning and precedent as
// backend/testRepoService/__tests__/expandSteps.test.js (mocks the one DB
// collaborator, asserts on how it was called) and backend/shared/
// service-core/__tests__/advancedResults.test.js before it.
//
// WHY THIS MATTERS (restated from controllers/ai.js's own exemplarBlock
// comment): a test case's TestSteps can be a REFERENCE row ({sharedStepId},
// no testStep/Expected text -- WP-F06 Task 1/2) rather than literal text.
// Without ?expand=steps, an exemplar built from such a test case would
// read "- undefined => undefined" in the prompt sent to the model --
// silently broken style guidance, no error anywhere.
//
// TESTREPO_SERVICE/REQUIREMENT_SERVICE are read from process.env at
// controllers/ai.js's MODULE load time (top-level `const`), so they must
// be set before that module is first required below -- setting them in a
// beforeEach would be too late.
process.env.testRepoService = 'testreposervice:3000';
process.env.requirementService = 'requirementservice:3000';
delete process.env.REDIS_URI; // force checkAndIncrementDailyUsage's documented fail-open path, not a live Redis

jest.mock('@srckube/service-core', () => ({
  ...jest.requireActual('@srckube/service-core'),
  requestWithRetry: jest.fn()
}));
// AiInteraction.create() is a real Mongoose model with no live connection
// in this in-process test -- mocked purely so the call resolves instead of
// buffering forever.
jest.mock('../models/AiInteraction', () => ({
  ...jest.requireActual('../models/AiInteraction'),
  AiInteraction: { create: jest.fn().mockResolvedValue({}) }
}));

const { requestWithRetry } = require('@srckube/service-core');
const { generateTestCases } = require('../controllers/ai');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function baseReq(overrides = {}) {
  return {
    body: { requirementId: 'req-1', count: 1 },
    kauth: { grant: { access_token: { content: { sub: 'unit-test-user' } } } },
    projectScope: { projectId: 1 },
    correlationId: 'corr-wp-f06-task3',
    headers: { authorization: 'Bearer test-token' },
    ...overrides
  };
}

describe("generateTestCases' exemplar fetch (WP-F06 Task 3)", () => {
  beforeEach(() => {
    requestWithRetry.mockReset();
    requestWithRetry.mockImplementation(async ({ url }) => {
      if (url.includes('/requirement/')) {
        return {
          data: {
            data: {
              _id: 'req-1',
              reqId: 'REQ-1',
              requirementSummary: 'Users can log in',
              requirementDescription: 'A user enters valid credentials and reaches the dashboard.'
            }
          }
        };
      }
      if (url.includes('/testrepo')) {
        // Contents of the exemplar list don't matter for this assertion --
        // only the REQUEST testRepoService receives is under test here.
        return { data: { data: [] } };
      }
      throw new Error(`unexpected requestWithRetry url in this test: ${url}`);
    });
  });

  // Non-vacuous by construction, not just by assertion: manually verified
  // by deleting the `expand: 'steps'` line from controllers/ai.js's
  // exemplar-fetch params and re-running -- this test goes from green to
  // red on that exact one-line change (`exemplarCall.params` no longer has
  // an `expand` key at all, so `toMatchObject({ expand: 'steps' })` fails).
  // Restored immediately after, see the task report for the transcript.
  it('requests ?expand=steps when fetching approved test cases for style exemplars', async () => {
    const req = baseReq();
    const res = mockRes();
    const next = jest.fn();

    await generateTestCases(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);

    const exemplarCall = requestWithRetry.mock.calls
      .map(([opts]) => opts)
      .find((opts) => opts.url.includes('/testrepo'));
    expect(exemplarCall).toBeDefined();
    expect(exemplarCall.params).toMatchObject({ expand: 'steps' });
  });
});
