/* eslint-disable testing-library/no-node-access -- `qk.children(...)` is
   Hooks/queryKeys.ts's key-builder function, not DOM node traversal;
   eslint-plugin-testing-library's no-node-access rule pattern-matches on
   the property name alone and false-positives here (same reasoning as
   TestCaseDetail.test.tsx/SourcePanel.test.tsx). */
import React, { useEffect } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider, useWorkbench } from '../../WorkbenchStoreProvider';
import { tabKey, makeDraftEntityId } from '../../store/workbenchStore';
import { qk } from '../../../Hooks/queryKeys';
import { TestPlanDetail } from '../modules/TestPlanDetail';
import { getTestPlanList, getTestExecutionList, getTcList, updatedTestPlan, createTestExecution, getComments, saveApiTestPlan, getUserDirectory, updateTestExecution } from '../../../api/apiCalls';
import { createCaseTemplate } from '../../../api/caseTemplateApi';

// WP-076 Part A -- TestPlanDetail, module 3. UNLIKE TestCaseDetail/
// RequirementDetail, module 3 has NO generic dynamic-fields record at all:
// TabContent.tsx's fetch effect explicitly reads `if (selectedModule !== 3)
// { getFields(selectedModule) }` -- module 3 is the one module that call
// skips -- and a live query of srckube-fields.fields for moduleId:3 returns
// zero documents. So there is no FieldGrid/getFields(3) Details tab here;
// a plan's own "fields" are TestPlanContent.tsx's hardcoded TestCases
// membership grid + TestExecutionContent list + PlanDetails.tsx's own fixed
// enrichment schema (objective/scope/risk/entryCriteria/exitCriteria/
// schedule/environment, via api/testPlanApi.ts) -- not the generic Fields
// collection. getTestPlanList (no `select=`) already returns every one of
// those enrichment fields on the same row as TestCases/parentId, so one
// entity query covers both the membership grid and the Details tab.
jest.mock('../../../api/apiCalls', () => ({
  getTestPlanList: jest.fn(),
  getTestExecutionList: jest.fn(),
  getTcList: jest.fn(),
  updatedTestPlan: jest.fn(),
  createTestExecution: jest.fn(),
  getComments: jest.fn(),
  saveApiTestPlan: jest.fn(),
  getUserDirectory: jest.fn(),
  updateTestExecution: jest.fn(),
}));

// WP-F08 Task 2 -- only needed for the "Save as template" wiring test
// below; mocked here rather than left to hit the real module (which would
// fire an unmocked axios call the instant Save is clicked).
jest.mock('../../../api/caseTemplateApi', () => ({
  createCaseTemplate: jest.fn(),
}));

// WP-077 RBAC -- these views now gate every write control on can('write'),
// restoring the gate the legacy Edit button had (TabContent.tsx:631) and
// that per-field inline edit dropped. These suites exercise the WRITE
// paths, so they run as a contributor.
jest.mock('../../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: () => ({ can: () => true, role: 'contributor', isLoading: false, isError: false }),
  default: () => ({ can: () => true, role: 'contributor', isLoading: false, isError: false }),
}));

// WP-F05b fix round 1 -- TestPlanDetail.tsx imports `keycloak` directly
// (for CommentsSection's userName/userId props), independently of
// usePermissions above. Unlike this file's three sibling test files
// (TestCaseDetail/RequirementDetail/DefectDetail.test.tsx), this suite had
// no mock for it, so the real src/keycloak.js loaded the real 'keycloak-js'
// package (an ESM build this CRA/Jest config cannot parse) and the whole
// suite failed at import time with zero tests ever executed -- discovered
// while adding this round's create-with-tags regression test, which would
// otherwise have been committed but silently never run. Mocked identically
// to the other three files' own block.
jest.mock('../../../keycloak', () => ({
  __esModule: true,
  default: {
    tokenParsed: { sub: 'user-abc', preferred_username: 'alice', name: 'Alice' },
    authenticated: true,
  },
}));


const mockGetTestPlanList = getTestPlanList as jest.Mock;
const mockGetTestExecutionList = getTestExecutionList as jest.Mock;
const mockGetTcList = getTcList as jest.Mock;
const mockUpdatedTestPlan = updatedTestPlan as jest.Mock;
const mockCreateTestExecution = createTestExecution as jest.Mock;
const mockGetComments = getComments as jest.Mock;
const mockSaveApiTestPlan = saveApiTestPlan as jest.Mock;
const mockCreateCaseTemplate = createCaseTemplate as jest.Mock;
const mockGetUsersList = getUserDirectory as jest.Mock;
const mockUpdateTestExecution = updateTestExecution as jest.Mock;

// Shape of /api/v1/users/directory (the current project's members). An
// execution's assignedTo stores the Keycloak id; the UI shows the username.
const USERS = [
  { id: 'user-abc', username: 'alice' },
  { id: 'user-1', username: 'bob' },
  { id: 'svc-1', username: 'service-account-node-microservice' },
];

// Shape from a live srckube-testplan.testplans document (verified via the
// mongodb MCP tool): _id, parentId, TestCases[], TestPlanId, plus whatever
// PlanDetails enrichment fields (WP-014) have been saved onto the same row.
const PLAN_RECORD = {
  _id: 'plan-mongo-1',
  TestPlanId: 'PLN-1',
  parentId: 0,
  TestCases: [{ TestCaseId: 'TC-1', TestCaseSummary: 'Login works', TestStatus: 'No Run', id: 1 }],
  objective: 'Verify login',
};

const AVAILABLE_TEST_CASES = [
  { TestCaseId: 'TC-1', TestCaseSummary: 'Login works' },
  { TestCaseId: 'TC-2', TestCaseSummary: 'Logout works' },
];

const EXECUTIONS = [{ _id: 'exec-1', TestExecutionId: 'Run-1', assignedTo: 'user-1' }];

function renderDetail(
  entityId = 'PLN-1',
  opts: {
    seed?: (client: QueryClient, setSelection: (id: string | null) => void) => void;
    prefill?: Record<string, unknown>;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latestTabs: ReturnType<typeof useWorkbench<Array<{ key: string; module: number; entityId: string; title: string; dirty: boolean }>>> = [];

  function Harness() {
    const openTab = useWorkbench((s) => s.openTab);
    const setSelection = useWorkbench((s) => s.setSelection);
    const setDraftPrefill = useWorkbench((s) => s.setDraftPrefill);
    latestTabs = useWorkbench((s) => s.tabs);
    useEffect(() => {
      if (opts.prefill) {
        setDraftPrefill(entityId, opts.prefill);
      }
      openTab({ module: 3, entityId, title: entityId });
      opts.seed?.(client, (id) => setSelection(3, id));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <TestPlanDetail entityId={entityId} />;
  }

  render(
    <QueryClientProvider client={client}>
      <WorkbenchStoreProvider projectId={1}>
        <Harness />
      </WorkbenchStoreProvider>
    </QueryClientProvider>,
  );
  return { getTabs: () => latestTabs, client };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTestPlanList.mockResolvedValue([PLAN_RECORD]);
  mockGetTestExecutionList.mockResolvedValue(EXECUTIONS);
  mockGetTcList.mockResolvedValue(AVAILABLE_TEST_CASES);
  mockUpdatedTestPlan.mockResolvedValue({ success: true });
  mockCreateTestExecution.mockResolvedValue({ data: { TestExecutionId: 'Run-9' } });
  mockGetComments.mockResolvedValue([]);
  mockSaveApiTestPlan.mockResolvedValue({ data: { TestPlanId: 'PLN-999' } });
  mockCreateCaseTemplate.mockResolvedValue({ _id: 'ct1', CaseTemplateId: 'CT-1' });
  mockGetUsersList.mockResolvedValue(USERS);
  mockUpdateTestExecution.mockResolvedValue({ success: true });
});

describe('TestPlanDetail', () => {
  it('renders the plan id and its membership from getTestPlanList', async () => {
    renderDetail();
    expect(await screen.findByText(/PLN-1/)).toBeInTheDocument();
    expect(await screen.findByText('Login works')).toBeInTheDocument();
    await screen.findByText(/No comments yet/);
  });

  // WP-F08 Task 2 -- module 3 has no per-field form (this module's own
  // header comment), so the one thing "Save as template" captures here is
  // the plan's CURRENT test-case membership (entityPrefill.ts's own
  // module-3 branch), not a blank form.
  it('offers "Save as template" and captures this plan\'s own test-case membership as TestCaseIds', async () => {
    renderDetail();
    await screen.findByText(/PLN-1/);

    fireEvent.click(screen.getByRole('button', { name: /save as template/i }));
    const dialog = await screen.findByRole('dialog', { name: /save as template/i });
    fireEvent.change(within(dialog).getByLabelText('Template name'), { target: { value: 'Login smoke plan' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockCreateCaseTemplate).toHaveBeenCalledTimes(1));
    const payload = mockCreateCaseTemplate.mock.calls[0][0];
    expect(payload.moduleId).toBe(3);
    // The single-line break this catches: mapping the wrong field (or an
    // empty array) in entityPrefill.ts's module-3 branch makes this fail.
    expect(payload.prefill).toEqual({ TestCaseIds: ['TC-1'] });
  });

  it('saves a single plan-details field without a global edit mode, and marks its tab dirty', async () => {
    const { getTabs } = renderDetail();
    await screen.findByText(/PLN-1/);
    await screen.findByText(/No comments yet/);

    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));

    // No global Edit/Save/Cancel toggle -- per-field inline edit only.
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save plan details$/i })).not.toBeInTheDocument();

    const key = tabKey(3, 'PLN-1');
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(false);

    const objectiveInput = screen.getByLabelText('Objective');
    fireEvent.change(objectiveInput, { target: { value: 'Verify login and logout' } });
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(true);
    fireEvent.blur(objectiveInput);

    await waitFor(() => {
      expect(mockUpdatedTestPlan).toHaveBeenCalledWith('plan-mongo-1', { objective: 'Verify login and logout' });
    });
  });

  it('adding a test case calls updatedTestPlan and invalidates rather than mutating local state', async () => {
    renderDetail();
    await screen.findByText(/PLN-1/);
    await screen.findByText(/No comments yet/);

    // Reflects the server's post-add state once updatedTestPlan settles and
    // the entity query refetches -- proving the new row appears via
    // react-query invalidation, not a local array push.
    mockGetTestPlanList.mockResolvedValueOnce([PLAN_RECORD]).mockResolvedValueOnce([
      {
        ...PLAN_RECORD,
        TestCases: [...PLAN_RECORD.TestCases, { TestCaseId: 'TC-2', TestCaseSummary: 'Logout works', TestStatus: 'No Run', id: 2 }],
      },
    ]);

    fireEvent.click(screen.getByRole('button', { name: /add test cases/i }));
    const availableGrid = await screen.findByTestId('available-test-cases-grid');
    const tc2Row = await within(availableGrid).findByRole('row', { name: /TC-2/ });
    fireEvent.click(within(tc2Row).getByRole('checkbox'));

    fireEvent.click(screen.getByRole('button', { name: /^add selected$/i }));

    await waitFor(() => {
      expect(mockUpdatedTestPlan).toHaveBeenCalledWith('plan-mongo-1', {
        TestCases: [
          ...PLAN_RECORD.TestCases,
          expect.objectContaining({ TestCaseId: 'TC-2', TestCaseSummary: 'Logout works', TestStatus: 'No Run' }),
        ],
        parentId: 0,
      });
    });
    expect(await screen.findByText('Logout works')).toBeInTheDocument();
  });

  it('removing a test case calls updatedTestPlan with the remaining membership', async () => {
    renderDetail();
    await screen.findByText(/PLN-1/);
    await screen.findByText(/No comments yet/);

    const membershipGrid = screen.getByTestId('plan-test-cases-grid');
    const tc1Row = within(membershipGrid).getByRole('row', { name: /TC-1/ });
    fireEvent.click(within(tc1Row).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /remove selected/i }));

    await waitFor(() => {
      expect(mockUpdatedTestPlan).toHaveBeenCalledWith('plan-mongo-1', { TestCases: [], parentId: 0 });
    });
  });

  it('lists the plan test executions and opens a workbench tab for module 4', async () => {
    renderDetail();
    await screen.findByText(/PLN-1/);
    await screen.findByText(/No comments yet/);

    fireEvent.click(screen.getByRole('tab', { name: 'Test Executions' }));
    expect(await screen.findByText('Run-1')).toBeInTheDocument();
  });

  // WP-079 Part B, item 4 of the dispatch: module 4 (Test Runs) is
  // explicitly OUT of this WP's creation-flow scope because an execution
  // is already created FROM a plan via this exact action -- verifying it
  // actually works (rather than assuming so from reading the source) is
  // what lets this WP legitimately not add a second creation path for
  // runs. No unit test covered this action before this WP.
  it('"Create Execution" asks for an assignee (defaulting to the current user), creates the execution assigned to them, and opens a module-4 tab', async () => {
    const { getTabs } = renderDetail();
    await screen.findByText(/PLN-1/);
    await screen.findByText(/No comments yet/);

    const membershipGrid = screen.getByTestId('plan-test-cases-grid');
    const tc1Row = within(membershipGrid).getByRole('row', { name: /TC-1/ });
    fireEvent.click(within(tc1Row).getByRole('checkbox'));

    fireEvent.click(screen.getByRole('button', { name: /create execution/i }));

    const dialog = await screen.findByRole('dialog', { name: /create test execution/i });
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: /assign to/i })).toHaveValue('alice'));
    fireEvent.click(within(dialog).getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockCreateTestExecution).toHaveBeenCalledWith({
        TestCases: [PLAN_RECORD.TestCases[0]],
        TestPlanId: 'plan-mongo-1',
        assignedTo: 'user-abc',
      });
    });

    await waitFor(() => {
      expect(getTabs().find((t) => t.entityId === 'Run-9' && t.module === 4)).toBeTruthy();
    });
  });

  it('"Create Execution" sends whichever user is picked in the dialog', async () => {
    renderDetail();
    await screen.findByText(/PLN-1/);
    await screen.findByText(/No comments yet/);

    const membershipGrid = screen.getByTestId('plan-test-cases-grid');
    fireEvent.click(within(within(membershipGrid).getByRole('row', { name: /TC-1/ })).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /create execution/i }));

    const dialog = await screen.findByRole('dialog', { name: /create test execution/i });
    const input = within(dialog).getByRole('combobox', { name: /assign to/i });
    await waitFor(() => expect(input).toHaveValue('alice'));
    fireEvent.mouseDown(input);
    fireEvent.click(await screen.findByRole('option', { name: 'bob' }));
    // Service accounts are not people -- never offered as an assignee.
    expect(screen.queryByRole('option', { name: /service-account/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockCreateTestExecution).toHaveBeenCalledWith(expect.objectContaining({ assignedTo: 'user-1' }));
    });
  });

  it('shows each execution\'s assignee by username and reassigns it in place', async () => {
    const { client } = renderDetail();
    await screen.findByText(/PLN-1/);
    await screen.findByText(/No comments yet/);
    const invalidate = jest.spyOn(client, 'invalidateQueries');

    fireEvent.click(screen.getByRole('tab', { name: 'Test Executions' }));
    const input = await screen.findByRole('combobox', { name: /assigned to Run-1/i });
    await waitFor(() => expect(input).toHaveValue('bob'));

    fireEvent.mouseDown(input);
    fireEvent.click(await screen.findByRole('option', { name: 'alice' }));

    await waitFor(() => {
      expect(mockUpdateTestExecution).toHaveBeenCalledWith({ assignedTo: 'user-abc' }, 'exec-1');
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project', 1, 3, 'executions', 'PLN-1'] });
    });
  });
});

describe('TestPlanDetail — draft mode (create a new test plan)', () => {
  it('never fetches an entity for a draft id', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });
    expect(mockGetTestPlanList).not.toHaveBeenCalled();
  });

  it('renders the New Test Plan header and an empty test-case picker', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    expect(await screen.findByText('New Test Plan')).toBeInTheDocument();
    const grid = await screen.findByTestId('draft-available-test-cases-grid');
    expect(await within(grid).findByText('Login works')).toBeInTheDocument();
    expect(within(grid).getByText('Logout works')).toBeInTheDocument();
  });

  it('Create with no test cases selected posts an empty TestCases array plus the resolved parentId, and replaces the draft tab with the returned TestPlanId', async () => {
    const draftId = makeDraftEntityId();
    const { getTabs, client } = renderDetail(draftId);
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    await screen.findByTestId('draft-available-test-cases-grid');

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockSaveApiTestPlan).toHaveBeenCalledWith({ TestCases: [], parentId: 0, tags: [] });
    });

    const newKey = tabKey(3, 'PLN-999');
    await waitFor(() => {
      expect(getTabs().find((t) => t.key === newKey)).toBeTruthy();
    });
    const newTab = getTabs().find((t) => t.key === newKey);
    expect(newTab?.title).toBe('PLN-999');
    expect(getTabs().find((t) => t.key === tabKey(3, draftId))).toBeUndefined();

    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: qk.children(1, 3, '0') }));
  });

  it('Create with test cases selected posts them shaped like real plan membership', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    const grid = await screen.findByTestId('draft-available-test-cases-grid');
    const tc2Row = await within(grid).findByRole('row', { name: /TC-2/ });
    fireEvent.click(within(tc2Row).getByRole('checkbox'));

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockSaveApiTestPlan).toHaveBeenCalledWith({
        TestCases: [expect.objectContaining({ TestCaseId: 'TC-2', TestCaseSummary: 'Logout works', TestStatus: 'No Run' })],
        parentId: 0,
        tags: [],
      });
    });
  });

  it('derives parentId from the currently selected folder, per the legacy rule', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId, {
      seed: (client, setSelection) => {
        client.setQueryData(qk.children(1, 3, '0'), [{ id: '7', parent: '0', droppable: true, text: 'Folder 7' }]);
        setSelection('7');
      },
    });
    await screen.findByTestId('draft-available-test-cases-grid');

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockSaveApiTestPlan).toHaveBeenCalledWith(expect.objectContaining({ parentId: 7 }));
    });
  });

  it('shows an error and leaves the draft tab open when Create fails', async () => {
    mockSaveApiTestPlan.mockRejectedValueOnce(new Error('boom'));
    const draftId = makeDraftEntityId();
    const { getTabs } = renderDetail(draftId);
    await screen.findByTestId('draft-available-test-cases-grid');

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not create/i);
    expect(getTabs().find((t) => t.key === tabKey(3, draftId))).toBeTruthy();
  });

  // Wave B-4 (clone an entity) -- module 3 has no per-field draft form at
  // all (see this file's own header comment), so the one thing a clone
  // prefill carries is which test cases the source plan already had
  // (useCloneEntity.ts's `TestCaseIds`) -- pre-checked here in the SAME
  // "available test cases" grid the draft already renders, not a separate
  // UI. Create then posts them through the identical normal create path
  // the "Create with test cases selected..." test above already covers.
  it('seeded from a clone prefill: pre-checks the source plan\'s test cases, and Create saves them as a normal new record', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId, { prefill: { TestCaseIds: ['TC-2'] } });
    const grid = await screen.findByTestId('draft-available-test-cases-grid');
    const tc2Row = await within(grid).findByRole('row', { name: /TC-2/ });
    await waitFor(() => expect(within(tc2Row).getByRole('checkbox')).toBeChecked());

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockSaveApiTestPlan).toHaveBeenCalledWith({
        TestCases: [expect.objectContaining({ TestCaseId: 'TC-2', TestCaseSummary: 'Logout works' })],
        parentId: 0,
        tags: [],
      });
    });
  });

  // WP-F05b fix round 1 -- regression test for the silent-drop bug: `tags`
  // is a fixed schema field (WP-F05a/Task 1), not one of the admin Fields
  // Configuration entries any `fields.forEach` loop would pick up, and
  // module 3 has no such loop at all (no per-field draft form -- see this
  // file's own header comment) -- so before this fix there was no route
  // for a tag typed into TagsSection to reach saveApiTestPlan's payload at
  // all. TagsSection's chips appeared, Create fired, and the saved plan
  // came back with no tags and no error.
  it('Create saves tags entered before the plan exists (not silently dropped)', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    const tagInput = screen.getByRole('textbox', { name: /add a tag/i });
    fireEvent.change(tagInput, { target: { value: 'smoke' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockSaveApiTestPlan).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['smoke'] }),
      );
    });
  });
});
