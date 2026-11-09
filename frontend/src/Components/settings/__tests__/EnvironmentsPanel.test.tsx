import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EnvironmentsPanel } from '../EnvironmentsPanel';
import { Environment, getEnvironments, createEnvironment, updateEnvironment, deleteEnvironment } from '../../../api/releaseApi';
import usePermissions from '../../../Hooks/usePermissions';

// WP-F18b Task 1 — Settings > Environments. Moves environment CRUD off
// the old standalone nav page (Pages/releases.tsx, retired by WP-F18b
// Task 4 -- see this WP's plan) into a Settings tab, same shape as
// Components/settings/FieldsPanel.tsx: list + create + edit + delete,
// gated on usePermissions(). See FieldsPanel.test.tsx's own header
// comment for why axios (not releaseApi itself) is what needs mocking here
// -- releaseApi.ts's `import axiosPrivate from './axios'` pulls in the
// same ESM-only keycloak-js chain, and requireActual below only bypasses
// mocking for releaseApi.ts's own exports, not what it transitively
// imports.
jest.mock('../../../api/axios', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() }
}));
jest.mock('../../../api/releaseApi', () => {
    const actual = jest.requireActual('../../../api/releaseApi');
    return {
        ...actual,
        getEnvironments: jest.fn(),
        createEnvironment: jest.fn(),
        updateEnvironment: jest.fn(),
        deleteEnvironment: jest.fn()
    };
});
jest.mock('../../../Hooks/usePermissions', () => ({ __esModule: true, default: jest.fn() }));

const mockGetEnvironments = getEnvironments as jest.Mock;
const mockCreateEnvironment = createEnvironment as jest.Mock;
const mockUpdateEnvironment = updateEnvironment as jest.Mock;
const mockDeleteEnvironment = deleteEnvironment as jest.Mock;
const mockUsePermissions = usePermissions as unknown as jest.Mock;

const PROJECT_ID = 7;

function environment(overrides: Partial<Environment> = {}): Environment {
    return {
        _id: 'e1',
        id: 1,
        name: 'Staging',
        projectId: PROJECT_ID,
        description: 'Pre-prod',
        url: 'https://staging.example.com',
        ...overrides
    };
}

const ENVIRONMENTS: Environment[] = [
    environment(),
    environment({ _id: 'e2', id: 2, name: 'Production', description: 'Live', url: 'https://prod.example.com' })
];

function renderPanel() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={queryClient}>
            <EnvironmentsPanel projectId={PROJECT_ID} />
        </QueryClientProvider>
    );
    return queryClient;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockUsePermissions.mockReturnValue({ role: 'admin', isLoading: false, isError: false, can: () => true });
    mockGetEnvironments.mockResolvedValue(ENVIRONMENTS);
});

test('lists the project\'s environments', async () => {
    renderPanel();

    expect(await screen.findByText('Staging')).toBeInTheDocument();
    expect(screen.getByText('Production')).toBeInTheDocument();
    expect(screen.getByText('https://staging.example.com')).toBeInTheDocument();
});

test('renders an honest empty state, not a spinner or error, when there are none', async () => {
    mockGetEnvironments.mockResolvedValue([]);
    renderPanel();

    expect(await screen.findByText(/no environments/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/unable to load/i)).not.toBeInTheDocument();
});

test('create posts the right payload and the new environment appears', async () => {
    renderPanel();
    expect(await screen.findByText('Staging')).toBeInTheDocument();

    const created = environment({ _id: 'e3', id: 3, name: 'QA', description: 'Test env', url: 'https://qa.example.com' });
    mockCreateEnvironment.mockResolvedValue(created);
    mockGetEnvironments.mockResolvedValue([...ENVIRONMENTS, created]);

    fireEvent.click(screen.getByRole('button', { name: /new environment/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^name$/i), { target: { value: 'QA' } });
    fireEvent.change(within(dialog).getByLabelText(/description/i), { target: { value: 'Test env' } });
    fireEvent.change(within(dialog).getByLabelText(/url/i), { target: { value: 'https://qa.example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /create/i }));

    await waitFor(() => expect(mockCreateEnvironment).toHaveBeenCalled());
    expect(mockCreateEnvironment.mock.calls[0][0]).toEqual(
        expect.objectContaining({ name: 'QA', description: 'Test env', url: 'https://qa.example.com' })
    );
    expect(await screen.findByText('QA')).toBeInTheDocument();
});

test('edit calls updateEnvironment with the environment id and delete asks for confirmation naming the environment first', async () => {
    mockUpdateEnvironment.mockResolvedValue(environment({ name: 'Staging (renamed)' }));
    mockDeleteEnvironment.mockResolvedValue(undefined);
    renderPanel();

    expect(await screen.findByText('Staging')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /edit staging/i }));
    const editDialog = screen.getByRole('dialog');
    fireEvent.change(within(editDialog).getByLabelText(/^name$/i), { target: { value: 'Staging (renamed)' } });
    fireEvent.click(within(editDialog).getByRole('button', { name: /save/i }));

    await waitFor(() =>
        expect(mockUpdateEnvironment).toHaveBeenCalledWith('e1', expect.objectContaining({ name: 'Staging (renamed)' }))
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Delete: confirmation dialog names the environment and warns before any
    // network call happens. There is no undo.
    fireEvent.click(screen.getByRole('button', { name: /delete production/i }));
    const confirmDialog = await screen.findByRole('dialog');
    expect(within(confirmDialog).getAllByText(/production/i).length).toBeGreaterThan(0);
    expect(within(confirmDialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(mockDeleteEnvironment).not.toHaveBeenCalled();

    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(mockDeleteEnvironment).toHaveBeenCalled());
    expect(mockDeleteEnvironment.mock.calls[0][0]).toBe('e2');
});

test('create/edit controls are hidden without can(\'write\')', async () => {
    mockUsePermissions.mockReturnValue({ role: 'viewer', isLoading: false, isError: false, can: (a: string) => a === 'read' });
    renderPanel();

    expect(await screen.findByText('Staging')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new environment/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit staging/i })).not.toBeInTheDocument();
});

// This is the case most likely to regress: write:true makes it tempting to
// gate the whole panel (and thus the delete control) on write alone. A
// contributor has write but NOT delete -- assert with a contributor
// specifically, not only a viewer, since a viewer-only assertion would
// still pass a broken "gate everything on write" implementation.
test('a CONTRIBUTOR (write but not delete) sees edit but no delete control', async () => {
    mockUsePermissions.mockReturnValue({
        role: 'contributor',
        isLoading: false,
        isError: false,
        can: (a: string) => a === 'read' || a === 'write'
    });
    renderPanel();

    expect(await screen.findByText('Staging')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new environment/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit staging/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete staging/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete production/i })).not.toBeInTheDocument();
});
