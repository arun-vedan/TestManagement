import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { SharedStepManagerDialog } from '../SharedStepManagerDialog';
import { SharedStep, createSharedStep, deleteSharedStep, listSharedSteps, updateSharedStep } from '../../../api/sharedStepApi';
import usePermissions from '../../../Hooks/usePermissions';

// WP-F06 Task 5 -- the library's own CRUD surface. Every network call is
// mocked.
//
// Deliberately NOT `{ ...jest.requireActual(...), ... }` the way
// FieldsPanel.test.tsx mocks fieldsApi -- requireActual here would run
// sharedStepApi.ts for real, pulling in axios.tsx -> src/keycloak.js ->
// the `keycloak-js` package, which is ESM-only (package.json: `"type":
// "module"`, one `exports` entry, no CJS build) and unparseable by Jest's
// default transform (node_modules is untransformed by default). Confirmed
// by running FieldsPanel.test.tsx itself in isolation: it fails with the
// identical `SyntaxError: Unexpected token 'export'` for the identical
// reason, unrelated to this WP. sharedStepApi.ts has no non-function/
// non-type export this component needs, so there is nothing requireActual
// would need to preserve -- a plain jest.fn() per named export sidesteps
// the import chain instead of tripping over it.
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
const mockCreateSharedStep = createSharedStep as jest.Mock;
const mockUpdateSharedStep = updateSharedStep as jest.Mock;
const mockDeleteSharedStep = deleteSharedStep as jest.Mock;
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

const STEPS: SharedStep[] = [step(), step({ _id: 's3', id: 3, SharedStepId: 'SS-3', title: 'Checkout flow', steps: [] })];

function renderManager() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = jest.fn();
    const utils = render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <SharedStepManagerDialog projectId={7} open onClose={onClose} />
            </ThemeProvider>
        </QueryClientProvider>
    );
    return { ...utils, onClose };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockUsePermissions.mockReturnValue({ role: 'admin', isLoading: false, isError: false, can: () => true });
    mockListSharedSteps.mockResolvedValue(STEPS);
});

test('lists shared steps from the library', async () => {
    renderManager();
    expect(await screen.findByText(/Log in as admin/)).toBeInTheDocument();
    expect(screen.getByText(/Checkout flow/)).toBeInTheDocument();
});

test('creates a shared step from the dialog', async () => {
    mockCreateSharedStep.mockResolvedValue(step({ _id: 's9', id: 9, SharedStepId: 'SS-9', title: 'New flow' }));
    renderManager();
    expect(await screen.findByText(/Log in as admin/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /new shared step/i }));
    const dialog = screen.getByRole('dialog', { name: /new shared step/i });
    fireEvent.change(within(dialog).getByLabelText(/^title$/i), { target: { value: 'New flow' } });
    // Exact-match regexes -- the row's own "Remove step 1" icon button also
    // carries an aria-label containing "step 1"/"Expected 1" substrings,
    // which a loose /step 1/i would ambiguously match too.
    fireEvent.change(within(dialog).getByLabelText(/^step 1$/i), { target: { value: 'Do the thing' } });
    fireEvent.change(within(dialog).getByLabelText(/^expected 1$/i), { target: { value: 'It happens' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockCreateSharedStep).toHaveBeenCalled());
    expect(mockCreateSharedStep.mock.calls[0][0]).toEqual(
        expect.objectContaining({
            title: 'New flow',
            steps: [expect.objectContaining({ testStep: 'Do the thing', Expected: 'It happens' })]
        })
    );
});

test('editing a shared step and saving calls updateSharedStep with its id', async () => {
    mockUpdateSharedStep.mockResolvedValue(step({ title: 'Log in as super admin' }));
    renderManager();
    expect(await screen.findByText(/Log in as admin/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /edit log in as admin/i }));
    const dialog = screen.getByRole('dialog', { name: /edit shared step/i });
    fireEvent.change(within(dialog).getByLabelText(/^title$/i), { target: { value: 'Log in as super admin' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
        expect(mockUpdateSharedStep).toHaveBeenCalledWith('s1', expect.objectContaining({ title: 'Log in as super admin' }))
    );
});

test('create/edit controls are hidden without can(\'write\')', async () => {
    mockUsePermissions.mockReturnValue({ role: 'viewer', isLoading: false, isError: false, can: (a: string) => a === 'read' });
    renderManager();

    expect(await screen.findByText(/Log in as admin/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new shared step/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit log in as admin/i })).not.toBeInTheDocument();
});

test('the delete control is hidden without can(\'delete\'), even when write is allowed (a contributor)', async () => {
    mockUsePermissions.mockReturnValue({
        role: 'contributor',
        isLoading: false,
        isError: false,
        can: (a: string) => a === 'read' || a === 'write'
    });
    renderManager();

    expect(await screen.findByText(/Log in as admin/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit log in as admin/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete log in as admin/i })).not.toBeInTheDocument();
});

test('a successful delete calls deleteSharedStep with its id and closes the confirmation', async () => {
    mockDeleteSharedStep.mockResolvedValue(undefined);
    renderManager();
    expect(await screen.findByText(/Checkout flow/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /delete checkout flow/i }));
    const confirmDialog = await screen.findByRole('dialog', { name: /delete checkout flow/i });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockDeleteSharedStep).toHaveBeenCalledWith('s3'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /delete checkout flow/i })).not.toBeInTheDocument());
});

// The test that matters most, per this WP's own review note: a shared
// step still referenced by a test case is refused with HTTP 409 and a
// `{ error, data: { count, testCases } }` body (api/sharedStepApi.ts's
// deleteSharedStep header comment). Swallowing that down to a generic
// "delete failed" would throw away the one thing the backend went out of
// its way to compute -- which test cases are in the way.
test('shows which test cases are blocking a delete when the server refuses', async () => {
    mockDeleteSharedStep.mockRejectedValue({
        response: {
            status: 409,
            data: {
                error: 'SS-3 is used by 2 test case(s) and cannot be deleted',
                data: { count: 2, testCases: [{ TestCaseId: 'TC-1' }, { TestCaseId: 'TC-9' }] }
            }
        }
    });
    renderManager();
    expect(await screen.findByText(/Checkout flow/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /delete checkout flow/i }));
    const confirmDialog = await screen.findByRole('dialog', { name: /delete checkout flow/i });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText(/TC-1/)).toBeInTheDocument();
    expect(await screen.findByText(/TC-9/)).toBeInTheDocument();
    expect(await screen.findByText(/used by 2 test case/i)).toBeInTheDocument();
    // A refused delete is not treated as a success -- the confirmation
    // dialog stays open so the user can see why, instead of silently
    // closing as if nothing happened.
    expect(screen.getByRole('dialog', { name: /delete checkout flow/i })).toBeInTheDocument();
});
