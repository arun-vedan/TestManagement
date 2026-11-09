import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { SharedStepPicker } from '../SharedStepPicker';
import { SharedStep, listSharedSteps } from '../../../api/sharedStepApi';
import usePermissions from '../../../Hooks/usePermissions';

// setupTests.ts extends `expect` with jest-axe's toHaveNoViolations()
// globally -- no local expect.extend() needed here.
//
// WP-F06 Task 5 -- axe coverage for the shared-step picker, following this
// repo's *.a11y.test.tsx convention (see e.g. FieldsPanel.a11y.test.tsx).
//
// This is the exact lesson this WP was told to carry forward: WP-F05's own
// a11y suite went vacuous because its fixture never mounted the
// interactive element it claimed to test, so it passed while exercising
// none of the changed markup. Every test below either IS the non-vacuity
// guard, or runs axe only after first proving (via screen.find*) that the
// dialog's real interactive controls -- the search field, the Insert
// buttons -- are actually in the DOM, not just that some inert shell
// rendered clean.
//
// No requireActual on sharedStepApi here, for the same reason
// SharedStepPicker.test.tsx's own header comment explains: it would run
// the real module, which imports axios.tsx -> src/keycloak.js -> the
// ESM-only `keycloak-js` package, which Jest's default transform cannot
// parse. Confirmed by running FieldsPanel.a11y.test.tsx itself in
// isolation, which fails identically for the identical, pre-existing
// reason.
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

const STEPS: SharedStep[] = [
    {
        _id: 's1',
        id: 1,
        SharedStepId: 'SS-1',
        projectId: 7,
        title: 'Log in as admin',
        description: 'Standard login flow',
        steps: [{ testStep: 'Go to login', Expected: 'Login page shown' }]
    }
];

function renderPicker() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <SharedStepPicker projectId={7} open onClose={jest.fn()} onInsert={jest.fn()} />
            </ThemeProvider>
        </QueryClientProvider>
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockUsePermissions.mockReturnValue({ role: 'contributor', isLoading: false, isError: false, can: () => true });
    mockListSharedSteps.mockResolvedValue(STEPS);
});

// THE non-vacuity guard: fails if the search field or the row's Insert
// button is ever removed, renamed past these queries, or fails to mount
// (e.g. gated behind a permission check that silently defaults closed).
// A failure here means the axe assertions below it were about to run
// against a dialog that never actually opened its real controls.
test('non-vacuity guard: the picker actually mounts its search field and insert control', async () => {
    renderPicker();
    expect(await screen.findByLabelText(/search shared steps/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^insert$/i })).toBeInTheDocument();
});

test('the open picker, with results and a mounted insert control, is axe-clean', async () => {
    const { container } = renderPicker();
    expect(await screen.findByRole('button', { name: /^insert$/i })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});

test('the empty-library state is axe-clean', async () => {
    mockListSharedSteps.mockResolvedValue([]);
    const { container } = renderPicker();
    expect(await screen.findByText(/no shared steps exist/i)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});
