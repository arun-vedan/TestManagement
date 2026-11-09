import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { SaveAsTemplateDialog } from '../SaveAsTemplateDialog';
import { createCaseTemplate } from '../../../api/caseTemplateApi';

// setupTests.ts extends `expect` with jest-axe's toHaveNoViolations()
// globally -- no local expect.extend() needed here.
//
// WP-F08 Task 2 -- axe coverage for "Save as template", following
// SharedStepManagerDialog.a11y.test.tsx's own convention: every test below
// either IS the non-vacuity guard, or runs axe only after first proving
// (via screen.find*/getByLabelText) that the dialog's real interactive
// controls -- the name/description fields, Save -- are actually mounted,
// not just that some inert shell rendered clean. This project shipped a
// vacuous a11y suite once (axe over a dialog that never opened), and it
// passed review the first time.
//
// No requireActual on caseTemplateApi -- it would run the real module,
// which imports axios.tsx -> src/keycloak.js -> the ESM-only
// `keycloak-js` package, which Jest's default transform cannot parse.
jest.mock('../../../api/caseTemplateApi', () => ({
  createCaseTemplate: jest.fn(),
}));

const mockCreateCaseTemplate = createCaseTemplate as jest.Mock;

const RECORD = {
  _id: 'abc123',
  TestCaseId: 'TC-1',
  TestCaseSummary: 'Login should work',
  TestSteps: [{ testStep: 'Log in as admin', Expected: 'Dashboard shown' }],
};

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <SaveAsTemplateDialog projectId={7} module={1} open onClose={jest.fn()} record={RECORD} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateCaseTemplate.mockResolvedValue({ _id: 'ct1', CaseTemplateId: 'CT-1' });
});

// THE non-vacuity guard: fails if the name/description fields or the
// Save/Cancel buttons are ever removed or renamed past these queries. A
// failure here means the axe assertions below it were about to run
// against a dialog that never actually mounted its real form.
test('non-vacuity guard: the dialog actually mounts its name field, description field, and Save control', async () => {
  renderDialog();
  expect(await screen.findByLabelText('Template name')).toBeInTheDocument();
  expect(await screen.findByLabelText('Description')).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /^save$/i })).toBeInTheDocument();
});

test('the open dialog, with its form mounted, is axe-clean', async () => {
  const { container } = renderDialog();
  expect(await screen.findByLabelText('Template name')).toBeInTheDocument();
  expect(await axe(container)).toHaveNoViolations();
});

test('the dialog with a validation error shown is axe-clean', async () => {
  const { container } = renderDialog();
  fireEvent.click(await screen.findByRole('button', { name: /^save$/i }));
  expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
  expect(await axe(container)).toHaveNoViolations();
});
