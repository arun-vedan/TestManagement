import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import Dashboard from '../index';
import { usePermissions } from '../../../Hooks/usePermissions';
import { usePersonaReports } from '../usePersonaReports';

// WP-041 — role-gating proof for the top-level Dashboard page: "sections
// gated by role -- not three separate apps" (the WP's own acceptance
// wording). MainLayout is mocked out (a passthrough <div>) because it pulls
// in MainDrawer, which needs the app's full context-provider tree
// (WSContext/TabContext/TemplateContext/PContext/selectedFolderContext/
// DndProvider -- see App.tsx) to render at all; that chrome isn't what
// this test is verifying. usePermissions/usePersonaReports are mocked so
// each scenario (loading / no role / viewer / manager) is deterministic
// and synchronous, same reasoning as sections.test.tsx.

jest.mock('../../../Components/Layout/MainLayout', () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('../../../Hooks/usePermissions', () => ({
    usePermissions: jest.fn(),
}));
jest.mock('../usePersonaReports', () => ({
    usePersonaReports: jest.fn(),
}));
jest.mock('../../../keycloak', () => ({
    __esModule: true,
    default: { tokenParsed: { sub: 'user-abc-123' }, authenticated: true },
}));
jest.mock('../../../Components/dashboardDrilldown/TestExecutionFilterPanel', () => ({
    TestExecutionFilterPanel: () => <div data-testid="mock-exec-panel" />,
}));
jest.mock('../../../Components/dashboardDrilldown/DefectFilterPanel', () => ({
    DefectFilterPanel: () => <div data-testid="mock-defect-panel" />,
}));

const mockUsePermissions = usePermissions as jest.Mock;
const mockUsePersonaReports = usePersonaReports as jest.Mock;

const EMPTY_QUERY_RESULT = { data: undefined, isLoading: false, isError: false, error: undefined };

beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: jest.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: jest.fn(),
            removeListener: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            dispatchEvent: jest.fn(),
        })),
    });
    mockUsePersonaReports.mockReturnValue({
        coverage: EMPTY_QUERY_RESULT,
        passRateTrend: EMPTY_QUERY_RESULT,
        defectSummary: EMPTY_QUERY_RESULT,
        planProgress: EMPTY_QUERY_RESULT,
        releaseReadiness: EMPTY_QUERY_RESULT,
        workload: EMPTY_QUERY_RESULT,
    });
});

// WP-133 added SampleDataCard to this page, which uses react-query
// (useMutation/useQueryClient) to seed the sample project and invalidate the
// report queries afterwards. These suites mock every data hook, so they had no
// QueryClientProvider; the real app always has one (index.tsx). Added here
// rather than removing react-query from the card, because invalidating the
// report cache is what makes the dashboard fill in without a page reload.
const renderDashboard = () =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <ThemeProvider theme={theme}>
                <MemoryRouter>
                    <Dashboard />
                </MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>
    );

describe('Dashboard role gating', () => {
    it('shows only "My work" for a viewer -- no management sections', () => {
        mockUsePermissions.mockReturnValue({ role: 'viewer', isLoading: false, isError: false, can: () => false });
        renderDashboard();
        expect(screen.getByText('My work')).toBeInTheDocument();
        expect(screen.queryByText('Plan & progress')).not.toBeInTheDocument();
        expect(screen.queryByText('Release & quality')).not.toBeInTheDocument();
    });

    it('shows only "My work" for a contributor -- no management sections', () => {
        mockUsePermissions.mockReturnValue({ role: 'contributor', isLoading: false, isError: false, can: () => true });
        renderDashboard();
        expect(screen.getByText('My work')).toBeInTheDocument();
        expect(screen.queryByText('Plan & progress')).not.toBeInTheDocument();
        expect(screen.queryByText('Release & quality')).not.toBeInTheDocument();
    });

    it('shows all three sections stacked on one page for a manager', () => {
        mockUsePermissions.mockReturnValue({ role: 'manager', isLoading: false, isError: false, can: () => true });
        renderDashboard();
        expect(screen.getByText('My work')).toBeInTheDocument();
        expect(screen.getByText('Plan & progress')).toBeInTheDocument();
        expect(screen.getByText('Release & quality')).toBeInTheDocument();
    });

    it('shows all three sections for an admin too', () => {
        mockUsePermissions.mockReturnValue({ role: 'admin', isLoading: false, isError: false, can: () => true });
        renderDashboard();
        expect(screen.getByText('My work')).toBeInTheDocument();
        expect(screen.getByText('Plan & progress')).toBeInTheDocument();
        expect(screen.getByText('Release & quality')).toBeInTheDocument();
    });

    it('shows a loading state, not any section, while role is resolving', () => {
        mockUsePermissions.mockReturnValue({ role: null, isLoading: true, isError: false, can: () => false });
        renderDashboard();
        expect(screen.getByTestId('dashboard-role-loading')).toBeInTheDocument();
        expect(screen.queryByText('My work')).not.toBeInTheDocument();
    });

    it('shows guided "not a member" guidance, not zeroed-out sections, when the user has no role on this project', () => {
        mockUsePermissions.mockReturnValue({ role: null, isLoading: false, isError: false, can: () => false });
        renderDashboard();
        expect(screen.getByText(/not a member of this project yet/i)).toBeInTheDocument();
        expect(screen.queryByText('My work')).not.toBeInTheDocument();
    });
});
