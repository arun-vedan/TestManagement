import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, createTheme } from '@mui/material';
import theme from '../../../Theme/theme';
import { WorkbenchStoreProvider, useWorkbench } from '../../WorkbenchStoreProvider';
import { tabKey } from '../../store/workbenchStore';
import { ReleaseDetail, TEST_CASE_STATUS_COLORS, mergeConfiguredReleaseFields } from '../modules/ReleaseDetail';
import { STATUS_KEYS } from '../modules/TestRunDetail';
import LinksSection from '../LinksSection';
import { getRelease, updateRelease, deleteRelease, linkTestPlan, unlinkTestPlan, getGateStatus } from '../../../api/releaseApi';
import { getTestPlanList, getFields, getComments, getLinkedIssuesApi, createLink, deleteLinkcAPI, getWCDefectList } from '../../../api/apiCalls';
import { getReleaseLens } from '../../../api/reportApi';

// WP-166 follow-up -- AI entry points render only while AI is available
// (Components/AI/AiAvailable.tsx, its own suite covers the probe). Stubbed
// here as a switch so each test states which world it is in.
let mockAiState: 'available' | 'hidden' = 'available';
jest.mock('../../../Components/AI/AiAvailable', () => ({
  AiAvailable: ({ children }: { children: React.ReactNode }) => (mockAiState === 'available' ? children : null),
  useAiAvailability: () => ({ state: mockAiState, message: null }),
}));
beforeEach(() => {
  mockAiState = 'available';
});


// WP-F15/F18 Task 2 -- ReleaseDetail, module 6. UNLIKE the five modules
// already migrated, Releases has its own dedicated api/releaseApi.ts (not
// api/apiCalls.tsx) -- WP-025's own header comment there records why: this
// is a genuinely separate service (releaseService), reached through its
// own endpoints. getRelease/updateRelease/linkTestPlan/unlinkTestPlan/
// getGateStatus are mocked here the same way DefectDetail/TestPlanDetail
// mock apiCalls: real module, jest.mock'd factory (not
// jest.requireActual), the pattern SharedStepManagerDialog.test.tsx
// documents as the one that avoids the keycloak-js ESM-import failure a few
// suites in this repo still hit.
jest.mock('../../../api/releaseApi', () => ({
  __esModule: true,
  RELEASE_STATUSES: ['planned', 'in-progress', 'frozen', 'released', 'cancelled'],
  getRelease: jest.fn(),
  updateRelease: jest.fn(),
  deleteRelease: jest.fn(),
  linkTestPlan: jest.fn(),
  unlinkTestPlan: jest.fn(),
  getGateStatus: jest.fn(),
}));

// WP-F15/F18 Task 3 -- LinksSection (mounted below, Links tab) is a thin
// wrapper around Components/LinkIssue/linkissue.tsx, which reaches
// getLinkedIssuesApi/createLink/deleteLinkcAPI (its own read/create/delete
// calls) and getWCDefectList (via Components/Lists/issueSearch.tsx's
// DynamicAutocomplete, for the "Defects" issue-type search) through this
// SAME api/apiCalls module -- same mock-the-module pattern as
// linkissue.a11y.test.tsx.
jest.mock('../../../api/apiCalls', () => ({
  getTestPlanList: jest.fn(),
  // WP-F24 Task 1 -- the Details tab's configured field definitions,
  // getFields(6). Same mock-the-module pattern as every other call in this
  // factory: a bare jest.fn(), given a resolved value per-test (default:
  // empty, the 621-project case -- see this file's own beforeEach below).
  getFields: jest.fn(),
  // CommentsSection (always mounted -- see this file's own JSX below) goes
  // through Components/comments/displayComments.tsx, which calls this
  // directly -- same reason every other module's own test file mocks it
  // alongside its own module-specific api calls.
  getComments: jest.fn(),
  getLinkedIssuesApi: jest.fn(),
  createLink: jest.fn(),
  deleteLinkcAPI: jest.fn(),
  getWCDefectList: jest.fn(),
  getWCReqList: jest.fn(),
  getWCTCList: jest.fn(),
}));

// linkissue.tsx also reads LINK_TYPES (a real constant) and the coverage
// hook (useCoverage.ts) reads getUntestedRequirements/getOrphanTestCases
// from this same module -- requireActual + override just the two coverage
// calls, same pattern linkissue.a11y.test.tsx already established, so the
// real LINK_TYPES list renders in the Link-type <Select>.
jest.mock('../../../api/linkApi', () => {
  const actual = jest.requireActual('../../../api/linkApi');
  return {
    ...actual,
    getUntestedRequirements: jest.fn().mockResolvedValue([]),
    getOrphanTestCases: jest.fn().mockResolvedValue([]),
  };
});

// WP-F15/F18 Task 5 -- the lens tab. `reportErrorMessage` is a pure string
// helper (no network of its own) so the real one is kept via
// requireActual, same "mock only what touches the network" split this
// file's linkApi mock above uses.
jest.mock('../../../api/reportApi', () => ({
  ...jest.requireActual('../../../api/reportApi'),
  getReleaseLens: jest.fn(),
}));

// WP-F18b Task 4 -- the Details tab now also mounts AiSummaryPanel
// (scope="release", ported off Pages/releases.tsx's own Manage Release
// dialog -- see ReleaseDetail.tsx's own header comment). Auto-mocked, no
// factory, same bare `jest.mock('../../../api/aiApi')` pattern
// AiSummaryPanel.test.tsx itself uses -- the panel's own generation call is
// user-initiated (a button, never fired on mount), so nothing here needs a
// resolved value for this file's other tests to render cleanly.
jest.mock('../../../api/aiApi');

jest.mock('../../../keycloak', () => ({
  __esModule: true,
  default: {
    tokenParsed: { sub: 'user-abc', preferred_username: 'alice', name: 'Alice' },
    authenticated: true,
  },
}));

// Toggled per-test (viewer vs. contributor vs. delete-capable) -- same
// "mockCanWrite" pattern rbac.test.tsx already established, needed because
// jest hoists jest.mock() factories above this file's other declarations.
// WP-F18b Task 3 -- split into two independent flags (previously `can`
// ignored its own argument and returned `mockCanWrite` for EVERYTHING,
// write and delete alike). permissions.ts's real matrix gives a
// contributor write but NOT delete; collapsing them back into one flag
// here would make it impossible to write the one test that catches the
// most likely regression on the new Delete control -- gating it on
// can('write') instead of can('delete').
let mockCanWrite = true;
let mockCanDelete = true;
jest.mock('../../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: () => ({
    can: (action: string) => (action === 'delete' ? mockCanDelete : mockCanWrite),
    role: mockCanWrite ? (mockCanDelete ? 'admin' : 'contributor') : 'viewer',
    isLoading: false,
    isError: false,
  }),
  default: () => ({
    can: (action: string) => (action === 'delete' ? mockCanDelete : mockCanWrite),
    role: mockCanWrite ? (mockCanDelete ? 'admin' : 'contributor') : 'viewer',
    isLoading: false,
    isError: false,
  }),
}));

const mockGetRelease = getRelease as jest.Mock;
const mockUpdateRelease = updateRelease as jest.Mock;
const mockDeleteRelease = deleteRelease as jest.Mock;
const mockLinkTestPlan = linkTestPlan as jest.Mock;
const mockUnlinkTestPlan = unlinkTestPlan as jest.Mock;
const mockGetGateStatus = getGateStatus as jest.Mock;
const mockGetTestPlanList = getTestPlanList as jest.Mock;
const mockGetFields = getFields as jest.Mock;
const mockGetComments = getComments as jest.Mock;
const mockGetLinkedIssuesApi = getLinkedIssuesApi as jest.Mock;
const mockCreateLink = createLink as jest.Mock;
const mockDeleteLinkcAPI = deleteLinkcAPI as jest.Mock;
const mockGetWCDefectList = getWCDefectList as jest.Mock;
const mockGetReleaseLens = getReleaseLens as jest.Mock;

// Shape from releaseApi.ts's own Release interface -- entityId is the
// Mongo `_id` (ReleaseDetail.tsx's own header comment explains why:
// releaseService's routes key every lookup off it, not the human
// `releaseId`).
const RELEASE_RECORD = {
  _id: 'release-mongo-1',
  id: 1,
  releaseId: 'REL-1',
  name: 'Spring Launch',
  projectId: 1,
  targetDate: '2026-12-01T00:00:00.000Z',
  status: 'planned',
  linkedTestPlanIds: ['plan-mongo-1'],
  notes: 'Ship it',
  qualityGates: [{ type: 'minPassRate', threshold: 80 }],
};

const TEST_PLANS = [
  { _id: 'plan-mongo-1', TestPlanId: 'PLN-1' },
  { _id: 'plan-mongo-2', TestPlanId: 'PLN-2' },
];

const GATE_STATUS = {
  releaseId: 'REL-1',
  status: 'planned',
  overall: 'red',
  passed: false,
  rules: [{ type: 'minPassRate', threshold: 80, actual: 50, passed: false }],
};

// WP-F15/F18 Task 5 -- shape mirrors computeReleaseLens's real return value
// exactly (backend/reportingService/services/releaseLens.js), not a
// simplified stand-in -- every field this component reads is present.
const LENS_ENVELOPE = {
  success: true,
  projectId: 1,
  releaseId: 'REL-1',
  computedAt: '2026-01-05T00:00:00.000Z',
  data: {
    release: { releaseId: 'REL-1', name: 'Spring Launch', status: 'planned', targetDate: '2026-12-01T00:00:00.000Z' },
    links: { rawLinkRowsSeen: 4, distinctCounterparts: 3, resolvedCount: 3, unresolvedCount: 0, ignoredOtherModuleCount: 0 },
    requirements: {
      linkedCount: 1,
      linked: [{ reqId: 'REQ-1', requirementSummary: 'Login must work' }],
      derivedCount: 0,
      derived: [],
    },
    testCases: { linkedCount: 0, linked: [], derivedCount: 0, derived: [] },
    defects: {
      linkedCount: 2,
      byStatus: { categories: ['Open'], series: [{ id: 'count', label: 'Defects', data: [2] }] },
      linked: [
        { defectId: 'Bug-1', summary: 'Crash on save', Status: 'Open', Severity: 'High' },
        { defectId: 'Bug-2', summary: 'Timeout on submit', Status: 'Open', Severity: 'Low' },
      ],
    },
    testPlans: { configuredCount: 1, linkedCount: 1, unresolvedCount: 0, linked: [{ _id: 'plan-mongo-1', TestPlanId: 'PLN-1' }] },
    executions: { executed: 12, passed: 10, failed: 1, blocked: 1, passRatePercent: 83.33, note: undefined },
  },
};

// R5's own empty case: nothing linked at all -- zero requirements, test
// cases, defects, AND zero configured test plans (not just zero RESOLVED
// ones, which would be an unresolved-links story, a different one).
const LENS_ENVELOPE_EMPTY = {
  success: true,
  projectId: 1,
  releaseId: 'REL-2',
  computedAt: '2026-01-05T00:00:00.000Z',
  data: {
    release: { releaseId: 'REL-2', name: 'Empty Release', status: 'planned', targetDate: undefined },
    links: { rawLinkRowsSeen: 0, distinctCounterparts: 0, resolvedCount: 0, unresolvedCount: 0, ignoredOtherModuleCount: 0 },
    requirements: { linkedCount: 0, linked: [], derivedCount: 0, derived: [] },
    testCases: { linkedCount: 0, linked: [], derivedCount: 0, derived: [] },
    defects: { linkedCount: 0, byStatus: { categories: [], series: [] }, linked: [] },
    testPlans: { configuredCount: 0, linkedCount: 0, unresolvedCount: 0, linked: [] },
    executions: { executed: 0, passed: 0, failed: 0, blocked: 0, passRatePercent: null, note: 'no executed test cases found in this release\'s linked test plans' },
  },
};

// WP-F15b Task 2 -- a release whose ONLY members are derived: nothing is
// explicitly linked (requirements/testCases/defects `linkedCount` all 0),
// but a plan is configured and attached, and that plan's containment
// derives one requirement and one test case. R2's own scenario: this must
// read as "1 configured test plan" territory, never as "Nothing linked
// yet" -- a coverage gap (nothing derives) and a release that has real,
// inferred members must not look identical.
const LENS_ENVELOPE_DERIVED_ONLY = {
  success: true,
  projectId: 1,
  releaseId: 'REL-3',
  computedAt: '2026-01-05T00:00:00.000Z',
  data: {
    release: { releaseId: 'REL-3', name: 'Derived-Only Release', status: 'planned', targetDate: undefined },
    links: { rawLinkRowsSeen: 0, distinctCounterparts: 0, resolvedCount: 0, unresolvedCount: 0, ignoredOtherModuleCount: 0 },
    requirements: {
      linkedCount: 0,
      linked: [],
      derivedCount: 1,
      derived: [{ reqId: 'REQ-9', requirementSummary: 'Derived requirement', via: [{ TestCaseId: 'TC-5', TestCaseSummary: 'Login case' }] }],
    },
    testCases: {
      linkedCount: 0,
      linked: [],
      derivedCount: 1,
      derived: [{ TestCaseId: 'TC-5', TestCaseSummary: 'Login case', via: [{ _id: 'plan-mongo-9', TestPlanId: 'PLN-9' }], latestStatus: 'Not run in this release' }],
    },
    defects: { linkedCount: 0, byStatus: { categories: [], series: [] }, linked: [] },
    testPlans: { configuredCount: 1, linkedCount: 1, unresolvedCount: 0, linked: [{ _id: 'plan-mongo-9', TestPlanId: 'PLN-9' }] },
    executions: { executed: 0, passed: 0, failed: 0, blocked: 0, passRatePercent: null, note: 'no executed test cases found in this release\'s linked test plans' },
  },
};

// WP-F15b Task 2 -- BOTH an explicit link and a derived member, in the SAME
// section, in the SAME render. This is the strongest distinctness proof:
// REQ-1/TC-1 (explicit) and REQ-9/TC-9 (derived) sit side by side, so a test
// asserting the "Derived" chip appears on exactly the derived rows is not
// relying on any before/after reconciliation behaviour -- it is a single
// fresh mount with both kinds of row present at once.
const LENS_ENVELOPE_MIXED = {
  success: true,
  projectId: 1,
  releaseId: 'REL-4',
  computedAt: '2026-01-05T00:00:00.000Z',
  data: {
    release: { releaseId: 'REL-4', name: 'Mixed Release', status: 'planned', targetDate: undefined },
    links: { rawLinkRowsSeen: 2, distinctCounterparts: 1, resolvedCount: 1, unresolvedCount: 0, ignoredOtherModuleCount: 0 },
    requirements: {
      linkedCount: 1,
      linked: [{ reqId: 'REQ-1', requirementSummary: 'Explicitly linked requirement' }],
      derivedCount: 1,
      derived: [{ reqId: 'REQ-9', requirementSummary: 'Derived requirement', via: [{ TestCaseId: 'TC-5', TestCaseSummary: 'Login case' }] }],
    },
    testCases: {
      linkedCount: 1,
      linked: [{ TestCaseId: 'TC-1', TestCaseSummary: 'Explicitly linked case', latestStatus: 'Pass' }],
      derivedCount: 1,
      derived: [{ TestCaseId: 'TC-9', TestCaseSummary: 'Derived case', via: [{ _id: 'plan-mongo-9', TestPlanId: 'PLN-9' }], latestStatus: 'Not run in this release' }],
    },
    defects: { linkedCount: 0, byStatus: { categories: [], series: [] }, linked: [] },
    testPlans: { configuredCount: 1, linkedCount: 1, unresolvedCount: 0, linked: [{ _id: 'plan-mongo-9', TestPlanId: 'PLN-9' }] },
    executions: { executed: 0, passed: 0, failed: 0, blocked: 0, passRatePercent: null, note: 'no executed test cases found in this release\'s linked test plans' },
  },
};

function renderDetail(entityId = 'release-mongo-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkbenchStoreProvider projectId={1}>
        <ReleaseDetail entityId={entityId} />
      </WorkbenchStoreProvider>
    </QueryClientProvider>,
  );
}

// WP-F23 Task 1 -- the Lens tab's Requirements/Test cases/Defects groups
// now render @mui/x-data-grid. MUI X DataGrid's column virtualization,
// given jsdom's zero client width, mounts only a LEADING WINDOW of columns
// (documented and fixed the same way in EntityList.test.tsx's own
// `testTheme`/header comment) -- without this override, this file's own
// "Membership"/"Derived via" columns (never first) would never mount, and
// assertions on the "Derived"/"Asserted" chip or the via caption would fail
// for a reason that has nothing to do with this task's own code. Test-only:
// production keeps virtualization, `ReleaseDetail.tsx` never sets this prop.
const gridTestTheme = createTheme(theme, {
  components: {
    MuiDataGrid: {
      defaultProps: {
        disableVirtualization: true,
      },
    },
  },
});

// @mui/x-data-grid stamps every row with `data-id={id}` (this file's own
// grids set `getRowId` to return reqId/TestCaseId directly) -- there is no
// Testing Library query for an arbitrary DOM attribute, so this is the
// sanctioned escape hatch, isolated to one helper rather than disabled at
// every call site.
function getGridRowById(container: HTMLElement, id: string): HTMLElement {
  // eslint-disable-next-line testing-library/no-node-access, testing-library/no-container
  const row = container.querySelector(`[data-id="${id}"]`);
  if (!row) {
    throw new Error(`No grid row found with data-id="${id}"`);
  }
  return row as HTMLElement;
}

function renderDetailForLens(entityId = 'release-mongo-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider theme={gridTestTheme}>
        <WorkbenchStoreProvider projectId={1}>
          <ReleaseDetail entityId={entityId} />
        </WorkbenchStoreProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

// WP-F18b Task 3 -- delete's onSuccess closes this release's own tab
// (Hooks/mutations/useDeleteEntity.ts's own "the deleted row must not keep
// being referenced" discipline, mirrored here -- see ReleaseDetail.tsx's
// deleteReleaseMutation). Proving that requires a real tab to exist first,
// so this harness pre-opens one via the store's own openTab (the same call
// SourcePanel.tsx's ReleaseIdCell/NewReleaseButton make) and exposes the
// live tabs array the same way SourcePanel.test.tsx's own renderPanel
// harness does, rather than asserting on ReleaseDetail's return value
// alone (it has none -- the tab list lives in the store, one level up).
function renderDetailWithTab(entityId = 'release-mongo-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latestTabs: Array<{ key: string; module: number; entityId: string; title: string }> = [];
  function Harness() {
    const openTab = useWorkbench((s) => s.openTab);
    latestTabs = useWorkbench((s) => s.tabs);
    React.useEffect(() => {
      openTab({ module: 6, entityId, title: entityId });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <ReleaseDetail entityId={entityId} />;
  }
  const view = render(
    <QueryClientProvider client={client}>
      <WorkbenchStoreProvider projectId={1}>
        <Harness />
      </WorkbenchStoreProvider>
    </QueryClientProvider>,
  );
  return { ...view, getTabs: () => latestTabs };
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  mockCanWrite = true;
  mockCanDelete = true;
  mockGetRelease.mockResolvedValue(RELEASE_RECORD);
  mockUpdateRelease.mockResolvedValue({ ...RELEASE_RECORD });
  mockDeleteRelease.mockResolvedValue(undefined);
  mockLinkTestPlan.mockResolvedValue({ ...RELEASE_RECORD, linkedTestPlanIds: [...RELEASE_RECORD.linkedTestPlanIds, 'plan-mongo-2'] });
  mockUnlinkTestPlan.mockResolvedValue({ ...RELEASE_RECORD, linkedTestPlanIds: [] });
  mockGetGateStatus.mockResolvedValue(GATE_STATUS);
  mockGetReleaseLens.mockResolvedValue(LENS_ENVELOPE);
  mockGetTestPlanList.mockResolvedValue(TEST_PLANS);
  // WP-F24 Task 1 -- the 621-project default: no module-6 field
  // definitions configured. Individual tests override this to add a
  // configured field, a collision, or a rejected query.
  mockGetFields.mockResolvedValue([]);
  mockGetComments.mockResolvedValue([]);
  mockGetLinkedIssuesApi.mockResolvedValue([]);
  // Echoes the payload back (plus a generated id), matching what the real
  // linkIssueService actually returns (POST /api/v1/linkIssue's controller
  // does `LinkIssue.create(reqdetails)` and responds with that same
  // document). linkissue.tsx's own linkIssuesHandle reads
  // `linkDets['destinationModule']` straight off this response to resolve
  // it to a display name -- a bare `{ _id: 'link-new' }` with no
  // `destinationModule` at all throws inside that handler (found while
  // writing this task's own tests: the throw is real but async and
  // unawaited by the click, so it surfaces as a leaked rejection during
  // whichever test happens to be running next, not the test that actually
  // triggered it).
  mockCreateLink.mockImplementation(async (payload: Record<string, unknown>) => ({ _id: 'link-new', id: 1, ...payload }));
  mockDeleteLinkcAPI.mockResolvedValue({});
  mockGetWCDefectList.mockResolvedValue([]);
  // jsdom has no window.matchMedia -- MUI X DataGrid (rendered inside
  // LinksSection's "Linked Issues" table) touches it, same stub
  // linkissue.a11y.test.tsx and EntityList.test.tsx already use.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
});

describe('ReleaseDetail', () => {
  // Non-vacuity: deleting the `<DetailHeader summary={values.name}>` prop,
  // or the FieldGrid/TargetDateField elements below it, makes this fail --
  // it does not merely check that SOMETHING rendered, it checks that
  // getRelease's own field values reached the screen.
  it("renders a release's own fields from getRelease", async () => {
    renderDetail();
    expect(await screen.findByText(/REL-1/)).toBeInTheDocument();
    expect(screen.getByText(/Spring Launch/)).toBeInTheDocument();
    expect(mockGetRelease).toHaveBeenCalledWith('release-mongo-1');

    expect(screen.getByLabelText('Name', { exact: false })).toHaveValue('Spring Launch');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('planned');
    expect(screen.getByLabelText('Notes')).toHaveValue('Ship it');
    expect(screen.getByLabelText('Target Date')).toHaveValue('2026-12-01');
    await screen.findByText(/No comments yet/);
  });

  // WP-F18b Task 4 -- AiSummaryPanel (scope="release"), ported off
  // Pages/releases.tsx's own Manage Release dialog onto the Details tab.
  // Non-vacuity: removing the `<AiSummaryPanel .../>` mount in
  // ReleaseDetail.tsx drops this data-testid entirely -- it does not merely
  // check something AI-shaped rendered, it checks the panel is mounted with
  // this release's own human id, not left off the page or wired to a
  // different scope.
  it('shows no AI summary while AI is unavailable (closed beta: off for the deployment)', async () => {
    mockAiState = 'hidden';
    renderDetail();
    await screen.findByText(/REL-1/);
    expect(screen.queryByTestId('ai-summary-panel')).not.toBeInTheDocument();
  });

  it("mounts the release-scoped AI summary panel on the Details tab", async () => {
    renderDetail();
    await screen.findByText(/REL-1/);
    expect(screen.getByTestId('ai-summary-panel')).toBeInTheDocument();
    expect(screen.getByText('AI summary')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate ai summary/i })).toBeInTheDocument();
  });

  // Non-vacuity: removing the `result` lookup in QualityGatesPanel (or
  // rendering the configured rule without its live GateRuleResult) drops
  // the "50"/"fail" assertions below while the rule row itself would still
  // render from `qualityGates` alone -- this test fails specifically on the
  // LIVE half, not the configured-rule half. Scoped to the results TABLE
  // (not the whole screen) because WP-F18b Task 2's editor, mounted above
  // it for a writer, ALSO shows "minPassRate" as its own Type select's
  // current value -- a real second occurrence, not a query bug.
  it("shows the release's quality gates with their live status from getGateStatus", async () => {
    renderDetail();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Quality Gates' }));

    const table = await screen.findByRole('table');
    expect(within(table).getByText('minPassRate')).toBeInTheDocument();
    expect(within(table).getByText('80')).toBeInTheDocument();
    // These two only render once getGateStatus's response has landed --
    // findByText (not getByText) waits for that.
    expect(await within(table).findByText('50')).toBeInTheDocument();
    expect(within(table).getByText(/fail/i)).toBeInTheDocument();
  });

  // Non-vacuity: rendering `linkedTestPlanIds` as raw ids (dropping
  // `testPlanLabel`'s lookup against getTestPlanList) would show
  // "plan-mongo-1", not "PLN-1" -- this fails if that lookup is removed.
  it('lists the linked test plans, resolved to their human TestPlanId', async () => {
    renderDetail();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Linked Test Plans' }));

    expect(await screen.findByText('PLN-1')).toBeInTheDocument();
    expect(screen.queryByText('plan-mongo-1')).not.toBeInTheDocument();
  });

  // Non-vacuity: dropping this file's `canWrite &&` guard on the Unlink
  // IconButton and the Link picker/button would make the queryByRole/
  // queryByLabelText assertions below find them, failing the test.
  //
  // Required test 4 (viewer half): a viewer has neither write nor delete
  // (permissions.ts's PERMISSION_MATRIX), so this also covers "a viewer
  // sees neither" for the WP-F18b Task 3 Delete control added below.
  it('shows no edit controls, and no Delete control, to a viewer (can("write")/can("delete") === false)', async () => {
    mockCanWrite = false;
    mockCanDelete = false;
    renderDetail();
    await screen.findByText(/REL-1/);

    expect(screen.getByLabelText('Name', { exact: false })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Linked Test Plans' }));
    expect(await screen.findByText('PLN-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unlink/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^link$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Test plan' })).not.toBeInTheDocument();
  });

  // Non-vacuity: calling unlinkPlan.mutate with the wrong id, or wiring the
  // button's onClick to linkTestPlan instead, makes this
  // `toHaveBeenCalledWith` assertion fail.
  it('unlinking a test plan calls unlinkTestPlan with the release and plan ids', async () => {
    renderDetail();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Linked Test Plans' }));
    await screen.findByText('PLN-1');

    fireEvent.click(screen.getByRole('button', { name: /unlink pln-1/i }));

    await waitFor(() => {
      expect(mockUnlinkTestPlan).toHaveBeenCalledWith('release-mongo-1', 'plan-mongo-1');
    });
  });

  // MUI's <Select> (even wrapped in a `TextField select`) isn't a real
  // <select> -- it's a div with role="combobox" backed by a popup listbox,
  // the same control CsvImportDialog.test.tsx/DefectDetail.test.tsx already
  // drive this way (mouseDown to open, click the resulting option). A plain
  // fireEvent.change on the combobox node does not fire MUI's onChange.
  it('linking a test plan calls linkTestPlan with the release id and the selected plan', async () => {
    renderDetail();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Linked Test Plans' }));
    await screen.findByText('PLN-1');

    const combo = screen.getByRole('combobox', { name: 'Test plan' });
    fireEvent.mouseDown(combo);
    fireEvent.click(await screen.findByRole('option', { name: 'PLN-2' }));
    fireEvent.click(screen.getByRole('button', { name: /^link$/i }));

    await waitFor(() => {
      expect(mockLinkTestPlan).toHaveBeenCalledWith('release-mongo-1', 'plan-mongo-2');
    });
  });

  it('saves a single field via updateRelease without a global edit mode', async () => {
    renderDetail();
    await screen.findByText(/REL-1/);

    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();

    const nameInput = screen.getByLabelText('Name', { exact: false });
    fireEvent.change(nameInput, { target: { value: 'Spring Launch 2' } });
    fireEvent.blur(nameInput);

    await waitFor(() => {
      expect(mockUpdateRelease).toHaveBeenCalledWith('release-mongo-1', { name: 'Spring Launch 2' });
    });
  });

  // WP-F18b Task 2 -- the gate editor now sits on this same tab, beside the
  // status table it always rendered. Non-vacuity: sending an empty array
  // instead of the edited `gateDraft` (e.g. `updateRelease(releaseId, {
  // qualityGates: [] })` in QualityGatesPanel's saveGates.mutationFn) makes
  // the `toHaveBeenCalledWith(..., { qualityGates: [{ type: 'minPassRate',
  // threshold: 65 }] })` assertion below fail, since an empty array is not
  // that object -- this was physically performed (see this task's report)
  // and reverted.
  it('editing a gate threshold and saving calls updateRelease with the edited qualityGates', async () => {
    mockUpdateRelease.mockResolvedValue({ ...RELEASE_RECORD, qualityGates: [{ type: 'minPassRate', threshold: 65 }] });
    renderDetail();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Quality Gates' }));
    await screen.findByRole('button', { name: /save gates/i });

    const thresholdField = screen.getByLabelText('Threshold');
    fireEvent.change(thresholdField, { target: { value: '65' } });
    fireEvent.click(screen.getByRole('button', { name: /save gates/i }));

    await waitFor(() => {
      expect(mockUpdateRelease).toHaveBeenCalledWith('release-mongo-1', {
        qualityGates: [{ type: 'minPassRate', threshold: 65 }],
      });
    });
  });

  // Non-vacuity: dropping the `queryClient.invalidateQueries({ queryKey:
  // gateStatusKey })` call in saveGates.onSuccess (QualityGatesPanel) means
  // getGateStatus is never asked again after a save, so the stale "50"/
  // "fail" from the FIRST call would stay on screen instead of the second
  // call's "90"/"pass" -- this asserts the refreshed values actually
  // reached the DOM, not merely that the mock was called again. Scoped to
  // the results table, same reason as the test above ("pass" is also a
  // substring of "minPassRate", the editor's own Type select value).
  it("saving a gate refreshes the gate status shown beside it", async () => {
    mockGetGateStatus
      .mockResolvedValueOnce(GATE_STATUS)
      .mockResolvedValueOnce({
        ...GATE_STATUS,
        overall: 'green',
        passed: true,
        rules: [{ type: 'minPassRate', threshold: 80, actual: 90, passed: true }],
      });
    mockUpdateRelease.mockResolvedValue({ ...RELEASE_RECORD });
    renderDetail();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Quality Gates' }));

    const table = await screen.findByRole('table');
    expect(await within(table).findByText('50')).toBeInTheDocument();
    expect(within(table).getByText('fail')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save gates/i }));

    await waitFor(() => expect(mockGetGateStatus).toHaveBeenCalledTimes(2));
    expect(await within(table).findByText('90')).toBeInTheDocument();
    expect(within(table).getByText('pass')).toBeInTheDocument();
    expect(within(table).queryByText('50')).not.toBeInTheDocument();
  });

  // Non-vacuity: dropping this file's `canWrite &&` guard around the "Edit
  // rules" block in QualityGatesPanel would make `queryByRole('button',
  // {name: /save gates/i})` find it, failing this assertion. The viewer
  // still sees the STATUS half (asserted below) -- only the editor is
  // withheld, matching the backend's own write/delete role gates
  // (releaseService's routes, per this task's own brief).
  it('shows gate status but no gate editor to a viewer', async () => {
    mockCanWrite = false;
    renderDetail();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Quality Gates' }));

    expect(await screen.findByText('minPassRate')).toBeInTheDocument();
    expect(await screen.findByText('50')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save gates/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add rule/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Threshold')).not.toBeInTheDocument();
  });

  // The case most likely to be got wrong (this task's own brief): a release
  // with NO saved gates must say so plainly, never render an empty results
  // grid that could be misread as "0 gates, none failing" -- an
  // unconfigured release is not a passing one. Non-vacuity: deleting the
  // `noGatesConfigured` branch (or its condition) in QualityGatesPanel would
  // make this render the (empty) results TableContainer instead, so
  // `queryByRole('table')` below would find it and this assertion would
  // fail.
  it('a release with no gates configured says so plainly, with no empty results grid', async () => {
    mockGetRelease.mockResolvedValue({ ...RELEASE_RECORD, qualityGates: [] });
    renderDetail();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Quality Gates' }));

    expect(await screen.findByText('No quality gates configured for this release.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/overall/i)).not.toBeInTheDocument();
  });

  // WP-F15/F18 Task 5 -- R5: the lens tab states every count's denominator.
  // Non-vacuity: rendering `defects.linkedCount`/`testPlans.linkedCount`/
  // `executions.executed` as bare numbers with no surrounding text (or
  // dropping the "Counted from N linked items" caption) still leaves the
  // digits themselves on the page, so this asserts the SENTENCES the
  // numbers are embedded in, not just their presence.
  it('the Lens tab shows linked counts together with what they were counted out of (R5)', async () => {
    renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));

    expect(mockGetReleaseLens).not.toHaveBeenCalledWith(undefined);
    await waitFor(() => expect(mockGetReleaseLens).toHaveBeenCalledWith('REL-1'));

    expect(await screen.findByText(/2 linked defects/)).toBeInTheDocument();
    expect(screen.getByText(/1 linked requirement/)).toBeInTheDocument();
    expect(screen.getByText(/1 linked test plan/)).toBeInTheDocument();
    // The denominator: how many linked items the count was drawn from, not
    // just the count alone. Lives in the headline/caption ABOVE the groups,
    // so it stays visible whether or not any group below is expanded.
    expect(screen.getByText(/Counted from 3 linked items/)).toBeInTheDocument();

    // WP-F23 Task 1, R1 -- every group below is now collapsed by default,
    // so the individual rows this test used to find unconditionally are
    // behind a toggle. Expanding each and finding its row proves the same
    // underlying data is still reachable, just not dumped on screen at once.
    fireEvent.click(await screen.findByRole('button', { name: /toggle requirements/i }));
    expect(await screen.findByText(/REQ-1/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /toggle defects/i }));
    expect(await screen.findByText(/Bug-1/)).toBeInTheDocument();
    expect(screen.getByText(/Bug-2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /toggle test plans/i }));
    expect(await screen.findByText(/PLN-1/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /toggle executions/i }));
    // "12 executed" appears twice once Executions is expanded too -- the
    // summary sentence above the groups, and the Executions group's own
    // detail line.
    expect(await screen.findAllByText(/12 executed/)).toHaveLength(2);

    expect(screen.queryByText(/nothing linked yet/i)).not.toBeInTheDocument();
  });

  // Fix round (Finding 1, MAJOR) -- linkPlan/unlinkPlan's `onSuccess` used
  // to write ONLY `qk.entity`'s cache key. The Lens panel's own query key
  // (['project', pid, 6, 'release-lens', <human releaseId>], set in
  // ReleaseLensPanel below) is different at every position after the
  // module id, so nothing reached it: attaching or detaching a plan left
  // the Lens tab serving its stale cached response for the app's real 30s
  // staleTime (queryClient.ts) -- e.g. a detached plan's derived rows kept
  // showing, captioned "via" a plan no longer attached, exactly what R1
  // ("derive, never write") exists to make impossible.
  //
  // Non-vacuity: `renderDetail()`'s own bare QueryClient (`{ retry: false
  // }`, no `staleTime`) defaults `staleTime` to 0, under which react-query
  // refetches on every remount regardless of invalidation -- that would
  // make this assertion pass even with the bug present, proving nothing.
  // This test builds its own client with the SAME staleTime the real app
  // configures, so the second `getReleaseLens` call can only happen because
  // `unlinkPlan`'s `onSuccess` explicitly invalidated the lens query.
  // Confirmed red against the pre-fix code (reverted the `invalidateQueries`
  // calls in ReleaseDetail.tsx, ran this test alone, saw it fail with
  // `getReleaseLens` called 1 time instead of 2, then restored the fix).
  it('unlinking a test plan invalidates the release lens so revisiting the Lens tab refetches it, not the stale cached envelope (Finding 1)', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    render(
      <QueryClientProvider client={client}>
        <WorkbenchStoreProvider projectId={1}>
          <ReleaseDetail entityId="release-mongo-1" />
        </WorkbenchStoreProvider>
      </QueryClientProvider>,
    );
    await screen.findByText(/REL-1/);

    // First visit to the Lens tab: one fetch.
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));
    await waitFor(() => expect(mockGetReleaseLens).toHaveBeenCalledTimes(1));

    // Leave the Lens tab -- DetailTabs renders `{active && children}`, so
    // the lens query loses its only observer here, but stays cached with a
    // 30s staleTime that would otherwise serve it unchanged on remount.
    fireEvent.click(screen.getByRole('tab', { name: 'Linked Test Plans' }));
    await screen.findByText('PLN-1');
    fireEvent.click(screen.getByRole('button', { name: /unlink pln-1/i }));
    await waitFor(() => expect(mockUnlinkTestPlan).toHaveBeenCalled());

    // Returning to the Lens tab must refetch -- the fix under test.
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));
    await waitFor(() => expect(mockGetReleaseLens).toHaveBeenCalledTimes(2));
  });

  // R5's other half: a release with NOTHING linked reads as an honest
  // empty state, never a percentage (there is none to compute -- 0 of 0)
  // and never an error. Non-vacuity: deleting the `nothingLinked` branch
  // (or its condition) makes this render the summary sentence instead,
  // which would show "0 linked defects, 0 linked requirements, ... 0
  // executed" -- technically not wrong, but exactly the "confident number
  // computed over nothing" shape this task's whole ruling exists to avoid.
  it('the Lens tab reads "nothing linked yet" for a release with no links and no test plans (R5)', async () => {
    mockGetRelease.mockResolvedValue({ ...RELEASE_RECORD, releaseId: 'REL-2', linkedTestPlanIds: [] });
    mockGetReleaseLens.mockResolvedValue(LENS_ENVELOPE_EMPTY);
    renderDetail();
    await screen.findByText(/REL-2/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));

    expect(await screen.findByText(/Nothing linked yet/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/linked defect/)).not.toBeInTheDocument();
  });

  // WP-F15b Task 2, R2 -- explicit and derived members render distinctly,
  // in the same section, in the same render. Non-vacuity: rendering a
  // derived row with the exact same markup as a linked row (no
  // data-testid="lens-derived-chip", no `via` caption) makes the
  // `getAllByTestId('lens-derived-chip')` count below come back 0 (or,
  // depending on how the collapse is written, `queryAllByTestId('lens-
  // requirement-linked-row')` would include REQ-9 -- either way this fails).
  // This assertion is NOT reconciliation-dependent: both explicit and
  // derived rows are present on ONE fresh mount, so there is no
  // update-vs-initial-render gap for a broken implementation to hide behind.
  it('the Lens tab marks derived requirements/test cases distinctly from explicit links, and names their source (R2)', async () => {
    mockGetRelease.mockResolvedValue({ ...RELEASE_RECORD, releaseId: 'REL-4', linkedTestPlanIds: ['plan-mongo-9'] });
    mockGetReleaseLens.mockResolvedValue(LENS_ENVELOPE_MIXED);
    const { container } = renderDetailForLens();
    await screen.findByText(/REL-4/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));

    await waitFor(() => expect(mockGetReleaseLens).toHaveBeenCalledWith('REL-4'));

    // WP-F23 Task 1, R1 -- both groups start collapsed; expand each to
    // reach their grids.
    fireEvent.click(await screen.findByRole('button', { name: /toggle requirements/i }));
    fireEvent.click(screen.getByRole('button', { name: /toggle test cases/i }));
    await screen.findByTestId('lens-requirements-grid');
    await screen.findByTestId('lens-test-cases-grid');

    // @mui/x-data-grid stamps every row with `data-id={id}` (getRowId here
    // returns reqId/TestCaseId directly) -- a genuine per-row DOM lookup,
    // not a testid this task had to invent redundantly.
    const linkedReqRow = getGridRowById(container, 'REQ-1');
    expect(linkedReqRow).toHaveTextContent('REQ-1');
    expect(within(linkedReqRow).queryByTestId('lens-derived-chip')).not.toBeInTheDocument();
    expect(within(linkedReqRow).getByTestId('lens-asserted-chip')).toHaveTextContent('Asserted');

    const linkedCaseRow = getGridRowById(container, 'TC-1');
    expect(linkedCaseRow).toHaveTextContent('TC-1');
    expect(within(linkedCaseRow).queryByTestId('lens-derived-chip')).not.toBeInTheDocument();

    // The derived rows exist, carry the "Derived" marker, and name their
    // source (the requirement's via names the covering test case; the test
    // case's via names the attached plan).
    const derivedReqRow = getGridRowById(container, 'REQ-9');
    expect(derivedReqRow).toHaveTextContent('REQ-9');
    expect(within(derivedReqRow).getByTestId('lens-derived-chip')).toHaveTextContent('Derived');
    expect(within(derivedReqRow).getByTestId('lens-requirement-derived-via')).toHaveTextContent('via TC-5');

    const derivedCaseRow = getGridRowById(container, 'TC-9');
    expect(derivedCaseRow).toHaveTextContent('TC-9');
    expect(within(derivedCaseRow).getByTestId('lens-derived-chip')).toHaveTextContent('Derived');
    expect(within(derivedCaseRow).getByTestId('lens-testcase-derived-via')).toHaveTextContent('via PLN-9');

    // Exactly the two derived rows carry the "Derived" chip, and exactly
    // the two explicit ones carry "Asserted" -- not a mix.
    expect(screen.getAllByTestId('lens-derived-chip')).toHaveLength(2);
    expect(screen.getAllByTestId('lens-asserted-chip')).toHaveLength(2);

    // The group titles state the aggregate denominator R4 requires: "N
    // derived via M ..." is a different fact from "N linked directly", and
    // must read differently.
    expect(screen.getByText(/Requirements \(1 linked, 1 derived via 1 test case\)/)).toBeInTheDocument();
    expect(screen.getByText(/Test cases \(1 linked, 1 derived via 1 plan\)/)).toBeInTheDocument();

    // The HEADLINE sentence above the groups states the same "N derived via
    // M ..." clause too, not just `linkedCount`/`links.*` (Fix round,
    // Finding 2, MINOR, from the predecessor task -- unaffected by this
    // task's grid rewrite, still asserted here for the same reason).
    expect(screen.getByText(/1 linked requirement, 1 derived via 1 test case, /)).toBeInTheDocument();
    expect(screen.getByText(/1 linked test case, 1 derived via 1 plan, /)).toBeInTheDocument();
  });

  // WP-F15b Task 2, R2 -- a release whose ONLY members are derived (nothing
  // explicitly linked at all) must not read as "Nothing linked yet": that
  // would erase the difference between "no coverage" and "coverage exists,
  // nobody asserted it by hand". Non-vacuity: reverting the `nothingLinked`
  // guard to ignore `testPlans.configuredCount` (checking only
  // `requirements.linkedCount`/`testCases.linkedCount`/`defects.linkedCount`)
  // would make this fixture (all three 0) read as "Nothing linked yet",
  // failing the first assertion below.
  it('a release whose only members are derived does not read as "nothing linked" (R2)', async () => {
    mockGetRelease.mockResolvedValue({ ...RELEASE_RECORD, releaseId: 'REL-3', linkedTestPlanIds: ['plan-mongo-9'] });
    mockGetReleaseLens.mockResolvedValue(LENS_ENVELOPE_DERIVED_ONLY);
    const { container } = renderDetailForLens();
    await screen.findByText(/REL-3/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));

    // Fix round (Finding 6, MINOR) -- this negative assertion must run
    // against a genuinely rendered panel, not merely after `getReleaseLens`
    // was CALLED. `findByRole` below waits for the toggle to actually
    // exist, which only happens once `lensQuery.isLoading` has cleared
    // (ReleaseLensPanel renders nothing but a spinner until then) -- so by
    // the time this assertion runs, the empty/nothing-linked branch has
    // genuinely had the chance to render and did not.
    const requirementsToggle = await screen.findByRole('button', { name: /toggle requirements/i });
    expect(screen.queryByText(/Nothing linked yet/i)).not.toBeInTheDocument();

    fireEvent.click(requirementsToggle);
    fireEvent.click(screen.getByRole('button', { name: /toggle test cases/i }));

    const derivedReqRow = getGridRowById(container, 'REQ-9');
    expect(derivedReqRow).toHaveTextContent('REQ-9');
    expect(within(derivedReqRow).getByTestId('lens-requirement-derived-via')).toHaveTextContent('via TC-5');

    const derivedCaseRow = getGridRowById(container, 'TC-5');
    expect(derivedCaseRow).toHaveTextContent('TC-5');
    expect(within(derivedCaseRow).getByTestId('lens-testcase-derived-via')).toHaveTextContent('via PLN-9');
  });
});

// WP-F24 Task 1 -- ReleaseDetail's Details tab now reads getFields(6) and
// merges it over the fixed RELEASE_FIELDS list (R1: supplement, never
// replace). Verified live (this task's own report): 621 of 622 projects
// have zero module-6 field documents, so the "no configured fields" test
// below is not an edge case -- it is the state almost every real project is
// in, and the one a careless merge breaks first.
describe('ReleaseDetail — configurable fields (WP-F24 Task 1)', () => {
  // Pure-function coverage of the merge/collision rule itself, independent
  // of rendering -- see the render-level tests below for the same rule
  // proven through the actual DOM.
  describe('mergeConfiguredReleaseFields', () => {
    it('returns the built-ins unchanged when nothing is configured', () => {
      const { fields, ignoredReservedCollisions } = mergeConfiguredReleaseFields([]);
      expect(fields.map((f) => f.fieldName)).toEqual(['name', 'status', 'notes']);
      expect(fields.find((f) => f.fieldName === 'status')?.displayName).toBe('Status');
      expect(ignoredReservedCollisions).toEqual([]);
    });

    // Single-line break: swapping the function body's final
    // `[...builtIns, ...additions]` for just `additions` (replace instead
    // of supplement, R1's forbidden direction) makes this fail -- 'name'
    // and 'notes' would vanish even though nothing configured collides
    // with them.
    it('appends a non-colliding configured field after the built-ins', () => {
      const { fields } = mergeConfiguredReleaseFields([
        { fieldName: 'priority', displayName: 'Priority', fieldType: 'Text', isDisplayed: true, isMandatory: false },
      ]);
      expect(fields.map((f) => f.fieldName)).toEqual(['name', 'status', 'notes', 'priority']);
    });

    // R2's collision rule: single-line break is replacing
    // `collision?.displayName ? { ...builtIn, displayName: collision.displayName } : builtIn`
    // with plain `builtIn` -- the row would stay exactly one 'status'
    // entry (still non-vacuous to check for two), but its label would stop
    // moving, which is the actual behaviour under test here.
    it('relabels, but does not duplicate or drop, a built-in a configured field collides with', () => {
      const { fields } = mergeConfiguredReleaseFields([
        {
          fieldName: 'status',
          displayName: 'Release Status',
          fieldType: 'DropDown',
          isDisplayed: true,
          isMandatory: true,
        },
      ]);
      const statusFields = fields.filter((f) => f.fieldName === 'status');
      expect(statusFields).toHaveLength(1);
      expect(statusFields[0].displayName).toBe('Release Status');
      // R1: the built-in's own type/options survive the relabel untouched.
      expect(statusFields[0].fieldType).toBe('DropDown');
      expect(statusFields[0].defaultValue).toEqual(['planned', 'in-progress', 'frozen', 'released', 'cancelled']);
    });

    // A configured field with an empty displayName does not blank the
    // built-in's own label -- there is nothing meaningful to show instead.
    it('keeps the built-in label when the colliding configured field has no displayName', () => {
      const { fields } = mergeConfiguredReleaseFields([
        { fieldName: 'status', displayName: '', fieldType: 'DropDown', isDisplayed: true, isMandatory: true },
      ]);
      expect(fields.find((f) => f.fieldName === 'status')?.displayName).toBe('Status');
    });

    // WP-F24 Task 1 (fix round 2) -- the MAJOR finding: `targetDate` is a
    // real `Release` field FieldGrid never renders (R5, hand-rolled
    // separately), so the OLD guard (only the three RELEASE_FIELDS names)
    // never recognised a configured field named `targetDate` as a
    // collision at all -- it fell straight into `additions`. Single-line
    // break: deleting the `if (RESERVED_RELEASE_FIELD_NAMES.has(...))`
    // branch (or shrinking `RESERVED_RELEASE_FIELD_NAMES` back down to just
    // the three built-in names) makes `targetDate` reappear in `fields`.
    it('excludes, rather than appends, a configured field colliding with a reserved Release attribute FieldGrid has no control for', () => {
      const { fields, ignoredReservedCollisions } = mergeConfiguredReleaseFields([
        { fieldName: 'targetDate', displayName: 'Custom Target Date', fieldType: 'Text', isDisplayed: true, isMandatory: false },
      ]);
      expect(fields.map((f) => f.fieldName)).toEqual(['name', 'status', 'notes']);
      expect(ignoredReservedCollisions).toEqual(['targetDate']);
    });

    // Same guard, proven against a second reserved name the reviewer named
    // explicitly (an array-typed field, not a date) -- not just re-running
    // the same assertion under a different label. Single-line break: same
    // as above.
    it('excludes a configured field colliding with linkedTestPlanIds the same way', () => {
      const { fields, ignoredReservedCollisions } = mergeConfiguredReleaseFields([
        { fieldName: 'linkedTestPlanIds', displayName: 'Linked plans', fieldType: 'Text', isDisplayed: true, isMandatory: false },
      ]);
      expect(fields.map((f) => f.fieldName)).toEqual(['name', 'status', 'notes']);
      expect(ignoredReservedCollisions).toEqual(['linkedTestPlanIds']);
    });

    // A genuinely new name is unaffected by the reserved-set guard --
    // proves the guard has not over-reached into names that were never a
    // problem. Single-line break: widening `RESERVED_RELEASE_FIELD_NAMES`
    // (e.g. building it from something broader than `keyof Release`) would
    // start rejecting this too.
    it('does not treat an unrelated new field name as a reserved collision', () => {
      const { fields, ignoredReservedCollisions } = mergeConfiguredReleaseFields([
        { fieldName: 'priority', displayName: 'Priority', fieldType: 'Text', isDisplayed: true, isMandatory: false },
      ]);
      expect(fields.map((f) => f.fieldName)).toContain('priority');
      expect(ignoredReservedCollisions).toEqual([]);
    });
  });

  // Render-level: the same 621-project case, proven through the DOM this
  // time, not just the pure function. A React first mount renders every
  // child regardless of whether the merge behind it is correct, so what
  // makes this non-vacuous is asserting there is EXACTLY ONE of each
  // built-in (no accidental duplicate row) and that no unexpected extra
  // textbox/combobox appears -- not just that Name/Status/Notes are
  // present somewhere on the page.
  it('renders exactly the three built-ins, unchanged, when no fields are configured', async () => {
    mockGetFields.mockResolvedValue([]);
    renderDetail();
    await screen.findByText(/REL-1/);

    expect(screen.getByLabelText('Name', { exact: false })).toHaveValue('Spring Launch');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('planned');
    expect(screen.getByLabelText('Notes')).toHaveValue('Ship it');
    // Exactly one combobox (Status) and exactly two plain textboxes
    // (Name, Notes) in the Details tab's FieldGrid -- proves nothing extra
    // slipped in alongside the built-ins.
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(mockGetFields).toHaveBeenCalledWith(6);
  });

  // Single-line break: dropping the `...additions` spread from the merge
  // function's return (`return builtIns;`) makes this fail -- Priority
  // would never reach FieldGrid at all.
  it('shows a configured Text field in addition to the built-ins', async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'priority', displayName: 'Priority', fieldType: 'Text', isDisplayed: true, isMandatory: false },
    ]);
    renderDetail();
    await screen.findByText(/REL-1/);

    expect(screen.getByLabelText('Name', { exact: false })).toHaveValue('Spring Launch');
    expect(screen.getByLabelText('Notes')).toHaveValue('Ship it');
    expect(screen.getByLabelText('Priority')).toBeEnabled();
  });

  // R2 proven through the DOM: a configured 'status' field does not vanish
  // silently (the failure mode this ruling exists to remove) and does not
  // duplicate the row either -- it relabels the one row that exists.
  // Single-line break: same as the pure-function test above, dropping the
  // displayName override in mergeConfiguredReleaseFields.
  it('resolves a fieldName collision by relabelling the built-in, visibly, without duplicating it', async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'status', displayName: 'Release Status', fieldType: 'DropDown', isDisplayed: true, isMandatory: true },
    ]);
    renderDetail();
    await screen.findByText(/REL-1/);

    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    const statusControl = screen.getByRole('combobox', { name: 'Release Status' });
    expect(statusControl).toHaveTextContent('planned');
    // The old label is genuinely gone, not just duplicated alongside the
    // new one.
    expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
  });

  // R1's own "not deletable/hideable" guarantee: isDisplayed only ever
  // hides a CONFIGURED addition, never a built-in (the built-ins are
  // always isDisplayed: true, declared above). Single-line break: in
  // FieldGrid.tsx, dropping `field.isDisplayed &&` from `visibleFields`'s
  // filter predicate -- performed and reverted as this task's own probe
  // (see this task's report).
  it('does not render a configured field whose isDisplayed is false', async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'internalNote', displayName: 'Internal Note', fieldType: 'Text', isDisplayed: false, isMandatory: false },
    ]);
    renderDetail();
    await screen.findByText(/REL-1/);

    expect(screen.getByLabelText('Name', { exact: false })).toHaveValue('Spring Launch');
    expect(screen.queryByLabelText('Internal Note')).not.toBeInTheDocument();
  });

  // The failure mode this whole task exists to guard against on the query
  // side: getFields(6) 404s or otherwise rejects for nearly every project
  // (this describe block's own header comment), and that must not blank
  // the built-ins. Single-line break: replacing `fieldsQuery.data ?? []`
  // with `fieldsQuery.data as FieldDefinition[]` in ReleaseDetail.tsx --
  // `configured.find(...)` inside the merge then throws on the `undefined`
  // a rejected/still-settling query leaves `fieldsQuery.data` as, and the
  // whole Details tab throws instead of rendering the built-ins.
  it('still renders the built-ins when the fields query fails', async () => {
    mockGetFields.mockRejectedValue(new Error('404'));
    renderDetail();
    await screen.findByText(/REL-1/);

    expect(screen.getByLabelText('Name', { exact: false })).toHaveValue('Spring Launch');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('planned');
    expect(screen.getByLabelText('Notes')).toHaveValue('Ship it');
  });

  // Same commit path as a built-in (this file's own "saves a single field
  // via updateRelease without a global edit mode" test, above, for 'name'):
  // no branch in handleFieldCommit distinguishes a configured field from a
  // built-in one. Single-line break: adding an `if (!fieldDef?.isDefault)
  // return;` guard (or similar special-casing) to handleFieldCommit would
  // make this fail while leaving the built-in test untouched -- proving
  // this test covers something the built-in one does not.
  // WP-F24 Task 1 (fix round 1) -- "the same path as a built-in" no longer
  // means the literal same top-level key: Release.js has no schema path for
  // an arbitrary configured field name (fix round 1's whole point), so a
  // configured field commits into `dynamicFields` instead -- see
  // handleFieldCommit's own header comment. What stays "the same path" is
  // the mechanism: one generic `commitField.mutate(...)` call, no separate
  // save button, no separate mutation object for configured fields.
  // Single-line break: deleting the `if (fieldDef && !fieldDef.isDefault)`
  // branch in handleFieldCommit (routing everything through the built-in
  // `else` -- i.e. `commitField.mutate({ [fieldName]: value })` even for
  // Priority) makes this fail, since `updateRelease` would then be called
  // with `{ priority: 'High' }`, not `{ dynamicFields: { priority: 'High' } }`.
  it("editing and saving a configured field's value commits into dynamicFields, through the same commitField mutation a built-in uses", async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'priority', displayName: 'Priority', fieldType: 'Text', isDisplayed: true, isMandatory: false },
    ]);
    renderDetail();
    await screen.findByText(/REL-1/);

    const priorityInput = await screen.findByLabelText('Priority');
    fireEvent.change(priorityInput, { target: { value: 'High' } });
    fireEvent.blur(priorityInput);

    await waitFor(() => {
      expect(mockUpdateRelease).toHaveBeenCalledWith('release-mongo-1', { dynamicFields: { priority: 'High' } });
    });
  });

  // WP-F24 Task 1 (fix round 1) -- the coordinator's own concern: this is
  // the actual bug the schema-less Release model produced, proven at the
  // level a mocked unit test CAN prove it (the real end-to-end round trip,
  // against the live releaseservice container with the new `dynamicFields`
  // schema path, is releaseService/__tests__/api.test.js's own new "PUT
  // .../:id persists dynamicFields, readable back from a separate GET"
  // test -- see this task's own report for that evidence). Here: a fresh
  // mount (a brand-new QueryClient via renderDetail(), so NOTHING carries
  // over from the mount that made the edit -- no optimistic cache, no
  // stale query data) must show the value that was saved, proving it came
  // from the SECOND getRelease response (the "reload"), not from any
  // client-side echo of what was typed.
  //
  // Single-line break: removing the dynamicFields-flatten spread from the
  // `values` computation above (`...((rawValues.dynamicFields as
  // Record<string, unknown>) ?? {})`) -- the second mount's Priority input
  // would then read back empty even though the mocked "server" genuinely
  // returned `dynamicFields: { priority: 'High' }`.
  it("a configured field's value persists across a save and a full reload (fresh mount, fresh cache)", async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'priority', displayName: 'Priority', fieldType: 'Text', isDisplayed: true, isMandatory: false },
    ]);
    // Call 1: this mount's initial fetch. Call 2: commitField's own
    // onSettled invalidates the entity query, which refetches WITHIN this
    // same (first) mount, before the test ever unmounts anything -- so the
    // "server now has the new value" response has to be queued for call 2
    // as well, not only for the eventual reload. `mockResolvedValue` (not
    // `Once`) as the fallback covers both call 2 and the reload's call 3.
    mockGetRelease.mockResolvedValueOnce(RELEASE_RECORD);
    mockGetRelease.mockResolvedValue({ ...RELEASE_RECORD, dynamicFields: { priority: 'High' } });
    mockUpdateRelease.mockResolvedValue({ ...RELEASE_RECORD, dynamicFields: { priority: 'High' } });

    const { unmount } = renderDetail();
    await screen.findByText(/REL-1/);
    const priorityInput = await screen.findByLabelText('Priority');
    expect(priorityInput).toHaveValue('');

    fireEvent.change(priorityInput, { target: { value: 'High' } });
    fireEvent.blur(priorityInput);
    await waitFor(() => {
      expect(mockUpdateRelease).toHaveBeenCalledWith('release-mongo-1', { dynamicFields: { priority: 'High' } });
    });
    await waitFor(() => expect(mockGetRelease).toHaveBeenCalledTimes(2));

    // A genuine reload, not a re-render: unmount discards this mount's
    // entire react-query cache (renderDetail() below makes a brand-new
    // QueryClient), so whatever appears next can only have come from a
    // FRESH getRelease call (call 3), not from anything left over in the
    // first mount's cache/optimistic state.
    unmount();
    renderDetail();
    await screen.findByText(/REL-1/);
    expect(await screen.findByLabelText('Priority')).toHaveValue('High');
    expect(mockGetRelease).toHaveBeenCalledTimes(3);
  });

  // R1's other half, re-guarded after this fix round's changes to
  // handleFieldCommit: a BUILT-IN field must still commit as a plain
  // top-level key, unaffected by dynamicFields existing at all -- even
  // with a configured field also present on the same form. Single-line
  // break: swapping `!fieldDef.isDefault` for `fieldDef.isDefault` in
  // handleFieldCommit's condition (or dropping the condition and always
  // wrapping in dynamicFields) would route this into
  // `{ dynamicFields: { notes: 'Updated notes' } }` instead.
  it('a built-in field still commits as a plain top-level key, even with a configured field also present', async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'priority', displayName: 'Priority', fieldType: 'Text', isDisplayed: true, isMandatory: false },
    ]);
    renderDetail();
    await screen.findByText(/REL-1/);
    await screen.findByLabelText('Priority');

    const notesInput = screen.getByLabelText('Notes');
    fireEvent.change(notesInput, { target: { value: 'Updated notes' } });
    fireEvent.blur(notesInput);

    await waitFor(() => {
      expect(mockUpdateRelease).toHaveBeenCalledWith('release-mongo-1', { notes: 'Updated notes' });
    });
  });

  // R2/R1 -- an untouched configured field sitting on the form must not
  // smuggle a stray `dynamicFields` key onto an unrelated built-in's own
  // commit. `toHaveBeenCalledWith` already does a deep-equality match (so
  // an extra key on the actual call object fails it on its own), but the
  // explicit `not.toHaveProperty` below names the exact failure mode this
  // test exists to catch, for a reader skimming just the assertions.
  // Single-line break: changing handleFieldCommit's built-in branch from
  // `commitField.mutate({ [fieldName]: value } as Partial<Release>)` to
  // `commitField.mutate({ [fieldName]: value, dynamicFields: {} } as
  // Partial<Release>)` -- a plausible-looking "always include the bucket"
  // mistake -- would still pass a loose `objectContaining` check but fails
  // both assertions here.
  it('saving a built-in field does not write a stray empty dynamicFields key onto the payload', async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'priority', displayName: 'Priority', fieldType: 'Text', isDisplayed: true, isMandatory: false },
    ]);
    renderDetail();
    await screen.findByText(/REL-1/);
    await screen.findByLabelText('Priority'); // present, untouched

    const nameInput = screen.getByLabelText('Name', { exact: false });
    fireEvent.change(nameInput, { target: { value: 'Spring Launch 2' } });
    fireEvent.blur(nameInput);

    await waitFor(() => {
      expect(mockUpdateRelease).toHaveBeenCalledWith('release-mongo-1', { name: 'Spring Launch 2' });
    });
    const [, patch] = mockUpdateRelease.mock.calls[mockUpdateRelease.mock.calls.length - 1];
    expect(patch).not.toHaveProperty('dynamicFields');
  });

  // WP-F24 Task 1 (fix round 2) -- MAJOR: the actual bug the reviewer
  // traced, proven at render level. `RELEASE_RECORD` already carries
  // `dynamicFields: { targetDate: '2099-12-31' }` here -- simulating data
  // that could only exist from BEFORE this fix round (this file's own
  // commit path can no longer write a reserved name into dynamicFields,
  // per the render-time exclusion below, but nothing about the VALUES
  // computation should depend on that write-time guard having always been
  // in place). Two independent things must both hold:
  //   1. No second control for "Custom Target Date" renders at all.
  //   2. The REAL date input still reads the true `targetDate`
  //      ('2026-12-01'), not the shadowing '2099-12-31'.
  // Single-line break for (1): dropping the
  // `RESERVED_RELEASE_FIELD_NAMES.has(field.fieldName)` branch in
  // `mergeConfiguredReleaseFields` (or shrinking that Set back to the
  // three RELEASE_FIELDS names) lets "Custom Target Date" render.
  // Single-line break for (2), independent of (1): removing the
  // `safeDynamicFields` filter in `ReleaseDetail`'s `values` computation
  // (reverting to `{ ...rawValues, ...(rawValues.dynamicFields ?? {}) }`)
  // makes the real Target Date input read '2099-12-31' instead, even
  // though (1) still passes -- proving the two fixes are genuinely
  // independent, as fix round 2 required.
  it('a configured field named targetDate does not render a second control and does not shadow the real Target Date', async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'targetDate', displayName: 'Custom Target Date', fieldType: 'Text', isDisplayed: true, isMandatory: false },
    ]);
    mockGetRelease.mockResolvedValue({ ...RELEASE_RECORD, dynamicFields: { targetDate: '2099-12-31' } });
    renderDetail();
    await screen.findByText(/REL-1/);

    expect(screen.queryByLabelText('Custom Target Date')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Target Date')).toHaveValue('2026-12-01');
  });

  // Same shadowing class, a second reserved name the reviewer named
  // explicitly: an ARRAY replaced by a string, not a date. The Linked Test
  // Plans tab reads `values.linkedTestPlanIds` (via `linkedTestPlanIds`
  // and `linkableTestPlans` above) -- if the shadow reached `values`, that
  // tab would either crash on a non-array `.includes`/`.map` call or
  // silently show no linked plans at all instead of PLN-1. Single-line
  // break: same as case (2) above (removing `safeDynamicFields`'s filter).
  it('a configured field named linkedTestPlanIds does not replace the real array with a string', async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'linkedTestPlanIds', displayName: 'Linked plans (dupe)', fieldType: 'Text', isDisplayed: true, isMandatory: false },
    ]);
    mockGetRelease.mockResolvedValue({ ...RELEASE_RECORD, dynamicFields: { linkedTestPlanIds: 'not-an-array' } });
    renderDetail();
    await screen.findByText(/REL-1/);

    expect(screen.queryByLabelText('Linked plans (dupe)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Linked Test Plans' }));
    // The real array survived the spread -- PLN-1 (RELEASE_RECORD's own
    // linkedTestPlanIds: ['plan-mongo-1'], resolved to its human id) still
    // renders, and the Unlink control for it is still a real, working
    // control, not blown up by a string where an array was expected.
    expect(await screen.findByText('PLN-1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unlink pln-1/i })).toBeEnabled();
  });

  // R2's "not an invisible no-op" applied to the reserved-collision branch
  // specifically (as opposed to the RELEASE_FIELDS relabel branch, already
  // covered above): the admin who named a field `targetDate` sees a
  // specific, visible explanation naming that field, not silence and not a
  // generic error. Single-line break: rendering the
  // `ignoredReservedCollisions` warning unconditionally on an EMPTY array
  // (or deleting the `.length > 0` guard) would make this indistinguishable
  // from a false positive on every other test in this file; conversely,
  // never rendering it at all (deleting the whole block) makes this fail
  // outright, which is the primary regression this test guards.
  it('surfaces a reserved-name collision visibly, naming the ignored field', async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'targetDate', displayName: 'Custom Target Date', fieldType: 'Text', isDisplayed: true, isMandatory: false },
    ]);
    renderDetail();
    await screen.findByText(/REL-1/);

    const warning = await screen.findByTestId('release-ignored-reserved-fields');
    expect(warning).toHaveTextContent('targetDate');
    expect(warning).toHaveTextContent(/will not appear on this form/i);
  });

  // The other side of that same guard: nothing is shown when there is
  // genuinely nothing to report -- otherwise the warning itself would be
  // the new invisible-no-op-shaped bug (a permanent banner nobody can act
  // on). Single-line break: deleting the `ignoredReservedCollisions.length
  // > 0 &&` guard.
  it('shows no reserved-collision warning when nothing configured collides', async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'priority', displayName: 'Priority', fieldType: 'Text', isDisplayed: true, isMandatory: false },
    ]);
    renderDetail();
    await screen.findByText(/REL-1/);
    await screen.findByLabelText('Priority');

    expect(screen.queryByTestId('release-ignored-reserved-fields')).not.toBeInTheDocument();
  });
});

// WP-F23 Task 1 -- the Lens at scale. Requirements/test cases/defects now
// render inside @mui/x-data-grid, client-side paged at 25/50/100, with a
// default sort that surfaces what needs attention first (R2) and the
// derived/asserted distinction preserved inside the grid (R5). Every group
// (including Test plans/Executions, which render no grid) is collapsed by
// default with its count always visible (R1).
describe('ReleaseDetail — Lens at scale (WP-F23 Task 1)', () => {
  function makeLinkedTestCases(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      TestCaseId: `TC-${String(i + 1).padStart(3, '0')}`,
      TestCaseSummary: `Case ${i + 1}`,
      latestStatus: 'Not run in this release',
    }));
  }

  it('a Lens group is collapsed on first render, with its count visible while collapsed', async () => {
    renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));

    // Non-vacuity: flipping LensGroup's `useState(false)` initial value (or
    // dropping it) makes the grid queries below find something immediately
    // -- this test's whole point is that, on first render, they do not.
    expect(await screen.findByText(/Requirements \(1 linked\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('lens-requirements-grid')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /toggle requirements/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('expanding a Lens group mounts its grid', async () => {
    renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));
    await screen.findByText(/Requirements \(1 linked\)/);

    const toggle = screen.getByRole('button', { name: /toggle requirements/i });
    // Non-vacuity: an onClick that does not flip LensGroup's `expanded`
    // state (or a `Collapse` never wired to it) leaves this `findByTestId`
    // with nothing to find.
    fireEvent.click(toggle);

    expect(await screen.findByTestId('lens-requirements-grid')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('a group with zero items reads as an honest empty state, not a bare count (R6)', async () => {
    // LENS_ENVELOPE's own testCases section is genuinely empty
    // (linkedCount/derivedCount both 0) while requirements/defects/test
    // plans are not -- so this is a real "this ONE group has nothing" case,
    // not the whole-release "nothing linked yet" banner.
    renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));

    fireEvent.click(await screen.findByRole('button', { name: /toggle test cases/i }));

    // Non-vacuity: dropping the `testCases.linkedCount === 0 &&
    // testCases.derivedCount === 0` empty-state branch in ReleaseDetail.tsx
    // would mount an empty DataGrid instead -- `queryByTestId` below would
    // find it, and DataGrid's own noRowsOverlay reads a generic "No rows",
    // never naming what specifically has nothing linked (R6: "No test cases
    // linked" and "0 failing" are different claims).
    expect(await screen.findByText('No test cases linked.')).toBeInTheDocument();
    expect(screen.queryByTestId('lens-test-cases-grid')).not.toBeInTheDocument();
  });

  it('a test-cases group with 60 items renders one page of 25, not all 60, and states the true total (R1/R3)', async () => {
    const linked = makeLinkedTestCases(60);
    mockGetReleaseLens.mockResolvedValue({
      ...LENS_ENVELOPE,
      data: {
        ...LENS_ENVELOPE.data,
        testCases: { linkedCount: 60, linked, derivedCount: 0, derived: [] },
      },
    });
    renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));

    // R1: the true total is stated in the heading while the group is still
    // collapsed -- the summary half is never behind the disclosure.
    expect(await screen.findByText(/Test cases \(60 linked\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('lens-test-cases-grid')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /toggle test cases/i }));
    const grid = await screen.findByTestId('lens-test-cases-grid');

    // Non-vacuity (this task's own brief): React renders every child on a
    // fresh mount, so merely finding TC-001 on screen would pass even
    // against a broken, unpaged implementation that rendered all 60 rows.
    // What actually distinguishes "paged" from "not paged" is the TOTAL row
    // count in the DOM -- DataGrid's own header row plus exactly one row
    // per rendered item. Single-line break: bumping `pageSize: 25` to
    // `pageSize: 100` in the Test cases DataGrid's `initialState`
    // (ReleaseDetail.tsx) makes this assert 61 rows, not 26.
    await waitFor(() => {
      expect(within(grid).getAllByRole('row')).toHaveLength(26);
    });
    expect(within(grid).getByText('TC-001')).toBeInTheDocument();
    expect(within(grid).queryByText('TC-060')).not.toBeInTheDocument();
  });

  it('defects default-sort unresolved before resolved, without the user touching the sort (R2)', async () => {
    mockGetReleaseLens.mockResolvedValue({
      ...LENS_ENVELOPE,
      data: {
        ...LENS_ENVELOPE.data,
        defects: {
          linkedCount: 2,
          byStatus: { categories: ['Closed', 'Open'], series: [{ id: 'count', label: 'Defects', data: [1, 1] }] },
          // Deliberately reverse-alphabetical vs. status: if the grid fell
          // back to array/id order, Bug-A (closed) would render first.
          linked: [
            { defectId: 'Bug-A', summary: 'Old, fixed', Status: 'Closed', Severity: 'Low' },
            { defectId: 'Bug-Z', summary: 'Still broken', Status: 'Open', Severity: 'High' },
          ],
        },
      },
    });
    renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));
    fireEvent.click(await screen.findByRole('button', { name: /toggle defects/i }));
    const grid = await screen.findByTestId('lens-defects-grid');

    // Wait for both rows to have actually rendered before reading their
    // order -- DataGrid populates asynchronously even for an in-memory
    // rows array.
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(3));

    // Non-vacuity: removing `sorting: { sortModel: [...] }` from the
    // Defects DataGrid's `initialState` (ReleaseDetail.tsx) falls back to
    // array order (Bug-A, Bug-Z) -- indistinguishable from this fixture's
    // own array order, so this assertion is the one that actually catches
    // that regression, not merely that both defects are on screen.
    const dataRows = within(grid).getAllByRole('row').slice(1);
    expect(within(dataRows[0]).getByText('Bug-Z')).toBeInTheDocument();
    expect(within(dataRows[1]).getByText('Bug-A')).toBeInTheDocument();
  });

  it('requirements default-sort derived members before asserted ones, without the user touching the sort (R2/R5)', async () => {
    mockGetReleaseLens.mockResolvedValue({
      ...LENS_ENVELOPE,
      data: {
        ...LENS_ENVELOPE.data,
        requirements: {
          linkedCount: 1,
          // Deliberately reverse-alphabetical vs. membership: REQ-A
          // (asserted) sorts first if this were plain id order.
          linked: [{ reqId: 'REQ-A', requirementSummary: 'Asserted' }],
          derivedCount: 1,
          derived: [{ reqId: 'REQ-Z', requirementSummary: 'Derived', via: [{ TestCaseId: 'TC-1' }] }],
        },
      },
    });
    renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));

    fireEvent.click(await screen.findByRole('button', { name: /toggle requirements/i }));
    const reqGrid = await screen.findByTestId('lens-requirements-grid');
    await waitFor(() => expect(within(reqGrid).getAllByRole('row')).toHaveLength(3));
    // Non-vacuity: removing this column's `sortComparator` (or the
    // `sorting: {...}` initialState entry) in ReleaseDetail.tsx falls back
    // to array order (REQ-A then REQ-Z, `linked` before `derived` in
    // buildRequirementRows) -- identical to plain id order for this
    // fixture, so this is the assertion that actually distinguishes the two.
    const reqDataRows = within(reqGrid).getAllByRole('row').slice(1);
    expect(within(reqDataRows[0]).getByText('REQ-Z')).toBeInTheDocument();
    expect(within(reqDataRows[1]).getByText('REQ-A')).toBeInTheDocument();
  });

  // Fix round 1 (R3 amended) -- this closes the finding the task's own
  // report recorded: the lens now attaches `latestStatus`
  // (backend/reportingService/services/releaseLens.js), scoped to THIS
  // release's own executions, and this grid's default sort finally does
  // what R2 always asked for test cases: failing first. Deliberately
  // reverse-alphabetical vs. status (TC-A/Pass, TC-Z/Fail) so a fallback to
  // id order is distinguishable from the real fix, not coincidentally
  // identical to it.
  it('test cases default-sort a failing case above a passing one, without the user touching the sort (R2)', async () => {
    mockGetReleaseLens.mockResolvedValue({
      ...LENS_ENVELOPE,
      data: {
        ...LENS_ENVELOPE.data,
        testCases: {
          linkedCount: 2,
          linked: [
            { TestCaseId: 'TC-A', TestCaseSummary: 'Currently passing', latestStatus: 'Pass' },
            { TestCaseId: 'TC-Z', TestCaseSummary: 'Currently failing', latestStatus: 'Fail' },
          ],
          derivedCount: 0,
          derived: [],
        },
      },
    });
    renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));
    fireEvent.click(await screen.findByRole('button', { name: /toggle test cases/i }));
    const grid = await screen.findByTestId('lens-test-cases-grid');
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(3));

    // Single-line break: changing `testCaseExecutionRank`'s 'Fail' branch
    // from `return 0;` to `return 2;` (or higher, tying/beating 'Pass''s own
    // rank) inverts this fixture's order to TC-A-then-TC-Z -- confirmed by
    // physically making that edit, seeing this assertion fail, then
    // reverting (see this task's report for the probe evidence). Merely
    // deleting the 'Fail' branch does NOT break this test: a case with no
    // recognised status still ranks below 'Pass' via the shared default
    // branch, so removing the branch is not, on its own, a distinguishing
    // probe here -- inverting its RANK relative to 'Pass' is.
    const dataRows = within(grid).getAllByRole('row').slice(1);
    expect(within(dataRows[0]).getByText('TC-Z')).toBeInTheDocument();
    expect(within(dataRows[1]).getByText('TC-A')).toBeInTheDocument();
  });

  // R2 (fix round 1) -- an unrecognised status must never sort as if it
  // were a pass. 'QuarkEntangled' appears nowhere else in this codebase
  // (checked before choosing it), so this genuinely exercises
  // testCaseExecutionRank's DEFAULT branch rather than a value someone
  // already special-cased in a whitelist.
  it('test cases default-sort an unrecognised status above a passing one, never as if it were passing (R2)', async () => {
    mockGetReleaseLens.mockResolvedValue({
      ...LENS_ENVELOPE,
      data: {
        ...LENS_ENVELOPE.data,
        testCases: {
          linkedCount: 2,
          linked: [
            { TestCaseId: 'TC-A', TestCaseSummary: 'Currently passing', latestStatus: 'Pass' },
            { TestCaseId: 'TC-Z', TestCaseSummary: 'Never-seen status', latestStatus: 'QuarkEntangled' },
          ],
          derivedCount: 0,
          derived: [],
        },
      },
    });
    renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));
    fireEvent.click(await screen.findByRole('button', { name: /toggle test cases/i }));
    const grid = await screen.findByTestId('lens-test-cases-grid');
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(3));

    // Single-line break: changing testCaseExecutionRank's default `return
    // 1;` to `return 2;` (or any change that ranks an unrecognised status
    // the same as 'Pass') makes this fixture tie on rank and fall back to
    // id order (TC-A before TC-Z), failing this assertion.
    const dataRows = within(grid).getAllByRole('row').slice(1);
    expect(within(dataRows[0]).getByText('TC-Z')).toBeInTheDocument();
    expect(within(dataRows[1]).getByText('TC-A')).toBeInTheDocument();
  });

  // Fix round 2 -- an unrecognised status must never be PAINTED as passing
  // either, not just sorted correctly. StatusChip's own colorMap-miss
  // fallback (Components/common/StatusChip.tsx) hashes an unmapped status
  // onto a rotation that includes 'success', with a checkmark icon keyed
  // off the resolved colour -- so 'QuarkEntangled' (confirmed via grep to
  // appear nowhere else in this codebase, same value the sort test above
  // already established as genuinely unrecognised) could, by hash
  // coincidence, render green with a checkmark. Asserting only that the
  // text 'QuarkEntangled' appears would pass against that exact bug -- the
  // colour/icon must be asserted directly.
  it('an unrecognised test-case status renders neither green nor with a success icon', async () => {
    mockGetReleaseLens.mockResolvedValue({
      ...LENS_ENVELOPE,
      data: {
        ...LENS_ENVELOPE.data,
        testCases: {
          linkedCount: 1,
          linked: [{ TestCaseId: 'TC-Q', TestCaseSummary: 'Never-seen status', latestStatus: 'QuarkEntangled' }],
          derivedCount: 0,
          derived: [],
        },
      },
    });
    renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));
    fireEvent.click(await screen.findByRole('button', { name: /toggle test cases/i }));
    const grid = await screen.findByTestId('lens-test-cases-grid');

    const chip = await within(grid).findByTestId('lens-testcase-status-chip');
    expect(chip).toHaveTextContent('QuarkEntangled');

    // Single-line break: removing `colorMap={testCaseStatusColorMap(...)}`
    // from the Status column's `renderCell` in ReleaseDetail.tsx lets
    // StatusChip fall back to its own hash-based rotation for this
    // unmapped value -- confirmed by physically making that edit: this
    // assertion failed (this exact string hashes to 'warning', not
    // 'default' -- a different, equally arbitrary colour than the
    // 'success' the coordinator's report illustrated, which is exactly the
    // point: WHICH wrong colour a given string lands on is chance, not a
    // guarantee of neutrality), then the edit was reverted (see this
    // task's report for the probe evidence).
    expect(chip).toHaveClass('MuiChip-colorDefault');
    expect(chip).not.toHaveClass('MuiChip-colorSuccess');
    // The success icon (CheckCircleIcon) is only ever added when the
    // resolved colour came from a known match (StatusChip's own
    // `fromKnownMap` + DEFAULT_STATUS_ICONS) -- absent here regardless of
    // colour, since 'default' has no icon entry at all. Asserted directly
    // rather than "no icon at all" so this would also catch a future
    // change that mapped 'default' to its own (wrong) icon.
    expect(within(chip).queryByTestId('CheckCircleIcon')).not.toBeInTheDocument();
  });

  // R3 amended's own semantic decision, exercised end to end: a case with
  // no execution in this release's own plans reads as the literal sentinel
  // string, is DISPLAYED verbatim (not silently blank, not 'No Run'), and
  // does not sort as if it had passed.
  it('a test case never executed in this release reads as "Not run in this release" and does not sort as passing', async () => {
    mockGetReleaseLens.mockResolvedValue({
      ...LENS_ENVELOPE,
      data: {
        ...LENS_ENVELOPE.data,
        testCases: {
          linkedCount: 2,
          linked: [
            { TestCaseId: 'TC-A', TestCaseSummary: 'Currently passing', latestStatus: 'Pass' },
            { TestCaseId: 'TC-Z', TestCaseSummary: 'Never attempted here', latestStatus: 'Not run in this release' },
          ],
          derivedCount: 0,
          derived: [],
        },
      },
    });
    renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));
    fireEvent.click(await screen.findByRole('button', { name: /toggle test cases/i }));
    const grid = await screen.findByTestId('lens-test-cases-grid');
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(3));

    expect(within(grid).getByText('Not run in this release')).toBeInTheDocument();
    expect(within(grid).queryByText('No Run')).not.toBeInTheDocument();

    const dataRows = within(grid).getAllByRole('row').slice(1);
    expect(within(dataRows[0]).getByText('TC-Z')).toBeInTheDocument();
    expect(within(dataRows[1]).getByText('TC-A')).toBeInTheDocument();
  });

  // Derived-vs-asserted is now the SECONDARY axis for test cases (R2/R5):
  // both cases here tie on execution rank (both 'Fail'), so the tie-break
  // is what this test isolates. Deliberately reverse-alphabetical vs.
  // membership (TC-A asserted, TC-Z derived) so id order can't masquerade
  // as the real tie-break.
  it('test cases with the same execution status tie-break derived before asserted, then id (R2/R5)', async () => {
    mockGetReleaseLens.mockResolvedValue({
      ...LENS_ENVELOPE,
      data: {
        ...LENS_ENVELOPE.data,
        testCases: {
          linkedCount: 1,
          linked: [{ TestCaseId: 'TC-A', TestCaseSummary: 'Asserted, also failing', latestStatus: 'Fail' }],
          derivedCount: 1,
          derived: [
            {
              TestCaseId: 'TC-Z',
              TestCaseSummary: 'Derived, also failing',
              via: [{ _id: 'plan-mongo-1', TestPlanId: 'PLN-1' }],
              latestStatus: 'Fail',
            },
          ],
        },
      },
    });
    renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));
    fireEvent.click(await screen.findByRole('button', { name: /toggle test cases/i }));
    const grid = await screen.findByTestId('lens-test-cases-grid');
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(3));

    // Single-line break: dropping compareTestCaseExecutionFirst's
    // `row1.isDerived !== row2.isDerived` tie-break (falling straight to
    // the id comparison) makes TC-A render first instead, failing this.
    const dataRows = within(grid).getAllByRole('row').slice(1);
    expect(within(dataRows[0]).getByText('TC-Z')).toBeInTheDocument();
    expect(within(dataRows[1]).getByText('TC-A')).toBeInTheDocument();
  });
});

// WP-F18b Task 3 -- Delete, the other capability that was exclusive to
// Pages/releases.tsx until now. See ReleaseDetail.tsx's own header comment
// for the shape (a real MUI confirm <Dialog>, not window.confirm) and this
// WP's plan for why the gating matters: releaseService shipped nine routes
// with zero role checks and a viewer could DELETE a release before the
// 2026-09-19 fix -- the UI must not offer a control the backend will 403,
// and specifically must not offer it to a role that only has write.
describe('ReleaseDetail — Delete (WP-F18b Task 3)', () => {
  it('gates the Delete control on can(\'delete\'), independently of can(\'write\')', async () => {
    renderDetail(); // beforeEach: mockCanWrite = true, mockCanDelete = true
    await screen.findByText(/REL-1/);
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  // Required test 3, and "the case most likely to regress" (this task's
  // own brief): write:true makes it tempting to gate the whole Delete
  // affordance on can('write') alone. A CONTRIBUTOR has write but NOT
  // delete (permissions.ts's PERMISSION_MATRIX) -- asserted with a
  // contributor specifically, not only a viewer, since a viewer-only
  // assertion would still pass a broken "gate everything on write"
  // implementation (a viewer has neither, so it can't tell the two gates
  // apart).
  it('a CONTRIBUTOR (write but not delete) can still edit fields but sees no Delete control', async () => {
    mockCanWrite = true;
    mockCanDelete = false;
    renderDetail();
    await screen.findByText(/REL-1/);

    // The write half still works -- this is not a viewer.
    expect(screen.getByLabelText('Name', { exact: false })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  // Required test 2: confirms first, naming the release, before any
  // network call -- and there is no undo. Non-vacuity: skipping straight
  // to deleteRelease from the Delete button's onClick (no confirm dialog
  // at all) would make the "not yet called" assertion below fail instead
  // of merely being untested.
  it('clicking Delete opens a confirmation naming the release before calling deleteRelease, and there is no undo', async () => {
    renderDetail();
    await screen.findByText(/REL-1/);

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    const dialog = await screen.findByRole('dialog', { name: /delete rel-1/i });
    expect(within(dialog).getAllByText(/REL-1/).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/spring launch/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(mockDeleteRelease).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockDeleteRelease).toHaveBeenCalledWith('release-mongo-1'));
  });

  it('canceling the confirmation never calls deleteRelease', async () => {
    renderDetail();
    await screen.findByText(/REL-1/);

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete rel-1/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockDeleteRelease).not.toHaveBeenCalled();
  });

  // Required test 1's other half (creation's own "opens the new release" is
  // covered in SourcePanel.test.tsx, where NewReleaseButton lives): the
  // deleted release's OWN tab must close, mirroring
  // Hooks/mutations/useDeleteEntity.ts's onSuccess for every other module.
  // Non-vacuity: dropping the `closeTab(thisTabKey)` call in
  // deleteReleaseMutation's onSuccess leaves this release's tab sitting
  // open on a now-404ing entity, and this assertion catches exactly that.
  it('deleting the release closes its own workbench tab', async () => {
    const { getTabs } = renderDetailWithTab('release-mongo-1');
    await screen.findByText(/REL-1/);
    expect(getTabs().some((t) => t.key === tabKey(6, 'release-mongo-1'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete rel-1/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockDeleteRelease).toHaveBeenCalledWith('release-mongo-1'));
    await waitFor(() => expect(getTabs().some((t) => t.key === tabKey(6, 'release-mongo-1'))).toBe(false));
  });
});

// WP-F15/F18 Task 3 -- ends the island: a release can now be linked to the
// defects/requirements/test cases it actually covers, via the SAME
// LinksSection every other detail module mounts (srcModule=6). The one
// wrinkle this task exists to get right: linkIssueService's sourceId/
// destinationId are the entities' HUMAN ids (real seeded data confirms
// this -- Bug-1 -> TC-1, not a pair of Mongo _ids), and Releases is the one
// migrated module whose `entityId` prop is NOT its human id (it's the
// Mongo `_id` -- ReleaseDetail.tsx's own header comment on entityQuery
// explains why). So `issueId` passed to LinksSection must be
// `values.releaseId` ('REL-1'), never `entityId` ('release-mongo-1').
// Every assertion below on `sourceId`/the `getLinkedIssuesApi` query string
// checks that distinction directly.
describe('ReleaseDetail — Links (WP-F15/F18 Task 3)', () => {
  const EXISTING_LINK = {
    _id: 'link-9',
    id: 9,
    sourceId: 'REL-1',
    destinationId: 'DEF-3',
    destinationModule: 5,
    summary: 'Login regression',
    linkType: 'relates-to',
  };

  // Non-vacuity: passing `entityId` ('release-mongo-1') instead of
  // `values.releaseId` as LinksSection's `issueId` makes getLinkedIssuesApi
  // get called with 'sourceId=release-mongo-1' instead, and the mocked
  // response (keyed to 'REL-1' in this test's own fixture, matching how the
  // real backend would filter) would never match -- DEF-3 would not render.
  it("a release's Links tab lists its existing links", async () => {
    mockGetLinkedIssuesApi.mockResolvedValue([EXISTING_LINK]);
    renderDetail();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Links' }));

    expect(await screen.findByText(/DEF-3/)).toBeInTheDocument();
    // Asserts the HUMAN id, not the Mongo _id, was used as the query key.
    expect(mockGetLinkedIssuesApi).toHaveBeenCalledWith('sourceId=REL-1');
  });

  // Non-vacuity: breaking the `srcModule` passed to LinksSection (e.g.
  // ReleaseDetail.tsx's `srcModule={MODULE_ID}` -> a hardcoded wrong
  // number) makes the `srcModule: 6` assertion below fail -- this was
  // physically performed once during this task (see the task report) and
  // reverted, not merely reasoned about.
  it("creating a link to a defect posts srcModule 6, the defect's module/id, and the release's HUMAN id as sourceId", async () => {
    mockGetWCDefectList.mockResolvedValue([{ defectId: 'DEF-9', summary: 'Login crashes' }]);
    renderDetail();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Links' }));
    await screen.findByText('Linked Issues');

    fireEvent.mouseDown(screen.getByLabelText('Issue type'));
    fireEvent.click(await screen.findByRole('option', { name: 'Defects' }));

    fireEvent.change(screen.getByLabelText('Search issue'), { target: { value: 'login' } });
    await waitFor(() => expect(mockGetWCDefectList).toHaveBeenCalledWith('login'));
    fireEvent.click(await screen.findByRole('option', { name: /DEF-9.*Login crashes/ }));

    fireEvent.mouseDown(screen.getByLabelText('Link type'));
    fireEvent.click(await screen.findByRole('option', { name: 'relates-to' }));

    fireEvent.click(screen.getByRole('button', { name: /^link$/i }));

    await waitFor(() => expect(mockCreateLink).toHaveBeenCalled());
    // The FORWARD write: release (module 6, human id REL-1) -> defect
    // (module 5, DEF-9). linkissue.tsx's own linkIssuesHandle fires this
    // one first.
    expect(mockCreateLink).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sourceId: 'REL-1',
        destinationId: 'DEF-9',
        srcModule: 6,
        destinationModule: 5,
      }),
    );
  });

  // Premise 3 of this WP's plan, asserted rather than assumed: a link
  // created from the release's own Links tab must be readable from the
  // defect's own Links tab. Reading the real linkIssueService code and data
  // (srckube-linkissue.linkissues, 21 seeded links) during this task showed
  // the actual mechanism is NOT a backend $or match on {sourceId,
  // destinationId} -- getLinks (routes/linkIssue.js) is a plain
  // advancedResults(LinkIssue) equality filter with no $or anywhere in this
  // service. Every seeded pair (e.g. Bug-1->TC-1 alongside a separate
  // TC-1->Bug-1 document) exists as TWO stored documents, because
  // linkissue.tsx's own linkIssuesHandle fires createLink twice -- forward
  // then reverse -- on every Link click. This in-memory store mimics that
  // same exact-match-only filter, so this test actually exercises the real
  // double-write mechanism instead of a backend feature that doesn't exist.
  it("a link created from the release is visible from the defect's own Links tab", async () => {
    const store: Array<Record<string, unknown>> = [];
    mockCreateLink.mockImplementation(async (payload: Record<string, unknown>) => {
      // `id` (a plain incrementing number, distinct from Mongo `_id`) is
      // what the real linkIssueService stores on every document (verified
      // against real seeded links, e.g. `{ id: 1, linkId: 'link-1', ... }`)
      // and what @mui/x-data-grid's default row-id resolution reads --
      // omitting it here reproduces nothing about the real system, it only
      // breaks the grid.
      const doc = { _id: `link-${store.length + 1}`, id: store.length + 1, ...payload };
      store.push(doc);
      return doc;
    });
    mockGetLinkedIssuesApi.mockImplementation(async (qs: string) => {
      const id = qs.replace('sourceId=', '');
      return store.filter((d) => d.sourceId === id);
    });
    mockGetWCDefectList.mockResolvedValue([{ defectId: 'DEF-9', summary: 'Login crashes' }]);

    renderDetail();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Links' }));
    await screen.findByText('Linked Issues');

    fireEvent.mouseDown(screen.getByLabelText('Issue type'));
    fireEvent.click(await screen.findByRole('option', { name: 'Defects' }));

    fireEvent.change(screen.getByLabelText('Search issue'), { target: { value: 'login' } });
    await waitFor(() => expect(mockGetWCDefectList).toHaveBeenCalledWith('login'));
    fireEvent.click(await screen.findByRole('option', { name: /DEF-9.*Login crashes/ }));

    fireEvent.mouseDown(screen.getByLabelText('Link type'));
    fireEvent.click(await screen.findByRole('option', { name: 'relates-to' }));

    fireEvent.click(screen.getByRole('button', { name: /^link$/i }));
    await waitFor(() => expect(mockCreateLink).toHaveBeenCalledTimes(2));

    // The REVERSE write landed in the store as module-5-sourced.
    expect(store).toContainEqual(
      expect.objectContaining({ sourceId: 'DEF-9', destinationId: 'REL-1', srcModule: 5, destinationModule: 6 }),
    );

    // Now mount the DEFECT's own Links tab directly (LinksSection,
    // srcModule=5, issueId='DEF-9') against the SAME store, and confirm it
    // reads back the release -- the bidirectionality this whole task exists
    // to prove.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LinksSection srcModule={5} issueId="DEF-9" summary="Login crashes" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/REL-1/)).toBeInTheDocument();
    expect(mockGetLinkedIssuesApi).toHaveBeenCalledWith('sourceId=DEF-9');
  });
});

// Fix round (final review) -- TEST_CASE_STATUS_COLORS' own comment used to
// claim its vocabulary was "sourced from TestRunDetail.tsx's own
// STATUS_KEYS" while STATUS_KEYS stayed module-private there: a comment,
// not a dependency. STATUS_KEYS is now exported and TEST_CASE_STATUS_COLORS'
// key type is derived from it directly, which already makes a missing
// colour a `tsc` error -- this is the runtime half of that guard, exactly
// as this package's own non-vacuity discipline requires (a compile-time-only
// guard on a file nobody re-runs `tsc` against on every change is not
// enough on its own).
describe('ReleaseDetail — Lens status colours stay bound to TestRunDetail.tsx (fix round, final review)', () => {
  // BREAKS IF: TestRunDetail.tsx's STATUS_KEYS gains a status (e.g. a
  // future 'Retest') that TEST_CASE_STATUS_COLORS is not also updated for
  // -- this test iterates the REAL, live STATUS_KEYS array (not a copy) and
  // fails the moment one of its members has no explicit colour entry,
  // instead of that gap only surfacing as a silent default-grey chip on
  // the release Lens tab the next time someone opens it.
  it('has an explicit colour entry for every status TestRunDetail.tsx actually reports', () => {
    const missing = STATUS_KEYS.filter((status) => !(status in TEST_CASE_STATUS_COLORS));
    expect(missing).toEqual([]);
  });
});
