import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { WorkbenchStoreProvider } from '../../../workbench/WorkbenchStoreProvider';
import { CaseTemplatePicker } from '../CaseTemplatePicker';
import { CaseTemplate, listCaseTemplates } from '../../../api/caseTemplateApi';
import { usePermissions } from '../../../Hooks/usePermissions';

// setupTests.ts extends `expect` with jest-axe's toHaveNoViolations()
// globally -- no local expect.extend() needed here.
//
// WP-F08 Task 2 -- axe coverage for the "start from template" picker,
// following SharedStepPicker.a11y.test.tsx's own convention exactly: this
// project shipped a vacuous a11y suite once (WP-F05, axe run over a shell
// that never mounted its real interactive element, which still passed
// review). Every test below either IS the non-vacuity guard, or runs axe
// only after first proving (via screen.find*) that the real controls --
// the search field, the row's Use button -- are actually in the DOM.
//
// No requireActual on caseTemplateApi -- same reason as sharedStepApi's
// own header comment: it would run the real module, which imports
// axios.tsx -> src/keycloak.js -> the ESM-only `keycloak-js` package,
// which Jest's default transform cannot parse.
jest.mock('../../../api/caseTemplateApi', () => ({
  listCaseTemplates: jest.fn(),
  deleteCaseTemplate: jest.fn(),
}));
jest.mock('../../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: jest.fn(),
  default: jest.fn(),
}));

const mockListCaseTemplates = listCaseTemplates as jest.Mock;
const mockUsePermissions = usePermissions as unknown as jest.Mock;

const TEMPLATES: CaseTemplate[] = [
  {
    _id: 'ct1',
    id: 1,
    CaseTemplateId: 'CT-1',
    projectId: 7,
    moduleId: 1,
    name: 'Regression — login flow',
    description: 'Standard login regression',
    prefill: { TestCaseSummary: 'Login should work' },
  },
];

function renderPicker() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <WorkbenchStoreProvider projectId={7}>
          <CaseTemplatePicker projectId={7} module={1} open onClose={jest.fn()} />
        </WorkbenchStoreProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUsePermissions.mockReturnValue({ role: 'contributor', isLoading: false, isError: false, can: () => true });
  mockListCaseTemplates.mockResolvedValue(TEMPLATES);
});

// THE non-vacuity guard: fails if the search field, the row's Use
// control, or the row's Delete control is ever removed, renamed past
// these queries, or fails to mount (e.g. gated behind a permission check
// that silently defaults closed). A failure here means the axe assertions
// below it were about to run against a dialog that never actually opened
// its real controls.
test('non-vacuity guard: the picker actually mounts its search field, Use control, and Delete control', async () => {
  renderPicker();
  expect(await screen.findByLabelText(/search templates/i)).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /^use$/i })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /delete regression — login flow/i })).toBeInTheDocument();
});

test('the open picker, with results and mounted Use/Delete controls, is axe-clean', async () => {
  const { container } = renderPicker();
  expect(await screen.findByRole('button', { name: /^use$/i })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /delete regression — login flow/i })).toBeInTheDocument();
  expect(await axe(container)).toHaveNoViolations();
});

test('the empty-library state is axe-clean', async () => {
  mockListCaseTemplates.mockResolvedValue([]);
  const { container } = renderPicker();
  expect(await screen.findByText(/no templates exist yet/i)).toBeInTheDocument();
  expect(await axe(container)).toHaveNoViolations();
});

test('the delete confirmation dialog is axe-clean', async () => {
  const { container } = renderPicker();
  const deleteButton = await screen.findByRole('button', { name: /delete regression — login flow/i });
  fireEvent.click(deleteButton);
  expect(await screen.findByRole('dialog', { name: /delete regression — login flow/i })).toBeInTheDocument();

  expect(await axe(container)).toHaveNoViolations();
});
