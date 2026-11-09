import React, { useEffect } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WorkbenchStoreProvider, useWorkbench } from '../../WorkbenchStoreProvider';
import { DefectDraftIntent } from '../../store/workbenchStore';
import { TestRunDetail } from '../modules/TestRunDetail';
import { usePermissions } from '../../../Hooks/usePermissions';
import {
  getTestExecutionList,
  getTeTestCaseDetails,
  getFields,
  updateTestSteps,
  getCreatedBy,
  getComments,
  getLinkedIssuesApi,
  createLink,
  getWCDefectList,
} from '../../../api/apiCalls';

// WP-076 Part A -- TestRunDetail, module 4, ported from
// Components/Tabs/TestExecutionContent.tsx. Two real getFields() call sites
// feed this view, and they are NOT the same one: AddDeleteTableRows itself
// calls getFields(4) when module===4 (verified live: srckube-fields.fields
// has exactly one moduleId:4 document, "Step Status", a DropDown whose
// defaultValue IS the step-status vocabulary) purely to populate the
// Status <Select> in the steps table -- reused here unchanged, so this file
// mocks getFields to serve that call. There is no separate moduleId:4
// "entity fields" document (that single doc is the step-status control's
// config, not a FieldGrid-shaped attribute list), so unlike TestCaseDetail/
// RequirementDetail there is no FieldGrid/getFields(4) "Details" tab for
// the run's own record. The nested, read-only "Test Case Details" panel
// (legacy tcFields, TabContent.tsx `getFields(1)` when selectedModule===4)
// is intentionally NOT exercised by these tests -- it is orthogonal to the
// rollup behaviour these tests exist to lock down.
// A6 -- getLinkedIssuesApi/createLink/getWCDefectList are the same real API
// functions Components/LinkIssue/linkissue.tsx uses for every other
// module's Links section (see LinksSection.tsx); TestRunDetail's own
// defect-linking panel (below) reuses them directly rather than a new
// backend mechanism.
jest.mock('../../../api/apiCalls', () => ({
  getTestExecutionList: jest.fn(),
  getTeTestCaseDetails: jest.fn(),
  getFields: jest.fn(),
  updateTestSteps: jest.fn(),
  updateAttachment: jest.fn(),
  uploadAttachment: jest.fn(),
  getCreatedBy: jest.fn(),
  getComments: jest.fn(),
  getLinkedIssuesApi: jest.fn(),
  createLink: jest.fn(),
  getWCDefectList: jest.fn(),
}));

jest.mock('../../../keycloak', () => ({
  __esModule: true,
  default: {
    tokenParsed: { sub: 'user-abc', preferred_username: 'alice', name: 'Alice' },
    authenticated: true,
  },
}));

// WP-077 RBAC -- these views now gate every write control on can('write'),
// restoring the gate the legacy Edit button had (TabContent.tsx:631) and
// that per-field inline edit dropped. A6's "Raise defect"/"Link existing
// defect" actions must respect the same gate (jest.fn(), not a fixed
// arrow-function return, so the "hidden without can('write')" describe
// block below can flip it per-test the same way RequirementDetail.test.tsx
// does).
jest.mock('../../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: jest.fn(),
  default: jest.fn(),
}));

const mockUsePermissions = usePermissions as unknown as jest.Mock;

const mockGetTestExecutionList = getTestExecutionList as jest.Mock;
const mockGetTeTestCaseDetails = getTeTestCaseDetails as jest.Mock;
const mockGetFields = getFields as jest.Mock;
const mockUpdateTestSteps = updateTestSteps as jest.Mock;
const mockGetCreatedBy = getCreatedBy as jest.Mock;
const mockGetComments = getComments as jest.Mock;
const mockGetLinkedIssuesApi = getLinkedIssuesApi as jest.Mock;
const mockCreateLink = createLink as jest.Mock;
const mockGetWCDefectList = getWCDefectList as jest.Mock;

const STEP_STATUSES = ['No Run', 'InProgress', 'Pass', 'Fail', 'Blocked'];

// Shape verified live via the mongodb MCP tool against
// srckube-testexecution.testexecutions: TestCases[].TestStatus is the
// rolled-up status TestExecutionContent.tsx's checkStepStatus/handleSave
// computes and writes back.
const RUN_RECORD = {
  _id: 'exec-mongo-1',
  TestExecutionId: 'Run-1',
  assignedTo: 'user-1',
  TestCases: [{ TestCaseId: 'TC-1', TestCaseSummary: 'Login works', TestStatus: 'No Run' }],
};

const TC_DETAILS_ONE_STEP = [
  {
    TestCases: [
      {
        TestCaseId: 'TC-1',
        TestCaseSummary: 'Login works',
        dynamicFields: {},
        TestSteps: [{ testStep: 'Enter valid credentials', Expected: 'User is logged in', status: 'No Run' }],
        attachment: [],
      },
    ],
  },
];

function renderDetail(entityId = 'Run-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latestTabs: ReturnType<typeof useWorkbench<Array<{ key: string; module: number; entityId: string; dirty: boolean }>>> = [];
  let latestIntents: Record<string, DefectDraftIntent> = {};

  function Harness() {
    const openTab = useWorkbench((s) => s.openTab);
    latestTabs = useWorkbench((s) => s.tabs);
    latestIntents = useWorkbench((s) => s.defectDraftIntents);
    useEffect(() => {
      openTab({ module: 4, entityId, title: entityId });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <TestRunDetail entityId={entityId} />;
  }

  render(
    // A6's "Raise defect" calls useNavigate() (see TestRunDetail.tsx's own
    // comment on that call for why: opening a module-5 tab from the Test
    // Runs route needs a real URL change too, or EntityDetail.tsx's
    // module-gated dispatch never renders it) -- this component needs a
    // Router in its tree now, same as every other workbench component that
    // navigates (Workbench.test.tsx/EntityDetail.test.tsx's own
    // MemoryRouter wrapping).
    <MemoryRouter initialEntries={['/projects/1/workbench/testruns']}>
      <QueryClientProvider client={client}>
        <WorkbenchStoreProvider projectId={1}>
          <Harness />
        </WorkbenchStoreProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { getTabs: () => latestTabs, getIntents: () => latestIntents, client };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUsePermissions.mockReturnValue({ can: () => true, role: 'contributor', isLoading: false, isError: false });
  mockGetTestExecutionList.mockResolvedValue([RUN_RECORD]);
  // A deep clone, not the shared literal itself: AddDeleteTableRows'
  // handleChange (Components/Tabs/AddDeleteTableRows.tsx) does
  // `updatedRows[index][field] = value` -- a shallow array copy that
  // mutates the row OBJECTS in place. Handing out the same TC_DETAILS_
  // ONE_STEP reference to every test let an earlier test's "set this step
  // to Pass" leak its mutated status into every test that ran after it in
  // this file, including ones (like the A6 "Raise defect" pre-fill test
  // below) that assert on the original 'No Run' status.
  mockGetTeTestCaseDetails.mockResolvedValue(JSON.parse(JSON.stringify(TC_DETAILS_ONE_STEP)));
  // AddDeleteTableRows reads reqFields[0]['defaultValue'] for the Status
  // dropdown when module === 4 -- see this file's header comment.
  mockGetFields.mockResolvedValue([{ fieldName: 'Step Status', defaultValue: STEP_STATUSES }]);
  mockUpdateTestSteps.mockResolvedValue({ success: true });
  mockGetCreatedBy.mockResolvedValue('Alice');
  mockGetComments.mockResolvedValue([]);
  mockGetLinkedIssuesApi.mockResolvedValue([]);
  mockCreateLink.mockResolvedValue({ _id: 'link-new' });
  mockGetWCDefectList.mockResolvedValue([]);
});

describe('TestRunDetail', () => {
  it('renders the run id and its test cases from getTestExecutionList', async () => {
    renderDetail();
    expect(await screen.findByText(/Run-1/)).toBeInTheDocument();
    expect(await screen.findByText('TC-1')).toBeInTheDocument();
    await screen.findByText(/No comments yet/);
  });

  // WP-F07b Task 4 -- regression guard, the most important test in this
  // task per the dispatch: every run that exists today has no
  // iterationIndex/iterationValues on its TestCases entries (Task 1's own
  // backfill target). Such a run must render EXACTLY as it did before this
  // feature landed -- one row, labeled by the bare TestCaseId, no
  // iteration suffix of any kind.
  it('regression guard: an unparameterised run (no iterationIndex/iterationValues) renders exactly one row, labeled by the bare TestCaseId', async () => {
    renderDetail();
    await screen.findByText(/Run-1/);
    await screen.findByText(/No comments yet/);

    // getByText (singular) throws if more than one node matches -- this
    // fails loudly if a stray iteration suffix or duplicate row appears.
    expect(screen.getByText('TC-1')).toBeInTheDocument();
    expect(screen.queryByText(/TC-1\s*·/)).not.toBeInTheDocument();
    expect(screen.queryByText(/TC-1\s*\(/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /TC-1/ })).toHaveLength(1);
  });

  it('shows the rolled-up per-status counts as real text, not color alone', async () => {
    renderDetail();
    await screen.findByText(/Run-1/);
    await screen.findByText(/No comments yet/);
    expect(within(screen.getByTestId('status-count-No Run')).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('status-count-Pass')).getByText('0')).toBeInTheDocument();
    expect(within(screen.getByTestId('status-count-Fail')).getByText('0')).toBeInTheDocument();
    expect(within(screen.getByTestId('status-count-Blocked')).getByText('0')).toBeInTheDocument();
  });

  it('setting a step to Pass persists via updateTestSteps and the rolled-up test-case status reflects it', async () => {
    // After the save, the server has recorded the test case as Pass --
    // proves the new rollup reaches the screen via a react-query refetch of
    // the SAME real API function the E2E spec depends on, not a client-side
    // recomputation kept in local state.
    mockGetTestExecutionList
      .mockResolvedValueOnce([RUN_RECORD])
      .mockResolvedValueOnce([{ ...RUN_RECORD, TestCases: [{ ...RUN_RECORD.TestCases[0], TestStatus: 'Pass' }] }]);

    renderDetail();
    await screen.findByText(/Run-1/);
    await screen.findByText(/No comments yet/);

    fireEvent.click(screen.getByText('TC-1'));
    await screen.findByText('Enter valid credentials');

    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));

    const statusSelect = screen.getByRole('combobox', { name: 'Status for step 1' });
    fireEvent.mouseDown(statusSelect);
    fireEvent.click(await screen.findByRole('option', { name: 'Pass' }));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      // WP-F07b Task 4 -- updateTestSteps now takes a trailing
      // iterationIndex (additive, R1: absent means 0) so a save lands on
      // the SAME row the tester is looking at rather than always landing
      // on iteration 0 (the backend's own six-site addressing fix from
      // Task 1 is inert unless every caller is updated to send it -- this
      // is that update for the one caller in this file). TC-1 here is
      // unparameterised, so its one and only row is iteration 0.
      expect(mockUpdateTestSteps).toHaveBeenCalledWith(
        'TC-1',
        'Run-1',
        expect.objectContaining({
          TestSteps: [expect.objectContaining({ status: 'Pass' })],
          TestStatus: 'Pass',
        }),
        0,
      );
    });

    // The rolled-up count for this test case's new status, read back via
    // the real getTestExecutionList API function (react-query refetch).
    await waitFor(() => {
      const passCount = screen.getByTestId('status-count-Pass');
      expect(within(passCount).getByText('1')).toBeInTheDocument();
    });
  });
});

// WP-F07b Task 4 -- "the run view addresses iterations". Tasks 1-2 (backend,
// already landed) made a run store one TestCases[] row per data row, each
// carrying its own iterationIndex + iterationValues; Task 3 made reporting
// count them. Until this task, TestRunDetail still addressed a case within
// a run by TestCaseId ALONE in three places (list key, `selected` check,
// defect raising), so three iterations of one case were invisible: they
// collapsed to whatever the first/last matching row happened to be. These
// tests cover the fix -- key/selection/fetch/save/defect-raising all now
// resolve TestCaseId + iterationIndex, and iteration 0 (falsy!) is exercised
// directly, not through a proxy.
//
// Shape verified against Task 1/2's own backend tests
// (iterationAddressing.test.js / iterationEnrichment.test.js) and the
// model comment in TestExecution.js: iterationValues is a Mongoose `Map`
// server-side, but round-trips over HTTP as a plain JSON object
// (`{ role: 'admin' }`), never a Map instance -- these fixtures use plain
// objects to match what the real API actually returns.
const RUN_RECORD_ITERATIONS = {
  _id: 'exec-mongo-2',
  TestExecutionId: 'Run-2',
  assignedTo: 'user-1',
  TestCases: [
    { TestCaseId: 'TC-9', TestCaseSummary: 'Role-based access', TestStatus: 'Pass', iterationIndex: 0, iterationValues: { role: 'admin' } },
    { TestCaseId: 'TC-9', TestCaseSummary: 'Role-based access', TestStatus: 'Fail', iterationIndex: 1, iterationValues: { role: 'editor' } },
    { TestCaseId: 'TC-9', TestCaseSummary: 'Role-based access', TestStatus: 'Blocked', iterationIndex: 2, iterationValues: { role: 'viewer' } },
  ],
};

const ITERATION_ROLE_BY_INDEX: Record<number, string> = { 0: 'admin', 1: 'editor', 2: 'viewer' };

describe('TestRunDetail — per-iteration results (WP-F07b Task 4)', () => {
  beforeEach(() => {
    mockGetTestExecutionList.mockResolvedValue([RUN_RECORD_ITERATIONS]);
    // Keyed by the iterationIndex TestRunDetail is expected to pass through
    // getTeTestCaseDetails -- if the component forgets to send it (or sends
    // the wrong one, e.g. always 0), the wrong step text comes back and
    // the assertions below on step text catch it directly.
    mockGetTeTestCaseDetails.mockImplementation(async (tcId: string, _exeId: string, iterationIndex = 0) => {
      const role = ITERATION_ROLE_BY_INDEX[iterationIndex];
      return [
        {
          TestCases: [
            {
              TestCaseId: tcId,
              TestCaseSummary: 'Role-based access',
              dynamicFields: {},
              TestSteps: [{ testStep: `Enter ${role} credentials`, Expected: 'User is logged in', status: 'No Run' }],
              attachment: [],
              iterationIndex,
              iterationValues: { role },
            },
          ],
        },
      ];
    });
  });

  // The single most important assertion in this file per the dispatch: the
  // failure mode is a React key collision (three siblings sharing
  // `key={tc.TestCaseId}`), which does not throw -- it warns and lets React
  // reuse DOM nodes/fibers across updates, misrouting selection. Checked
  // two ways: (1) all three rows genuinely render, labeled by their OWN
  // data (not a bare index -- "TC-9 · role=admin" is what a tester needs,
  // not "TC-9 (1)"), and (2) no "same key" console warning fired -- the
  // one assertion that is sensitive to the `key` prop alone, since the
  // labels/count survive a duplicate key on a fresh mount regardless (
  // verified empirically against a minimal repro before writing this test).
  it('renders three distinct rows for three iterations of the same TestCaseId, each labeled by its own data, with no React key-collision warning', async () => {
    const consoleErrors: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
    try {
      renderDetail('Run-2');
      await screen.findByText(/Run-2/);
      await screen.findByText(/No comments yet/);

      expect(screen.getByText('TC-9 · role=admin')).toBeInTheDocument();
      expect(screen.getByText('TC-9 · role=editor')).toBeInTheDocument();
      expect(screen.getByText('TC-9 · role=viewer')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /TC-9/ })).toHaveLength(3);

      expect(consoleErrors.some((m) => m.includes('same key'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  // Fix round 1 (code review) -- the test above is coupled to React's
  // warning TEXT: a future React reword would silently turn it into a
  // no-op while it keeps passing. It also never exercises the collision's
  // actual failure mechanism -- reconciliation, not mounting. This test
  // is the structural complement: it forces a real update against a
  // PREVIOUS render of this exact list (a react-query refetch of
  // getTestExecutionList, exactly like this file's own "setting a step to
  // Pass" test above triggers via commitSteps.onSettled's invalidate) and
  // asserts DOM NODE IDENTITY for the "viewer" row survives the reorder --
  // the one thing `key` exists to guarantee and the one thing a warning
  // string cannot prove either way.
  //
  // Verified empirically (a throwaway repro outside this suite, mirroring
  // this component's exact List/ListItem/ListItemButton shape) before
  // writing this: a click-driven re-render that only changes the
  // `selected` prop does NOT expose the bug -- when the underlying array's
  // order and membership are unchanged across a render, React's
  // reconciler matches children positionally and never consults the
  // key-based fallback path at all, so a duplicate key is harmless there.
  // The bug only surfaces once the array's ORDER changes between renders
  // (a real possibility for any react-query refetch, since nothing here
  // promises the backend returns TestCases in a stable order) -- that is
  // the scenario this test constructs.
  it('DOM identity for the "viewer" row survives a refetch that reorders the same three iterations (structural, not warning-text-based)', async () => {
    // Same 3 rows, reordered -- exactly what a react-query refetch could
    // legitimately return (nothing here promises the backend returns
    // TestCases in a stable order across requests).
    const reordered = {
      ...RUN_RECORD_ITERATIONS,
      TestCases: [RUN_RECORD_ITERATIONS.TestCases[2], RUN_RECORD_ITERATIONS.TestCases[0], RUN_RECORD_ITERATIONS.TestCases[1]],
    };
    mockGetTestExecutionList.mockResolvedValueOnce([RUN_RECORD_ITERATIONS]).mockResolvedValueOnce([reordered]);

    const { client } = renderDetail('Run-2');
    await screen.findByText(/Run-2/);
    await screen.findByText(/No comments yet/);

    const viewerRowBefore = screen.getByRole('button', { name: /TC-9 · role=viewer/ });

    // Forces the SAME refetch mechanism a real save already exercises in
    // this file (qk.entity's invalidate in commitSteps.onSettled) without
    // needing to drive an entire play/edit/save flow just to get there --
    // the second mocked resolution above is what actually reorders the
    // three rows once this refetch resolves.
    await client.invalidateQueries();

    // Poll until the DOM actually reflects the reordered fetch -- the
    // query cache updating and this component re-rendering with the new
    // prop order are two separate events, and a waitFor with no throwing
    // assertion inside it would resolve on its first poll regardless of
    // whether the reorder has actually landed yet.
    await waitFor(() => {
      const order = screen.getAllByRole('button', { name: /TC-9/ }).map((el) => el.textContent);
      expect(order[0]).toContain('viewer');
    });

    await waitFor(() => {
      const viewerRowAfter = screen.getByRole('button', { name: /TC-9 · role=viewer/ });
      // The load-bearing assertion: the SAME physical DOM node the user
      // was looking at for "viewer" is still the one showing "viewer"
      // after its position in the array moved from index 2 to index 0.
      // A shared key ("TC-9" for all three) breaks this -- React's
      // key-based reconciliation can no longer tell the three rows apart
      // across the reorder, so a DIFFERENT node ends up rendering
      // "viewer" instead of the one already tracking it (confirmed: under
      // `key={tc.TestCaseId}` this assertion times out, never becoming
      // true, rather than merely warning).
      expect(viewerRowAfter).toBe(viewerRowBefore);
    });
  });

  it("selecting iteration 2 (role=viewer) fetches and shows iteration 2's own steps, not iteration 0's", async () => {
    renderDetail('Run-2');
    await screen.findByText(/Run-2/);
    await screen.findByText(/No comments yet/);

    fireEvent.click(screen.getByText('TC-9 · role=viewer'));

    await screen.findByText('Enter viewer credentials');
    expect(screen.queryByText('Enter admin credentials')).not.toBeInTheDocument();
    expect(screen.queryByText('Enter editor credentials')).not.toBeInTheDocument();
    expect(mockGetTeTestCaseDetails).toHaveBeenCalledWith('TC-9', 'Run-2', 2);
  });

  // TRAP this exact change is known to have bitten this programme before:
  // `iterationIndex: 0` is FALSY. Any `tc.iterationIndex || x` or
  // `if (iterationIndex)` gate silently treats iteration 0 as "no
  // iteration". Asserted directly here (not through an inert proxy): 0
  // must be reachable, addressed correctly, and distinguishable from 1.
  it('iteration 0 is addressable on its own and distinct from iteration 1 (iterationIndex: 0 must not be swallowed as falsy)', async () => {
    renderDetail('Run-2');
    await screen.findByText(/Run-2/);
    await screen.findByText(/No comments yet/);

    fireEvent.click(screen.getByText('TC-9 · role=admin'));
    await screen.findByText('Enter admin credentials');
    expect(mockGetTeTestCaseDetails).toHaveBeenCalledWith('TC-9', 'Run-2', 0);

    mockGetTeTestCaseDetails.mockClear();
    fireEvent.click(screen.getByText('TC-9 · role=editor'));
    await screen.findByText('Enter editor credentials');
    expect(screen.queryByText('Enter admin credentials')).not.toBeInTheDocument();
    expect(mockGetTeTestCaseDetails).toHaveBeenCalledWith('TC-9', 'Run-2', 1);
    expect(mockGetTeTestCaseDetails).not.toHaveBeenCalledWith('TC-9', 'Run-2', 0);
  });

  // R5 -- "TC-9 failed" is not actionable when only the `viewer` row
  // failed; the defect must name which data reproduces it.
  it("raising a defect from iteration 1 (role=editor) carries that iteration's index and data values into the summary/description (R5)", async () => {
    const { getTabs, getIntents } = renderDetail('Run-2');
    await screen.findByText(/Run-2/);
    await screen.findByText(/No comments yet/);

    fireEvent.click(screen.getByText('TC-9 · role=editor'));
    await screen.findByText('Enter editor credentials');

    fireEvent.click(screen.getByRole('button', { name: /raise defect/i }));

    const tabs = getTabs();
    const draftTab = tabs.find((t) => t.module === 5);
    expect(draftTab).toBeTruthy();
    const intent = getIntents()[draftTab!.entityId];
    expect(intent).toBeTruthy();

    expect(intent.prefill.summary).toEqual(expect.stringContaining('role=editor'));
    expect(intent.prefill.description).toEqual(expect.stringContaining('role=editor'));
    // Not just "some iteration's data" -- THIS row's data, and not the
    // other rows' data leaking in from a stale selection/cache mixup.
    expect(intent.prefill.summary).not.toEqual(expect.stringContaining('role=admin'));
    expect(intent.prefill.summary).not.toEqual(expect.stringContaining('role=viewer'));
  });
});

// A6 -- "You cannot raise or link a defect from a failing test run" (the
// highest-value gap in PRODUCT_GAP_REGISTER.md). A tester marking TC-1's
// step Failed had no path to a defect at all: no defect action, no links
// section. These tests cover the three pieces added for the currently
// selected test case: raising a pre-filled draft (and recording the link
// that must be created once it's saved -- completed end to end in
// DefectDetail.test.tsx's "draft pre-filled and linked from a raise-defect
// intent" describe block, since DefectDetail owns the actual create+link),
// linking an already-existing defect, and listing defects already linked.
describe('TestRunDetail — raise or link a defect (A6)', () => {
  async function selectTc1() {
    const view = renderDetail();
    await screen.findByText(/Run-1/);
    await screen.findByText(/No comments yet/);
    fireEvent.click(screen.getByText('TC-1'));
    await screen.findByText('Enter valid credentials');
    return view;
  }

  it('"Raise defect" opens a module-5 draft tab pre-filled with the test case and run context, and records the link to create', async () => {
    const { getTabs, getIntents } = await selectTc1();

    fireEvent.click(screen.getByRole('button', { name: /raise defect/i }));

    const tabs = getTabs();
    const draftTab = tabs.find((t) => t.module === 5);
    expect(draftTab).toBeTruthy();

    const intent = getIntents()[draftTab!.entityId];
    expect(intent).toBeTruthy();
    // Real ids only (Run-1, TC-1) -- never invented placeholder text.
    expect(intent.prefill.summary).toEqual(expect.stringContaining('TC-1'));
    expect(intent.prefill.summary).toEqual(expect.stringContaining('Run-1'));
    expect(intent.prefill.description).toEqual(expect.stringContaining('Enter valid credentials'));
    expect(intent.prefill.description).toEqual(expect.stringContaining('No Run'));
    expect(intent.link).toEqual({
      sourceModule: 1,
      sourceId: 'TC-1',
      sourceSummary: 'Login works',
      linkType: 'relates-to',
    });
  });

  it('"Link existing defect" links an existing defect to the test case, bidirectionally', async () => {
    mockGetWCDefectList.mockResolvedValue([{ defectId: 'DEF-9', summary: 'Login crash' }]);
    await selectTc1();

    fireEvent.click(screen.getByRole('button', { name: /link existing defect/i }));

    const searchInput = await screen.findByLabelText('Search issue');
    fireEvent.change(searchInput, { target: { value: 'DEF' } });
    const option = await screen.findByText('DEF-9 : Login crash');
    fireEvent.click(option);

    fireEvent.mouseDown(screen.getByLabelText('Link type'));
    fireEvent.click(await screen.findByRole('option', { name: 'relates-to' }));

    fireEvent.click(screen.getByRole('button', { name: /confirm link/i }));

    await waitFor(() => {
      expect(mockCreateLink).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 'TC-1',
          destinationId: 'DEF-9',
          srcModule: 1,
          destinationModule: 5,
          linkType: 'relates-to',
        }),
      );
    });
    expect(mockCreateLink).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'DEF-9',
        destinationId: 'TC-1',
        srcModule: 5,
        destinationModule: 1,
        linkType: 'relates-to',
      }),
    );
    expect(mockCreateLink).toHaveBeenCalledTimes(2);
  });

  it('lists the defects already linked to the selected test case, so a failure already tracked is visible', async () => {
    mockGetLinkedIssuesApi.mockResolvedValue([
      { _id: 'link-1', sourceId: 'TC-1', destinationId: 'DEF-3', destinationModule: 5, summary: 'Login crashes', linkType: 'relates-to' },
      // A non-defect link on the same test case must not show up in this
      // defect-scoped section.
      { _id: 'link-2', sourceId: 'TC-1', destinationId: 'REQ-1', destinationModule: 2, summary: 'Auth requirement', linkType: 'tests' },
    ]);
    await selectTc1();

    expect(await screen.findByText(/DEF-3/)).toBeInTheDocument();
    expect(screen.getByText(/Login crashes/)).toBeInTheDocument();
    expect(screen.queryByText(/REQ-1/)).not.toBeInTheDocument();
  });

  it('shows no linked defects yet when there are none', async () => {
    mockGetLinkedIssuesApi.mockResolvedValue([]);
    await selectTc1();

    expect(await screen.findByText(/no defects linked yet/i)).toBeInTheDocument();
  });

  it('hides both "Raise defect" and "Link existing defect" for a user without write permission', async () => {
    mockUsePermissions.mockReturnValue({ can: () => false, role: 'viewer', isLoading: false, isError: false });
    await selectTc1();

    expect(screen.queryByRole('button', { name: /raise defect/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /link existing defect/i })).not.toBeInTheDocument();
    // The list itself must still be visible read-only.
    expect(await screen.findByText('Linked Defects')).toBeInTheDocument();
  });
});
