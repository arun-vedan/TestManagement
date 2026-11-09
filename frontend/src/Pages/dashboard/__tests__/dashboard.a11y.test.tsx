import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import Dashboard from '../index';
import { usePermissions } from '../../../Hooks/usePermissions';
import { usePersonaReports } from '../usePersonaReports';

// WP-046 — Dashboard IS the dashboard target page. Reuses
// dashboard.test.tsx's own harness (see that file's header comment for why
// MainLayout is mocked -- it needs the app's full context-provider tree,
// which isn't what this page's own a11y is about) rather than inventing a
// second one, and mocks the same two children DefectContent.a11y.test.tsx
// mocked LinkIssues for: TestExecutionFilterPanel/DefectFilterPanel each
// have their own dedicated axe coverage now
// (dashboardDrilldown/__tests__/filterPanels.test.tsx, previous commit),
// so re-verifying their internals through every page that mounts them
// would be redundant, not more thorough.
//
// Everything else here is real, unmocked application code: TesterSection/
// TestManagerSection/QaExecSection, the StatTile/TrendChart/DonutChart/
// BarChart primitives they render (WP-042, independently axe-verified in
// charts.test.tsx), StaleBanner, DrilldownLink, and the role-gating
// chrome (loading skeleton / EmptyState / role-based section visibility)
// that is this page's own contribution.

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

// usePersonaReports' returned queries carry the report ENVELOPE
// (ReportEnvelope<T> -- {computedAt, stale, data: T}, see api/reportApi.ts)
// as their own `.data`, which useReportState then unwraps a second time.
// So `LOADED` here wraps a report-shaped payload as that envelope, not as
// the query result's `.data` directly.
const LOADED = <T,>(reportData: T) => ({
    data: { computedAt: '2026-01-01T00:00:00Z', stale: false, data: reportData },
    isLoading: false,
    isError: false,
    error: undefined,
});
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

describe('Dashboard (WP-046) — the dashboard target page', () => {
    it('axe clean for a viewer ("My work" only, empty-state widgets)', async () => {
        mockUsePermissions.mockReturnValue({ role: 'viewer', isLoading: false, isError: false, can: () => false });
        const { container } = renderDashboard();
        await screen.findByText('My work');
        expect(await axe(container)).toHaveNoViolations();
    });

    it('axe clean for a manager, with all three sections and populated widgets stacked', async () => {
        mockUsePermissions.mockReturnValue({ role: 'manager', isLoading: false, isError: false, can: () => true });
        mockUsePersonaReports.mockReturnValue({
            coverage: LOADED({
                label: 'Coverage',
                total: 40,
                tested: 30,
                untested: 10,
                segments: { noTestsLinked: 10, notFullyVerified: 5, executedFailing: 5, executedPassing: 20 },
                breakdown: {
                    data: [
                        { id: 'noTestsLinked', label: 'No tests linked', value: 10 },
                        { id: 'notFullyVerified', label: 'Tests linked, not fully verified', value: 5 },
                        { id: 'executedFailing', label: 'Executed, failing', value: 5 },
                        { id: 'executedPassing', label: 'Executed, all passing', value: 20 },
                    ],
                },
            }),
            passRateTrend: LOADED({ xLabels: ['Jan', 'Feb'], series: [{ id: 'pass', label: 'Pass rate', data: [90, 92] }] }),
            defectSummary: LOADED({
                total: 52,
                byStatus: { categories: ['New', 'Open'], series: [{ id: 'count', label: 'Count', data: [10, 42] }] },
                bySeverity: { data: [{ id: 'high', label: 'High', value: 12 }, { id: 'low', label: 'Low', value: 40 }] },
                byAge: { categories: ['0-7d', '8-30d'], series: [{ id: 'count', label: 'Count', data: [20, 32] }] },
            }),
            planProgress: LOADED({ categories: ['Plan A'], series: [{ id: 'blocked', label: 'Blocked', data: [1] }] }),
            releaseReadiness: LOADED({
                total: 2,
                rollup: { data: [{ id: 'green', label: 'Green', value: 1 }, { id: 'red', label: 'Red', value: 1 }] },
                releases: [{ releaseId: 'REL-1', status: 'In progress', overall: 'red', passed: false, ruleCount: 3 }],
            }),
            workload: LOADED({
                categories: ['user-abc-123'],
                series: [
                    { id: 'assigned', label: 'Assigned', data: [5] },
                    { id: 'completed', label: 'Completed', data: [3] },
                ],
            }),
        });
        const { container } = renderDashboard();
        await screen.findByText('Release & quality');
        expect(await axe(container)).toHaveNoViolations();
    });

    it('axe clean while the role is still resolving (loading skeleton)', async () => {
        mockUsePermissions.mockReturnValue({ role: null, isLoading: true, isError: false, can: () => false });
        const { container } = renderDashboard();
        await screen.findByTestId('dashboard-role-loading');
        expect(await axe(container)).toHaveNoViolations();
    });

    it('axe clean for the "not a member of this project" guidance state', async () => {
        mockUsePermissions.mockReturnValue({ role: null, isLoading: false, isError: false, can: () => false });
        const { container } = renderDashboard();
        await screen.findByText(/not a member of this project yet/i);
        expect(await axe(container)).toHaveNoViolations();
    });

    it('axe clean for the role-resolution error state', async () => {
        mockUsePermissions.mockReturnValue({ role: null, isLoading: false, isError: true, can: () => false });
        const { container } = renderDashboard();
        await screen.findByRole('alert');
        expect(await axe(container)).toHaveNoViolations();
    });
});
