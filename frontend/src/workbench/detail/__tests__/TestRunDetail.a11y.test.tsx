import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { TestRunDetail } from '../modules/TestRunDetail';
import { WorkbenchStoreProvider } from '../../WorkbenchStoreProvider';
import {
  getTestExecutionList,
  getTeTestCaseDetails,
  getFields,
  getCreatedBy,
  getComments,
} from '../../../api/apiCalls';

// WP-076 — ported from the deleted
// Components/Tabs/__tests__/TestExecutionContent.a11y.test.tsx (component-
// level suite for the execution screen's own content) now that
// TestExecutionContent.tsx's real successor is TestRunDetail (module 4,
// workbench/detail/modules/TestRunDetail.tsx), mounted by EntityDetail.tsx
// rather than TabContent.tsx/Pages/testExecution.tsx. Both distinct
// assertions from that file are carried forward: axe-clean before any test
// case is selected, and the assigned-to/per-status counts rendered as real
// text rather than color alone (status-count-* data-testid grid, same
// requirement, same STATUS_KEYS vocabulary).
//
// Unlike the deleted file, there is no tree to mock here: TestExecutionContent
// composed its own real tree (GmailTreeView1, folderList/folderStructure.tsx)
// alongside the details pane, which needed a @minoru/react-dnd-treeview mock
// for the same ESM-can't-be-transformed reason documented across this
// codebase's other a11y suites. TestRunDetail's own "Test Cases" list
// (this file's ex-tree) is a plain MUI <List>/<ListItemButton> -- no tree,
// no DnD, nothing to mock. The one thing genuinely new here that the deleted
// file's assertions never had to cover is CommentsSection, always mounted
// (see TestRunDetail.tsx); getComments is stubbed to an empty resolved list
// so it renders its own real, already-covered-elsewhere "No comments yet"
// state rather than either hanging or throwing.
//
// AttachemntListComp is exercised the same way the deleted file's own header
// comment described (real component, empty attachmentList) -- it is not
// separately mocked here either, and its own accessible name/keyboard
// reachability stays independently covered by attachments.a11y.test.tsx.

jest.mock('../../../api/apiCalls', () => ({
  getTestExecutionList: jest.fn(),
  getTeTestCaseDetails: jest.fn(),
  getFields: jest.fn(),
  updateTestSteps: jest.fn(),
  updateAttachment: jest.fn(),
  uploadAttachment: jest.fn(),
  getCreatedBy: jest.fn(),
  getComments: jest.fn(),
}));

jest.mock('../../../keycloak', () => ({
  __esModule: true,
  default: {
    tokenParsed: { sub: 'user-abc', preferred_username: 'alice', name: 'Alice' },
    authenticated: true,
  },
}));

const mockGetTestExecutionList = getTestExecutionList as jest.Mock;
const mockGetTeTestCaseDetails = getTeTestCaseDetails as jest.Mock;
const mockGetFields = getFields as jest.Mock;
const mockGetCreatedBy = getCreatedBy as jest.Mock;
const mockGetComments = getComments as jest.Mock;

const STEP_STATUSES = ['No Run', 'InProgress', 'Pass', 'Fail', 'Blocked'];

// Shape verified live via the mongodb MCP tool against
// srckube-testexecution.testexecutions (same fixture TestRunDetail.test.tsx
// uses): TestCases[].TestStatus is the rolled-up status.
const RUN_RECORD = {
  _id: 'exec-mongo-1',
  TestExecutionId: 'Run-1',
  assignedTo: 'user-1',
  TestCases: [{ TestCaseId: 'TC-1', TestCaseSummary: 'Login works', TestStatus: 'No Run' }],
};

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    // A6's "Raise defect" calls useNavigate() -- see TestRunDetail.tsx's
    // own comment on that call. Needs a Router in the tree now, same as
    // TestRunDetail.test.tsx's own MemoryRouter wrap.
    <MemoryRouter initialEntries={['/projects/1/workbench/testruns']}>
      <QueryClientProvider client={client}>
        <ThemeProvider theme={theme}>
          <WorkbenchStoreProvider projectId={1}>
            <TestRunDetail entityId="Run-1" />
          </WorkbenchStoreProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTestExecutionList.mockResolvedValue([RUN_RECORD]);
  mockGetTeTestCaseDetails.mockResolvedValue([]);
  mockGetFields.mockResolvedValue([{ fieldName: 'Step Status', defaultValue: STEP_STATUSES }]);
  mockGetCreatedBy.mockResolvedValue('Alice');
  mockGetComments.mockResolvedValue([]);
});

describe('TestRunDetail (WP-076, ported from TestExecutionContent.a11y.test.tsx) — the execution screen target page', () => {
  it('is axe clean before any test case is selected (header + counts panel only)', async () => {
    const { container } = renderDetail();
    await screen.findByText(/Assigned To/);
    await screen.findByText(/No comments yet/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows the assigned-to and per-status counts as real text (not color alone)', async () => {
    renderDetail();
    await screen.findByText(/Assigned To : Alice/);
    // Scoped to the status-count grid (Grid item data-testid="status-count-*"
    // in TestRunDetail.tsx): the same status word can also appear as the
    // per-test-case StatusChip label in the list beside it, so an unscoped
    // getByText would be ambiguous.
    expect(screen.getByTestId('status-count-No Run')).toHaveTextContent('No Run');
    expect(screen.getByTestId('status-count-Pass')).toHaveTextContent('Pass');
    expect(screen.getByTestId('status-count-Fail')).toHaveTextContent('Fail');
    expect(screen.getByTestId('status-count-Blocked')).toHaveTextContent('Blocked');
  });
});
