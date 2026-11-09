import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import Dashboard from '../index';
import Reports from '../../reports';
import { usePermissions } from '../../../Hooks/usePermissions';
import {
    getCoverage,
    getDefectSummary,
    getPassRateTrend,
    getPlanProgress,
    getReleaseReadiness,
    getTraceability,
    getWorkload,
} from '../../../api/reportApi';

// WP-F13 Task 3, fix round 1 (coordinator review, Finding 1) — proves the
// SCOPE of the traceability fetch, not just that it eventually resolves.
// Unlike sections.test.tsx/dashboard.test.tsx, usePersonaReports is
// deliberately NOT mocked here: those tests fix the hook's OUTPUT by hand,
// which can't catch a regression in the hook's own request-firing logic
// (exactly the bug this fix round exists to close -- Dashboard firing
// computeTraceability's six-service fan-out for a section it never
// renders). Real react-query, real usePersonaReports, only the network
// layer (reportApi.ts's exported functions) mocked, so the assertion is on
// which HTTP-shaped calls actually fired.

jest.mock('../../../Components/Layout/MainLayout', () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('../../../Hooks/usePermissions', () => ({
    usePermissions: jest.fn(),
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
// Bare jest.fn()s in the factory, with NO implementation assigned here --
// CRA's own jest config sets `resetMocks: true` (create-react-app's
// createJestConfig.js), which wipes any mockImplementation set inside a
// jest.mock() factory before the FIRST test even runs (the factory only
// executes once, at module-require time, before that automatic reset).
// Implementations are (re-)supplied in `beforeEach` below instead, which
// runs AFTER that automatic reset -- assigning them here would silently
// resolve to `undefined` on every render, which is exactly what happened
// on the first pass at this test (visible as console.error "Query data
// cannot be undefined" noise even though the CALL-COUNT assertions still
// happened to pass).
jest.mock('../../../api/reportApi', () => {
    const actual = jest.requireActual('../../../api/reportApi');
    return {
        ...actual,
        getCoverage: jest.fn(),
        getPassRateTrend: jest.fn(),
        getDefectSummary: jest.fn(),
        getPlanProgress: jest.fn(),
        getReleaseReadiness: jest.fn(),
        getWorkload: jest.fn(),
        getTraceability: jest.fn(),
    };
});

const envelope = (data: unknown) =>
    Promise.resolve({ success: true, projectId: 1, reportType: 'x', computedAt: new Date().toISOString(), stale: false, data });

const mockUsePermissions = usePermissions as jest.Mock;
const mockGetCoverage = getCoverage as jest.Mock;
const mockGetTraceability = getTraceability as jest.Mock;

beforeEach(() => {
    mockUsePermissions.mockReturnValue({ role: 'manager', isLoading: false, isError: false, can: () => true });
    mockGetCoverage.mockResolvedValue(
        envelope({
            label: 'Requirement coverage',
            total: 0,
            tested: 0,
            untested: 0,
            segments: { noTestsLinked: 0, notFullyVerified: 0, executedFailing: 0, executedPassing: 0 },
            breakdown: { data: [] },
        })
    );
    (getPassRateTrend as jest.Mock).mockResolvedValue(envelope({ xLabels: [], series: [] }));
    (getDefectSummary as jest.Mock).mockResolvedValue(
        envelope({ total: 0, byStatus: { categories: [], series: [] }, bySeverity: { data: [] }, byAge: { categories: [], series: [] } })
    );
    (getPlanProgress as jest.Mock).mockResolvedValue(envelope({ categories: [], series: [] }));
    (getReleaseReadiness as jest.Mock).mockResolvedValue(envelope({ total: 0, rollup: { data: [] }, releases: [] }));
    (getWorkload as jest.Mock).mockResolvedValue(envelope({ categories: [], series: [] }));
    mockGetTraceability.mockResolvedValue(envelope({ label: 'Requirement traceability', total: 0, rows: [] }));
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
});

function withProviders(ui: React.ReactElement) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <MemoryRouter>{ui}</MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>
    );
}

describe('traceability fetch scope (WP-F13 Task 3 fix round 1)', () => {
    // BREAKS IF: usePersonaReports.ts's `enabled: includeTraceability` is
    // reverted to a bare `true` (or `includeTraceability`'s default is
    // flipped to `true`) -- Dashboard's plain `usePersonaReports()` call
    // would then fire getTraceability() exactly like every other report.
    it('never calls getTraceability() when rendering Dashboard, which renders no TraceabilityMatrixSection', async () => {
        render(withProviders(<Dashboard />));

        // Wait for the real fetch cycle to actually run (proven by a report
        // Dashboard DOES use resolving) before asserting the negative --
        // otherwise "not called yet" could just mean "hasn't rendered yet".
        await waitFor(() => expect(mockGetCoverage).toHaveBeenCalled());

        expect(mockGetTraceability).not.toHaveBeenCalled();
    });

    // BREAKS IF: reports.tsx's `usePersonaReports({ includeTraceability:
    // true })` call drops that option (back to a bare `usePersonaReports()`)
    // -- the traceability query would stay disabled there too, and this
    // section would never receive real data.
    it('calls getTraceability() when rendering the Reports page, which renders TraceabilityMatrixSection', async () => {
        render(withProviders(<Reports />));

        await waitFor(() => expect(mockGetCoverage).toHaveBeenCalled());
        await waitFor(() => expect(mockGetTraceability).toHaveBeenCalled());
    });
});
