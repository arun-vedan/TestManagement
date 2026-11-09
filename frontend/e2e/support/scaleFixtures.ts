// WP-F23 Task 3 — bulk, API-only fixtures for the two "at scale" density
// specs (release-lens-density.spec.ts, and the density test added to
// traceability-matrix.spec.ts). Every OTHER fixture helper in this suite
// (./fixtures.ts) exists to set up data for a journey where driving the
// REAL UI is itself part of what is being proved (creating a defect,
// linking two test cases by hand, recording a result through the real
// Run/Save flow). None of that applies here: the thing under proof is
// entirely how ReleaseDetail.tsx's Lens and TraceabilityMatrixSection.tsx
// render and export a LARGE set, never how a single item gets linked or
// created. Building the 20-30 fixtures a density test needs by clicking
// through draft forms one at a time would make the spec slow and brittle
// for no proof value the API-created rows don't already carry — the
// backend does not distinguish a document created via the browser from one
// created via a direct authenticated call, and the Lens/matrix read
// whatever is really in the database either way.
//
// Kept separate from ./fixtures.ts (not added to it) so this file's much
// looser "no dynamicFields, no draft-form parity" fixtures can never be
// mistaken for that file's own carefully-shaped, UI-parity ones -- a
// caller importing from here is opting into "bulk, minimal, scale-only"
// on purpose.
import { AxiosInstance } from 'axios';

export interface TestCaseDoc {
  id: string; // Mongo _id
  TestCaseId: string; // e.g. "TC-524"
}

// Fix round (WP-F23 Task 3) -- the original committed version of this
// helper posted `TestCaseSummary` alone and 400'd against a live stack:
// `TestCase.TestCaseDescription` is `required: [true, ...]`
// (backend/testRepoService/models/testrepo.js), confirmed live (a direct
// probe against Kong returned `{"error":"Please add a Display name"}`, that
// schema's own message text for the missing `TestCaseDescription` field --
// misleading wording, real requirement). Every density spec in this suite
// creates dozens of these, so a fixed, non-empty placeholder description is
// supplied here once rather than by every call site.
export async function createTestCase(api: AxiosInstance, summary: string): Promise<TestCaseDoc> {
  const resp = await api.post('/testrepo', { TestCaseSummary: summary, TestCaseDescription: summary });
  const doc = resp.data?.data;
  if (!doc?._id || !doc?.TestCaseId) {
    throw new Error(`Unexpected POST /testrepo response: ${JSON.stringify(resp.data).slice(0, 300)}`);
  }
  return { id: doc._id, TestCaseId: doc.TestCaseId };
}

export async function deleteTestCase(api: AxiosInstance, id: string | undefined): Promise<void> {
  if (!id) return;
  await api.delete(`/testrepo/${id}`).catch(() => {});
}

export interface ReleaseDoc {
  id: string; // Mongo _id
  releaseId: string; // e.g. "REL-42"
}

export async function createReleaseDoc(api: AxiosInstance, name: string): Promise<ReleaseDoc> {
  const resp = await api.post('/releases', { name });
  const doc = resp.data?.data;
  if (!doc?._id || !doc?.releaseId) {
    throw new Error(`Unexpected POST /releases response: ${JSON.stringify(resp.data).slice(0, 300)}`);
  }
  return { id: doc._id, releaseId: doc.releaseId };
}

export async function deleteReleaseDoc(api: AxiosInstance, id: string | undefined): Promise<void> {
  if (!id) return;
  await api.delete(`/releases/${id}`).catch(() => {});
}

export interface TestPlanDoc {
  id: string; // Mongo _id
  TestPlanId: string; // e.g. "PLN-9"
}

/**
 * `testCaseIds`, when given, seeds the plan's own `TestCases` membership
 * array directly at creation (createTestPlan's controller writes
 * `req.body` straight through to `TestPlan.create`, so this is not a
 * separate mechanism from the real "Test cases (optional)" draft-time
 * picker TestPlanDetail.tsx's own header comment describes -- just this
 * suite's API-only route to the same field, for a fixture set too large to
 * click through one checkbox at a time). `id`/`parentId` mirror
 * TestPlanDetail's own membership-row shape (flat, no step hierarchy
 * needed for a fixture no execution here ever opens by row nesting).
 */
export async function createTestPlan(api: AxiosInstance, testCaseIds?: string[]): Promise<TestPlanDoc> {
  const body = testCaseIds
    ? { TestCases: testCaseIds.map((TestCaseId, i) => ({ id: i + 1, parentId: 0, TestCaseId })) }
    : {};
  const resp = await api.post('/testplan', body);
  const doc = resp.data?.data;
  if (!doc?._id || !doc?.TestPlanId) {
    throw new Error(`Unexpected POST /testplan response: ${JSON.stringify(resp.data).slice(0, 300)}`);
  }
  return { id: doc._id, TestPlanId: doc.TestPlanId };
}

export async function deleteTestPlan(api: AxiosInstance, id: string | undefined): Promise<void> {
  if (!id) return;
  await api.delete(`/testplan/${id}`).catch(() => {});
}

export async function attachPlanToRelease(api: AxiosInstance, releaseMongoId: string, testPlanId: string): Promise<void> {
  await api.post(`/releases/${releaseMongoId}/plans`, { testPlanId });
}

interface CreateLinkParams {
  sourceId: string;
  destinationId: string;
  srcModule: number;
  destinationModule: number;
  linkType?: string;
}

/**
 * A SINGLE linkIssue document, sourceId -> destinationId. Deliberately
 * one-directional, unlike the real product's own linkissue.tsx (which
 * writes forward AND reverse so BOTH entities' own Links tabs can see the
 * relationship) -- releaseLens.js's own hop-0 read queries linkIssue by
 * BOTH `sourceId: releaseId` and `destinationId: releaseId` (see that
 * file's own `collectCounterparts`), so a release-authored, one-directional
 * row is fully sufficient for the Lens to resolve it. These density
 * fixtures never open the test case's OWN Links tab, so the missing
 * reverse row costs nothing here and halves both the setup and the
 * teardown call count for a fixture set already in the dozens.
 */
export async function createLink(api: AxiosInstance, params: CreateLinkParams): Promise<string> {
  const resp = await api.post('/linkIssue', {
    sourceId: params.sourceId,
    destinationId: params.destinationId,
    srcModule: params.srcModule,
    destinationModule: params.destinationModule,
    linkType: params.linkType ?? 'relates-to',
  });
  const doc = resp.data?.data;
  if (!doc?._id) {
    throw new Error(`Unexpected POST /linkIssue response: ${JSON.stringify(resp.data).slice(0, 300)}`);
  }
  return doc._id;
}

export async function deleteLink(api: AxiosInstance, id: string | undefined): Promise<void> {
  if (!id) return;
  await api.delete(`/linkIssue/${id}`).catch(() => {});
}

interface ExecutionCase {
  TestCaseId: string;
  TestStatus: string;
}

/**
 * A minimal TestExecution row FROM a given plan, carrying whatever
 * TestCaseId/TestStatus pairs the caller wants. No `dynamicFields`, no
 * `assignedTo`, no embedded `TestSteps` -- none of this suite's other
 * execution fixture (./fixtures.ts's `createTestExecutionFixture`) needs
 * for THAT file's purpose (rendering TestExecutionContent.tsx's own
 * Play/Save UI) applies here: this row is never opened in the browser, it
 * only needs to be readable by reportingService's `resolveExecutionSets`
 * (coverage.js), which reads exactly `TestPlanId` and
 * `TestCases[].TestCaseId`/`TestCases[].TestStatus` and nothing else.
 *
 * Fix round (WP-F23 Task 3) -- `testPlanMongoId` MUST be the plan's Mongo
 * `_id`, never its human `TestPlanId` ('PLN-n'): confirmed live against a
 * real stack (`Cast to ObjectId failed for value "PLN-n"`) and confirmed
 * against the real product's own call site (TestPlanDetail.tsx's
 * `createTestExecution({ TestCases, TestPlanId: values._id })`) --
 * `TestExecution.TestPlanId` is declared `mongoose.Schema.Types.ObjectId`
 * (models/TestExecution.js), a cross-service "reference by id only, no
 * FK/populate" pointer, not the human-readable business key every OTHER
 * field this suite calls `...Id` actually is. Renamed from this function's
 * original `testPlanId` (which a first caller read as "the human id,
 * naturally" and 400'd) to make that distinction impossible to miss a
 * second time.
 */
export async function createExecutionForPlan(
  api: AxiosInstance,
  testPlanMongoId: string,
  cases: ExecutionCase[]
): Promise<string> {
  const resp = await api.post('/testexecution', {
    TestPlanId: testPlanMongoId,
    TestCases: cases.map((c, i) => ({ id: i + 1, parentId: 0, TestCaseId: c.TestCaseId, TestStatus: c.TestStatus })),
  });
  const doc = resp.data?.data;
  if (!doc?._id) {
    throw new Error(`Unexpected POST /testexecution response: ${JSON.stringify(resp.data).slice(0, 300)}`);
  }
  return doc._id;
}

export async function deleteExecution(api: AxiosInstance, id: string | undefined): Promise<void> {
  if (!id) return;
  await api.delete(`/testexecution/${id}`).catch(() => {});
}

export interface RequirementDoc {
  id: string; // Mongo _id
  reqId: string; // e.g. "Req-131"
}

// `requirementDescription` is required (models/requirement.js) -- confirmed
// live (a bare `{ requirementSummary }` 400s, same "Please add a Display
// name" schema message this file's own `createTestCase` fix round already
// hit and documents in full for `TestCaseDescription`).
export async function createRequirement(api: AxiosInstance, summary: string): Promise<RequirementDoc> {
  const resp = await api.post('/requirement', { requirementSummary: summary, requirementDescription: summary });
  const doc = resp.data?.data;
  if (!doc?._id || !doc?.reqId) {
    throw new Error(`Unexpected POST /requirement response: ${JSON.stringify(resp.data).slice(0, 300)}`);
  }
  return { id: doc._id, reqId: doc.reqId };
}

export async function deleteRequirement(api: AxiosInstance, id: string | undefined): Promise<void> {
  if (!id) return;
  await api.delete(`/requirement/${id}`).catch(() => {});
}

export interface DefectDoc {
  id: string; // Mongo _id
  defectId: string; // e.g. "Bug-42"
}

/**
 * A minimal defect, `Status`/`Severity` free strings exactly like
 * DefectDetail's own draft form writes (defectService/models/defects.js
 * validates neither against an enum) -- default `Status: 'Open'` resolves
 * to `isUnresolvedDefectStatus(...) === true` (Components/common/
 * defectStatusRules.ts), the shape this suite's own density specs need to
 * put a defect in a requirement's "open" bucket without depending on
 * istatusService's live vocabulary beyond the one name every one of this
 * repo's OWN e2e defect journeys (entity-creation.spec.ts's own comment:
 * "New/Open/Fixed/Rejected/Deffered/Retest/Re-open/Closed") already
 * assumes resolves.
 */
export async function createDefect(
  api: AxiosInstance,
  summary: string,
  opts?: { Status?: string; Severity?: string }
): Promise<DefectDoc> {
  const resp = await api.post('/defects', {
    summary,
    Status: opts?.Status ?? 'Open',
    Severity: opts?.Severity ?? 'High',
  });
  const doc = resp.data?.data;
  if (!doc?._id || !doc?.defectId) {
    throw new Error(`Unexpected POST /defects response: ${JSON.stringify(resp.data).slice(0, 300)}`);
  }
  return { id: doc._id, defectId: doc.defectId };
}

export async function deleteDefect(api: AxiosInstance, id: string | undefined): Promise<void> {
  if (!id) return;
  await api.delete(`/defects/${id}`).catch(() => {});
}
