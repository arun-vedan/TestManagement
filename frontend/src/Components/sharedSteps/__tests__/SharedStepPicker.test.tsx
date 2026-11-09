import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { SharedStepPicker } from '../SharedStepPicker';
import { SharedStep, listSharedSteps } from '../../../api/sharedStepApi';
import usePermissions from '../../../Hooks/usePermissions';

// WP-F06 Task 5 -- the insert side of the shared-step feature. Every call
// this dialog makes is mocked (listSharedSteps).
//
// Deliberately NOT `{ ...jest.requireActual(...), listSharedSteps: jest.fn() }`
// the way FieldsPanel.test.tsx mocks fieldsApi -- requireActual here would
// run sharedStepApi.ts for real, which imports axios.tsx, which imports
// src/keycloak.js, which imports the `keycloak-js` package. That package
// ships ESM-only (package.json: `"type": "module"`, a single `exports`
// entry, no CJS build) and Jest's default transform ignores node_modules,
// so requireActual-ing ANY module on that import chain throws
// `SyntaxError: Unexpected token 'export'` -- confirmed by running
// FieldsPanel.test.tsx itself in isolation, which fails the identical way
// for the identical reason, unrelated to this WP. sharedStepApi.ts has no
// non-function/non-type export this component needs (unlike fieldsApi.ts's
// CREATABLE_FIELD_TYPES), so there is nothing requireActual would need to
// preserve here -- a plain jest.fn() per named export sidesteps the whole
// import chain instead of tripping over it.
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
        description: 'Standard login flow',
        steps: [{ testStep: 'Go to login', Expected: 'Login page shown' }],
        ...overrides
    };
}

const STEPS: SharedStep[] = [step(), step({ _id: 's2', id: 2, SharedStepId: 'SS-2', title: 'Log out', description: undefined, steps: [] })];

function renderPicker(onInsert = jest.fn(), onClose = jest.fn()) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const utils = render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <SharedStepPicker projectId={7} open onClose={onClose} onInsert={onInsert} />
            </ThemeProvider>
        </QueryClientProvider>
    );
    return { ...utils, onInsert, onClose };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockUsePermissions.mockReturnValue({ role: 'contributor', isLoading: false, isError: false, can: () => true });
    mockListSharedSteps.mockResolvedValue(STEPS);
});

test('lists shared steps from the library', async () => {
    renderPicker();
    expect(await screen.findByText('Log in as admin')).toBeInTheDocument();
    expect(screen.getByText('Log out')).toBeInTheDocument();
});

test('filters the list by typed text', async () => {
    renderPicker();
    expect(await screen.findByText('Log in as admin')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/search shared steps/i), { target: { value: 'out' } });

    expect(screen.getByText('Log out')).toBeInTheDocument();
    expect(screen.queryByText('Log in as admin')).not.toBeInTheDocument();
});

test('inserting appends a reference row shaped { sharedStepId, sharedStepTitle } and closes the dialog', async () => {
    const { onInsert, onClose } = renderPicker();
    expect(await screen.findByText('Log in as admin')).toBeInTheDocument();

    // Two rows, both write-enabled -- click the first row's Insert button.
    fireEvent.click(screen.getAllByRole('button', { name: /^insert$/i })[0]);

    // The exact reference shape TableRows.tsx's `row.sharedStepId` branch
    // expects, using the shared step's Mongo _id (not its human-facing
    // SharedStepId) -- see this component's own header comment for why.
    expect(onInsert).toHaveBeenCalledWith({ sharedStepId: 's1', sharedStepTitle: 'Log in as admin' });
    expect(onClose).toHaveBeenCalled();
});

test('a viewer (can(\'write\') === false) never sees the insert control', async () => {
    mockUsePermissions.mockReturnValue({ role: 'viewer', isLoading: false, isError: false, can: () => false });
    renderPicker();

    expect(await screen.findByText('Log in as admin')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^insert$/i })).not.toBeInTheDocument();
});

test('an empty library shows an honest empty state, not a spinner or error', async () => {
    mockListSharedSteps.mockResolvedValue([]);
    renderPicker();

    expect(await screen.findByText(/no shared steps exist/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});
