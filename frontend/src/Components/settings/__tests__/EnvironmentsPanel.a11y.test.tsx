import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { EnvironmentsPanel } from '../EnvironmentsPanel';
import { Environment, getEnvironments } from '../../../api/releaseApi';
import usePermissions from '../../../Hooks/usePermissions';

// WP-F18b Task 1 — axe coverage for Settings > Environments, following
// FieldsPanel.a11y.test.tsx's convention: functional assertions live in
// the sibling *.test.tsx file, this file is axe-only. Every test here
// asserts the real control it is about to check is actually on screen
// (findByText/findByRole/getByRole) BEFORE calling axe -- a dialog that
// never opened, or a panel that never finished loading, would make an axe
// pass over it meaningless. See this file's last test for the explicit
// non-vacuity guard on the delete-confirmation case.
jest.mock('../../../api/axios', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() }
}));
jest.mock('../../../api/releaseApi', () => {
    const actual = jest.requireActual('../../../api/releaseApi');
    return { ...actual, getEnvironments: jest.fn(), createEnvironment: jest.fn(), updateEnvironment: jest.fn(), deleteEnvironment: jest.fn() };
});
jest.mock('../../../Hooks/usePermissions', () => ({ __esModule: true, default: jest.fn() }));

const mockGetEnvironments = getEnvironments as jest.Mock;
const mockUsePermissions = usePermissions as unknown as jest.Mock;

function environment(overrides: Partial<Environment> = {}): Environment {
    return {
        _id: 'e1',
        id: 1,
        name: 'Staging',
        projectId: 7,
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
    return render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <EnvironmentsPanel projectId={7} />
            </ThemeProvider>
        </QueryClientProvider>
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockUsePermissions.mockReturnValue({ role: 'admin', isLoading: false, isError: false, can: () => true });
    mockGetEnvironments.mockResolvedValue(ENVIRONMENTS);
});

test('the table view (with data) is axe-clean', async () => {
    const { container } = renderPanel();
    expect(await screen.findByText('Staging')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});

test('the empty state is axe-clean', async () => {
    mockGetEnvironments.mockResolvedValue([]);
    const { container } = renderPanel();
    expect(await screen.findByText(/no environments/i)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});

test('the create dialog is axe-clean', async () => {
    const { container } = renderPanel();
    expect(await screen.findByText('Staging')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /new environment/i }));
    const dialog = screen.getByRole('dialog');
    // Non-vacuity guard: the dialog and its real fields are genuinely
    // mounted, not merely present in the render tree as `display:none` or
    // similar -- an axe pass over a dialog that never opened proves
    // nothing (this project shipped exactly that once and it passed a
    // review first).
    expect(dialog).toBeVisible();
    expect(within(dialog).getByLabelText(/^name$/i)).toBeVisible();
    expect(within(dialog).getByLabelText(/description/i)).toBeVisible();
    expect(within(dialog).getByLabelText(/url/i)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: /create/i })).toBeEnabled();

    expect(await axe(container)).toHaveNoViolations();
});

test('the delete confirmation dialog is axe-clean, and the guarded assertions genuinely exercise a mounted dialog', async () => {
    const { container } = renderPanel();
    expect(await screen.findByText('Staging')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /delete staging/i }));
    const dialog = await screen.findByRole('dialog');

    // Non-vacuity guard: confirm the button that opened this dialog, and
    // the dialog's own confirm/cancel controls, are real, visible,
    // clickable elements -- not axe running over an unopened or
    // never-rendered dialog (which would report zero violations for the
    // trivial reason that there was nothing there to violate anything).
    expect(dialog).toBeVisible();
    expect(within(dialog).getAllByText(/staging/i).length).toBeGreaterThan(0);
    const confirmButton = within(dialog).getByRole('button', { name: /^delete$/i });
    const cancelButton = within(dialog).getByRole('button', { name: /cancel/i });
    expect(confirmButton).toBeEnabled();
    expect(cancelButton).toBeEnabled();

    expect(await axe(container)).toHaveNoViolations();
});
