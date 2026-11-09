import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, createTheme } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { expectNoUnexpectedAxeViolations } from '../../../testUtils/a11y';
import { ReleaseDetail } from '../modules/ReleaseDetail';
import { WorkbenchStoreProvider } from '../../WorkbenchStoreProvider';
import { getRelease, deleteRelease, linkTestPlan, unlinkTestPlan, getGateStatus } from '../../../api/releaseApi';
import { getTestPlanList, getFields, getComments } from '../../../api/apiCalls';
import { getReleaseLens } from '../../../api/reportApi';

// WP-F15/F18 Task 2 -- ReleaseDetail's own a11y suite, module 6. Same
// jest.mock-the-api-module pattern (not jest.requireActual) as every other
// detail module's own a11y suite (DefectDetail.a11y.test.tsx/
// TestRunDetail.a11y.test.tsx) -- SharedStepManagerDialog.test.tsx documents
// this as the pattern that avoids the keycloak-js ESM-import failure a few
// suites in this repo still hit unmocked (attachments.a11y.test.tsx/
// FieldGrid.editor.test.tsx).
//
// NON-VACUITY: an axe pass over a component that rendered nothing -- or
// that silently dropped its interactive controls -- proves nothing (this
// project has shipped exactly that once). Every test below asserts the
// specific interactive controls this file's own write-path tests
// (ReleaseDetail.test.tsx) exercise are ACTUALLY MOUNTED before handing the
// container to axe: the Name field as a real enabled textbox, the Unlink
// icon button on the one linked test plan, the "link another plan" picker
// + button, and (WP-F18b Task 3) the Delete button and its confirmation
// dialog's own controls. If any of those got dropped -- accidentally
// rendered behind a condition that never opens, or never mounted at all --
// these `getByRole`/`getByLabelText` calls fail on their own, before axe
// ever runs, rather than the suite passing vacuously over an empty tree.
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

jest.mock('../../../api/apiCalls', () => ({
  getTestPlanList: jest.fn(),
  // WP-F24 Task 1 -- getFields(6), the Details tab's configured field
  // definitions.
  getFields: jest.fn(),
  getComments: jest.fn(),
}));

// WP-F15b Task 2 -- the Lens tab's derived-membership markup (the "Derived"
// chip + its `via` caption) gets its own axe pass here. `reportErrorMessage`
// is a pure string helper (no network), kept via requireActual, same split
// ReleaseDetail.test.tsx's own reportApi mock uses.
jest.mock('../../../api/reportApi', () => ({
  ...jest.requireActual('../../../api/reportApi'),
  getReleaseLens: jest.fn(),
}));

jest.mock('../../../keycloak', () => ({
  __esModule: true,
  default: {
    tokenParsed: { sub: 'user-abc', preferred_username: 'alice', name: 'Alice' },
    authenticated: true,
  },
}));

// This suite renders the editable form (Link/Unlink controls present), so
// it runs as a contributor -- same convention DefectDetail.a11y.test.tsx's
// own header comment documents.
jest.mock('../../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: () => ({ can: () => true, role: 'contributor', isLoading: false, isError: false }),
  default: () => ({ can: () => true, role: 'contributor', isLoading: false, isError: false }),
}));

const mockGetRelease = getRelease as jest.Mock;
const mockDeleteRelease = deleteRelease as jest.Mock;
const mockLinkTestPlan = linkTestPlan as jest.Mock;
const mockUnlinkTestPlan = unlinkTestPlan as jest.Mock;
const mockGetGateStatus = getGateStatus as jest.Mock;
const mockGetTestPlanList = getTestPlanList as jest.Mock;
const mockGetFields = getFields as jest.Mock;
const mockGetComments = getComments as jest.Mock;
const mockGetReleaseLens = getReleaseLens as jest.Mock;

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

// WP-F15b Task 2 -- one explicit and one derived member per section, so the
// axe pass genuinely covers the "Derived" chip and its `via` caption (a
// lens with only explicit links would leave that markup unrendered and this
// suite would pass vacuously over an empty derived section).
const LENS_ENVELOPE = {
  success: true,
  projectId: 1,
  releaseId: 'REL-1',
  computedAt: '2026-01-05T00:00:00.000Z',
  data: {
    release: { releaseId: 'REL-1', name: 'Spring Launch', status: 'planned', targetDate: '2026-12-01T00:00:00.000Z' },
    links: { rawLinkRowsSeen: 2, distinctCounterparts: 1, resolvedCount: 1, unresolvedCount: 0, ignoredOtherModuleCount: 0 },
    requirements: {
      linkedCount: 1,
      linked: [{ reqId: 'REQ-1', requirementSummary: 'Login must work' }],
      derivedCount: 1,
      derived: [{ reqId: 'REQ-9', requirementSummary: 'Derived requirement', via: [{ TestCaseId: 'TC-5', TestCaseSummary: 'Login case' }] }],
    },
    testCases: {
      linkedCount: 0,
      linked: [],
      derivedCount: 1,
      derived: [{ TestCaseId: 'TC-5', TestCaseSummary: 'Login case', via: [{ _id: 'plan-mongo-1', TestPlanId: 'PLN-1' }], latestStatus: 'Not run in this release' }],
    },
    defects: { linkedCount: 0, byStatus: { categories: [], series: [] }, linked: [] },
    testPlans: { configuredCount: 1, linkedCount: 1, unresolvedCount: 0, linked: [{ _id: 'plan-mongo-1', TestPlanId: 'PLN-1' }] },
    executions: { executed: 0, passed: 0, failed: 0, blocked: 0, passRatePercent: null, note: 'no executed test cases found in this release\'s linked test plans' },
  },
};

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider theme={theme}>
        <WorkbenchStoreProvider projectId={1}>
          <ReleaseDetail entityId="release-mongo-1" />
        </WorkbenchStoreProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

// WP-F23 Task 1 -- the Lens tab's Requirements/Test cases groups now render
// @mui/x-data-grid. MUI X DataGrid's column virtualization, given jsdom's
// zero client width, mounts only a LEADING WINDOW of columns (same issue
// EntityList.test.tsx's own `testTheme` documents and fixes) -- without
// this override, the "Membership"/"Derived via" columns (never first) would
// never mount, and an axe pass over them would prove nothing. Test-only:
// production keeps virtualization, ReleaseDetail.tsx never sets this prop.
const gridA11yTheme = createTheme(theme, {
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

function renderDetailForLens() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider theme={gridA11yTheme}>
        <WorkbenchStoreProvider projectId={1}>
          <ReleaseDetail entityId="release-mongo-1" />
        </WorkbenchStoreProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRelease.mockResolvedValue(RELEASE_RECORD);
  mockDeleteRelease.mockResolvedValue(undefined);
  mockLinkTestPlan.mockResolvedValue(RELEASE_RECORD);
  mockUnlinkTestPlan.mockResolvedValue(RELEASE_RECORD);
  mockGetGateStatus.mockResolvedValue(GATE_STATUS);
  mockGetTestPlanList.mockResolvedValue(TEST_PLANS);
  // WP-F24 Task 1 -- default: no module-6 field definitions configured,
  // the 621-project case. Overridden below in the one test that needs a
  // configured field genuinely mounted for its own axe pass.
  mockGetFields.mockResolvedValue([]);
  mockGetComments.mockResolvedValue([]);
  mockGetReleaseLens.mockResolvedValue(LENS_ENVELOPE);
});

describe('ReleaseDetail (WP-F15/F18 Task 2)', () => {
  it('is axe clean on the Details tab, with the Name field and the Delete control genuinely mounted', async () => {
    const { container } = renderDetail();
    await screen.findByText(/REL-1/);
    await screen.findByText(/No comments yet/);

    // Non-vacuity guard: this is a real, enabled control -- not a disabled
    // placeholder and not simply absent.
    const nameField = screen.getByLabelText('Name', { exact: false });
    expect(nameField).toBeEnabled();
    expect(nameField).toHaveValue('Spring Launch');

    // WP-F18b Task 3 -- this suite runs as a contributor with can() -> true
    // for every action (line 58 below), so the Delete button (gated on
    // can('delete')) is genuinely part of what this axe pass covers, not
    // rendered-then-hidden.
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeEnabled();

    expect(await axe(container)).toHaveNoViolations();
  });

  // WP-F24 Task 1 -- a configured module-6 field (getFields(6)), genuinely
  // mounted alongside the built-ins, gets its own axe pass. Mount-guard,
  // per this file's own header comment: a React first mount renders every
  // child regardless of whether the merge behind it is correct, so this
  // asserts the Priority control is a real, enabled, LABELLED textbox (not
  // merely present) -- an unlabelled control would still mount on a first
  // render but would fail axe on its own, which is the point of testing it
  // this way rather than only checking `toBeInTheDocument()`.
  it('is axe clean on the Details tab with a configured field mounted alongside the built-ins', async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'priority', displayName: 'Priority', fieldType: 'Text', isDisplayed: true, isMandatory: false },
    ]);
    const { container } = renderDetail();
    await screen.findByText(/REL-1/);

    const nameField = screen.getByLabelText('Name', { exact: false });
    expect(nameField).toBeEnabled();
    expect(nameField).toHaveValue('Spring Launch');

    const priorityField = await screen.findByLabelText('Priority');
    expect(priorityField).toBeEnabled();

    expect(await axe(container)).toHaveNoViolations();
  });

  // WP-F24 Task 1 (fix round 2) -- the R2 warning for a configured field
  // that collides with a reserved Release attribute FieldGrid has no
  // control for (targetDate/linkedTestPlanIds/etc). Mount-guard: the
  // warning is asserted genuinely present and naming the field BEFORE
  // axe runs, not merely "axe passed over whatever rendered" -- an Alert
  // that failed to render at all would still pass axe vacuously.
  it('is axe clean on the Details tab with a reserved-name collision warning genuinely mounted', async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'targetDate', displayName: 'Custom Target Date', fieldType: 'Text', isDisplayed: true, isMandatory: false },
    ]);
    const { container } = renderDetail();
    await screen.findByText(/REL-1/);

    const warning = await screen.findByTestId('release-ignored-reserved-fields');
    expect(warning).toHaveTextContent('targetDate');
    // The real control is still there, unshadowed and unduplicated.
    expect(screen.queryByLabelText('Custom Target Date')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Target Date')).toBeEnabled();

    expect(await axe(container)).toHaveNoViolations();
  });

  // WP-F18b Task 3 -- the confirmation dialog Delete opens. Asserted with
  // the dialog actually OPEN (not just the trigger button present) so this
  // axe pass covers the dialog's own controls (its Cancel/Delete buttons,
  // its DialogContentText naming the release) -- an unopened dialog would
  // pass axe vacuously, the exact failure mode this file's own header
  // comment warns about.
  it('is axe clean on the Delete confirmation dialog, with its Cancel/Delete controls genuinely mounted', async () => {
    const { container } = renderDetail();
    await screen.findByText(/REL-1/);

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete rel-1/i });

    // Non-vacuity guard: the dialog names the release and offers a real
    // way back out, not just a bare "Delete" confirm with no context.
    expect(dialog).toHaveTextContent(/spring launch/i);
    expect(dialog).toHaveTextContent(/cannot be undone/i);
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeEnabled();

    expect(await axe(container)).toHaveNoViolations();
    expect(mockDeleteRelease).not.toHaveBeenCalled();
  });

  // WP-F18b Task 2 -- the gate editor added beside the gate status. Same
  // non-vacuity discipline as this suite's other tests: the Threshold
  // field, Add rule, and Save gates controls are asserted ENABLED and
  // PRESENT (not merely that axe passed over whatever happened to render)
  // before the container is handed to axe.
  it('is axe clean on the Quality Gates tab, with the gate editor controls genuinely mounted', async () => {
    const { container } = renderDetail();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Quality Gates' }));
    // "minPassRate" genuinely appears twice once the editor is mounted --
    // once as the results table's rule name, once as the editor's own Type
    // select value -- so this waits on the table specifically rather than
    // the (now ambiguous) bare text.
    await screen.findByRole('table');

    const thresholdField = screen.getByLabelText('Threshold');
    expect(thresholdField).toBeEnabled();
    expect(thresholdField).toHaveValue(80);
    expect(screen.getByRole('button', { name: /add rule/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /save gates/i })).toBeEnabled();

    expect(await axe(container)).toHaveNoViolations();
  });

  it('is axe clean on the Linked Test Plans tab, with the Unlink and Link controls genuinely mounted', async () => {
    const { container } = renderDetail();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Linked Test Plans' }));
    await screen.findByText('PLN-1');

    // Non-vacuity guard: these are the exact controls
    // ReleaseDetail.test.tsx's own link/unlink tests drive -- asserting
    // they exist here proves this axe pass covers the real interactive
    // surface, not an empty or collapsed panel.
    expect(screen.getByRole('button', { name: /unlink pln-1/i })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Test plan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^link$/i })).toBeInTheDocument();

    expect(await axe(container)).toHaveNoViolations();
  });

  // WP-F15b Task 2 -- the Lens tab's derived-membership markup. Non-vacuity
  // guard: the derived requirement/test case rows, their "Derived" chip,
  // and their `via` caption are all asserted PRESENT (with the explicit
  // rows they sit beside) before the container is handed to axe -- an axe
  // pass over a Lens tab that happened to render only its empty state, or
  // that dropped the derived rows behind a condition that never opens,
  // would prove nothing about this markup's accessibility.
  it('is axe clean on the Lens tab, with derived and explicit rows genuinely mounted side by side', async () => {
    const { container } = renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));

    // WP-F23 Task 1, R1 -- both groups start collapsed; their own toggle
    // buttons are asserted PRESENT and genuinely mounted (with the correct
    // aria-expanded state) before being opened, same non-vacuity discipline
    // this file's header comment describes for every other tab.
    const requirementsToggle = await screen.findByRole('button', { name: /toggle requirements/i });
    expect(requirementsToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(requirementsToggle);

    const testCasesToggle = screen.getByRole('button', { name: /toggle test cases/i });
    expect(testCasesToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(testCasesToggle);

    await screen.findByTestId('lens-requirements-grid');
    await screen.findByTestId('lens-test-cases-grid');

    const linkedReqRow = getGridRowById(container, 'REQ-1');
    expect(linkedReqRow).toHaveTextContent('REQ-1');
    expect(within(linkedReqRow).getByTestId('lens-asserted-chip')).toHaveTextContent('Asserted');

    const derivedReqRow = getGridRowById(container, 'REQ-9');
    expect(derivedReqRow).toHaveTextContent('REQ-9');
    expect(within(derivedReqRow).getByTestId('lens-derived-chip')).toHaveTextContent('Derived');
    expect(within(derivedReqRow).getByTestId('lens-requirement-derived-via')).toHaveTextContent('via TC-5');

    const derivedCaseRow = getGridRowById(container, 'TC-5');
    expect(derivedCaseRow).toHaveTextContent('TC-5');
    expect(within(derivedCaseRow).getByTestId('lens-derived-chip')).toHaveTextContent('Derived');
    expect(within(derivedCaseRow).getByTestId('lens-testcase-derived-via')).toHaveTextContent('via PLN-1');

    // Same accepted DataGrid exception as EntityList.a11y.test.tsx's own
    // (testUtils/a11y.ts's header comment) -- @mui/x-data-grid@6.20.4 renders
    // its pagination footer as a direct child of role="grid", which axe's
    // aria-required-children rule flags on every DataGrid in this app,
    // unrelated to anything added by this task. Every OTHER violation still
    // fails this test.
    expectNoUnexpectedAxeViolations(await axe(container));
  });

  // WP-F23 Task 1 -- the collapse toggle and the DataGrid it reveals both
  // have real a11y requirements of their own (the toggle's aria-expanded
  // state; the grid's quick-filter search box). Non-vacuity: asserting the
  // toggle's aria-expanded flips, and the quick-filter input is a genuine,
  // labelled textbox, before handing the container to axe -- an axe pass
  // over a toggle that never actually opens (or a quick filter rendered
  // with no accessible name) would prove nothing about either.
  it('is axe clean on an expanded Lens group, with the collapse toggle and the grid quick filter genuinely mounted', async () => {
    const { container } = renderDetailForLens();
    await screen.findByText(/REL-1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Lens' }));

    const toggle = await screen.findByRole('button', { name: /toggle requirements/i });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const grid = await screen.findByTestId('lens-requirements-grid');
    // A quick-filter search input is `type="search"`, whose implicit ARIA
    // role is `searchbox`, not the generic `textbox`.
    const quickFilter = within(screen.getByTestId('lens-requirements-quickfilter')).getByRole('searchbox');
    expect(quickFilter).toBeEnabled();
    expect(grid).toBeInTheDocument();

    expectNoUnexpectedAxeViolations(await axe(container));
  });
});
