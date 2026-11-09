// WP-063b — per-spec data fixtures, created and destroyed over the real
// REST API (see ./api.ts for why the service token is used here).
//
// Why fixtures at all, rather than driving the seeded data in place:
//   - Test execution: project 1's seeded Run-1 has ZERO test cases attached
//     (verified live: GET /testexecution?projectId=1 -> Run-1.TestCases ===
//     []), and TestExecutionContent.tsx only renders the Play/Save controls
//     inside `{teTCDetails[0] && ...}`, i.e. once a test case in the run has
//     been selected. There is nothing to select on Run-1, so the journey
//     cannot start there. Some other seeded runs (Run-11/12/14) do have test
//     cases — but recording a result against them would permanently mutate
//     shared seeded data on every run, which is its own kind of litter.
//   - AI generation: accepting a candidate really does create a draft test
//     case plus two link documents (api/aiApi.ts#acceptCandidate). Pointing
//     that at a seeded requirement would accumulate a new orphan test case
//     per run forever.
// So each spec creates exactly what it needs, and deletes exactly that.
import { AxiosInstance } from 'axios';
import { personaUserId } from './api';

// ---------------------------------------------------------------------------
// Test execution
// ---------------------------------------------------------------------------

export interface TestExecutionFixture {
  /** Mongo _id — what DELETE /testexecution/:id takes. */
  id: string;
  /** Business key, e.g. "Run-428" — this is the tree row's visible label. */
  testExecutionId: string;
  /** The single attached test case's business key — the inner tree's label. */
  testCaseId: string;
}

/**
 * A test execution run with exactly one test case and two steps, both
 * starting at "No Run".
 *
 * The TestCases[] entry is deliberately written in the FULL "enriched"
 * shape the app expects rather than the minimal one:
 *   - `TestSteps` present means getExecutionTestCaseDetails (backend
 *     controllers/testexecution.js) serves it straight from this document
 *     instead of round-tripping to testRepoService to enrich it — so this
 *     fixture is self-contained and does not need a matching real test case
 *     in the repository.
 *   - `dynamicFields` must exist: TestExecutionContent.tsx renders every
 *     module-1 field via `teTCDetails[0].TestCases[0].dynamicFields[...]`
 *     with no guard, so a fixture without it crashes the tab on render.
 *     `TestCaseDescription` is read through JSON.parse() into ReactQuill, so
 *     it has to be a real Quill delta string.
 */
export async function createTestExecutionFixture(
  api: AxiosInstance,
  label: string
): Promise<TestExecutionFixture> {
  const testCaseId = `TC-E2E-${label}-${Date.now()}`;
  const delta = JSON.stringify({ ops: [{ insert: `${label} e2e fixture\n` }] });

  const resp = await api.post('/testexecution', {
    // Resolved to a username by the page's own /users/kcUser call on load.
    assignedTo: personaUserId(),
    TestCases: [
      {
        id: 1,
        parentId: 0,
        TestCaseId: testCaseId,
        TestCaseSummary: `WP-063b ${label} fixture test case`,
        TestStatus: 'No Run',
        attachment: [],
        TestCaseDescription: delta,
        dynamicFields: {
          TestCaseDescription: delta,
          TestcasePriority: 'High',
          TestScenario: `WP-063b ${label} fixture scenario`,
        },
        TestSteps: [
          { testStep: 'Fixture step one', Expected: 'Fixture expected one', status: 'No Run' },
          { testStep: 'Fixture step two', Expected: 'Fixture expected two', status: 'No Run' },
        ],
      },
    ],
  });

  const doc = resp.data?.data;
  if (!doc?._id || !doc?.TestExecutionId) {
    throw new Error(`Unexpected POST /testexecution response: ${JSON.stringify(resp.data).slice(0, 500)}`);
  }
  return { id: doc._id, testExecutionId: doc.TestExecutionId, testCaseId };
}

/** Reads one test case back out of a run — used to assert what was PERSISTED, not just rendered. */
export async function readExecutionTestCase(
  api: AxiosInstance,
  fixture: TestExecutionFixture
): Promise<any> {
  const resp = await api.get('/testexecution/getexecutiontc', {
    params: { tcid: fixture.testCaseId, exeid: fixture.testExecutionId },
  });
  return resp.data?.data?.[0]?.TestCases?.[0];
}

export async function deleteTestExecutionFixture(
  api: AxiosInstance,
  fixture: TestExecutionFixture | undefined
): Promise<void> {
  if (!fixture) return;
  await api.delete(`/testexecution/${fixture.id}`);
}

// ---------------------------------------------------------------------------
// Requirement (for the AI generation journey)
// ---------------------------------------------------------------------------

export interface RequirementFixture {
  /** Mongo _id — what DELETE /requirement/:id takes, and what aiService generates from. */
  id: string;
  /** Business key, e.g. "Req-524" — the tree row's visible label. */
  reqId: string;
  summary: string;
}

/**
 * A root-level (`parentId: 0`) requirement. Root level matters: the
 * workbench requirements tree's top-level query is
 * `select=reqId,parentId,id&parentId=0` (Hooks/queries/useTreeChildren.ts's
 * module-2 case; the older Hooks/queries/useRequirementsTree.ts used the
 * same query for the now-deleted Pages/requirements.tsx and has had no
 * consumer since WP-075's workbench cutover), sorted `-createdAt` by
 * advancedResults, so a just-created root requirement is guaranteed to be
 * on the first page of the tree without expanding anything.
 */
export async function createRequirementFixture(
  api: AxiosInstance,
  label: string
): Promise<RequirementFixture> {
  const summary = `WP-063b ${label} fixture requirement ${Date.now()}`;
  const delta = JSON.stringify({
    ops: [{ insert: 'The system shall let a signed-in contributor record a test result.\n' }],
  });

  const resp = await api.post('/requirement', {
    requirementSummary: summary,
    requirementDescription: delta,
    parentId: 0,
    status: 'approved',
    dynamicFields: {
      RequirementStatus: 'New',
      requirementType: 'New',
      AcceptanceCriteria: delta,
    },
  });

  const doc = resp.data?.data;
  if (!doc?._id || !doc?.reqId) {
    throw new Error(`Unexpected POST /requirement response: ${JSON.stringify(resp.data).slice(0, 500)}`);
  }
  return { id: doc._id, reqId: doc.reqId, summary };
}

/**
 * Removes the requirement AND everything accepting an AI candidate hung off
 * it: the draft test case(s) created by api/aiApi.ts#acceptCandidate and the
 * two link documents per candidate (forward from the test case, reverse from
 * the requirement). Deleting only the requirement would leave exactly the
 * orphaned test cases + dangling links this suite is required not to leave.
 *
 * Returns the TestCaseIds it found linked to the requirement, so a spec can
 * assert on them (proving the accept really reached testRepoService) before
 * they are removed.
 */
export async function findAcceptedTestCaseIds(
  api: AxiosInstance,
  fixture: RequirementFixture
): Promise<string[]> {
  const links = await api.get('/linkIssue', { params: { sourceId: fixture.reqId, linkType: 'tests' } });
  const rows: any[] = links.data?.data || [];
  return rows.filter((l) => l.destinationModule === 1).map((l) => l.destinationId);
}

export async function cleanupRequirementFixture(
  api: AxiosInstance,
  fixture: RequirementFixture | undefined
): Promise<void> {
  if (!fixture) return;

  // Both directions of every link touching this requirement.
  const linkIds = new Set<string>();
  const testCaseIds = new Set<string>();
  for (const params of [{ sourceId: fixture.reqId }, { destinationId: fixture.reqId }]) {
    const resp = await api.get('/linkIssue', { params });
    for (const link of (resp.data?.data || []) as any[]) {
      linkIds.add(link._id);
      if (link.srcModule === 1) testCaseIds.add(link.sourceId);
      if (link.destinationModule === 1) testCaseIds.add(link.destinationId);
    }
  }
  for (const linkId of linkIds) {
    await api.delete(`/linkIssue/${linkId}`);
  }

  for (const testCaseId of testCaseIds) {
    const found = await api.get('/testrepo', { params: { TestCaseId: testCaseId } });
    for (const tc of (found.data?.data || []) as any[]) {
      await api.delete(`/testrepo/${tc._id}`);
    }
  }

  await api.delete(`/requirement/${fixture.id}`);
}
