import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { SharedStepManagerDialog } from '../SharedStepManagerDialog';
import { SharedStep, listSharedSteps } from '../../../api/sharedStepApi';
import usePermissions from '../../../Hooks/usePermissions';

// setupTests.ts extends `expect` with jest-axe's toHaveNoViolations()
// globally -- no local expect.extend() needed here.
//
// WP-F06 Task 5 -- axe coverage for the shared-step library's CRUD
// dialog, following FieldsPanel.a11y.test.tsx's own split of functional
// vs a11y assertions into separate files, and its "table view / empty
// state / create dialog / delete confirmation" coverage shape.
//
// Same lesson as SharedStepPicker.a11y.test.tsx's header comment: WP-F05's
// own a11y suite went vacuous by running axe over a dialog that never
// mounted its real interactive element. Every axe assertion below is
// preceded by a screen.find* proving the actual control under test (New
// shared step / Edit / Delete / the Steps editor) is in the DOM first --
// and the very first test in this file exists solely to make that
// guarantee explicit and independently checkable.
//
// No requireActual on sharedStepApi -- see SharedStepManagerDialog.test.tsx's
// header comment for why: it would run the real module, which imports
// axios.tsx -> src/keycloak.js -> the ESM-only `keycloak-js` package,
// which Jest's default transform cannot parse (confirmed by running
// FieldsPanel.a11y.test.tsx itself in isolation, which fails identically
// for the identical, pre-existing reason).
jest.mock('../../../api/sharedStepApi', () => ({
    listSharedSteps: jest.fn(),
    getSharedStep: jest.fn(),
    createSharedStep: jest.fn(),
    updateSharedStep: jest.fn(),
    deleteSharedStep: jest.fn(),
    getSharedStepUsage: jest.fn()
}));
jest.mock('../../../Hooks/usePermissions', () => ({ __esModule: true, default: jest.fn() }));

const mockListSharedSteps = listSharedSteps as jest.Mock;
const mockUsePermissions = usePermissions as unknown as jest.Mock;

function step(overrides: Partial<SharedStep> = {}): SharedStep {
    return {
        _id: 's1',
        id: 1,
        SharedStepId: 'SS-1',
        projectId: 7,
        title: 'Log in as admin',
        description: 'Standard login',
        steps: [{ testStep: 'Go to login', Expected: 'Login page shown' }],
        ...overrides
    };
}

const STEPS: SharedStep[] = [step()];

function renderManager() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <SharedStepManagerDialog projectId={7} open onClose={jest.fn()} />
            </ThemeProvider>
        </QueryClientProvider>
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockUsePermissions.mockReturnValue({ role: 'admin', isLoading: false, isError: false, can: () => true });
    mockListSharedSteps.mockResolvedValue(STEPS);
});

// THE non-vacuity guard: fails if New/Edit/Delete are ever removed,
// renamed past these queries, or fail to mount (e.g. silently gated
// closed by a permission check). A failure here means the axe assertions
// below it were about to run against controls that were never actually on
// the page.
test('non-vacuity guard: the manager actually mounts New/Edit/Delete controls', async () => {
    renderManager();
    expect(await screen.findByRole('button', { name: /new shared step/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /edit log in as admin/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /delete log in as admin/i })).toBeInTheDocument();
});

test('the list view (with data and a mounted New button) is axe-clean', async () => {
    const { container } = renderManager();
    expect(await screen.findByRole('button', { name: /new shared step/i })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});

test('the empty-library state is axe-clean', async () => {
    mockListSharedSteps.mockResolvedValue([]);
    const { container } = renderManager();
    expect(await screen.findByText(/no shared steps defined/i)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});

test('the create dialog, with its Steps editor mounted, is axe-clean', async () => {
    const { container } = renderManager();
    expect(await screen.findByRole('button', { name: /new shared step/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /new shared step/i }));
    const dialog = screen.getByRole('dialog', { name: /new shared step/i });
    expect(within(dialog).getByLabelText(/^step 1$/i)).toBeInTheDocument();

    expect(await axe(container)).toHaveNoViolations();
});

test('the delete confirmation dialog is axe-clean', async () => {
    const { container } = renderManager();
    expect(await screen.findByRole('button', { name: /delete log in as admin/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /delete log in as admin/i }));
    expect(await screen.findByRole('dialog', { name: /delete log in as admin/i })).toBeInTheDocument();

    expect(await axe(container)).toHaveNoViolations();
});
