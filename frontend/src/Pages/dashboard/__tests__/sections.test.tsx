import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { TesterSection } from '../sections/TesterSection';
import { TestManagerSection } from '../sections/TestManagerSection';
import { QaExecSection } from '../sections/QaExecSection';
import { ReportState } from '../useReportState';
import {
    CoverageData,
    DefectSummaryData,
    PassRateTrendData,
    PlanProgressData,
    ReleaseReadinessData,
    WorkloadData,
} from '../../../api/reportApi';
import {
    myAssignedTestsLink,
    myFailedTestsLink,
    myOpenDefectsLink,
    blockedTestsLink,
    releasesNeedingAttentionLink,
    requirementsLink,
} from '../dashboardLinks';

// WP-041 — direct, props-driven tests of the three persona sections
// (substituting for the browser verification this environment can't do,
// same posture as WP-042's charts.test.tsx). Each section takes plain
// ReportState<T> props, so every state a live WP-040 response can produce
// (loading / real data / true-empty project / 503-unavailable / stale) is
// constructed directly here rather than mocked through react-query.

jest.mock('../../../Components/dashboardDrilldown/TestExecutionFilterPanel', () => ({
    TestExecutionFilterPanel: (props: { title?: string; viewAllHref?: string; searchParams: URLSearchParams }) => (
        <div data-testid="mock-exec-panel" data-view-all-href={props.viewAllHref} data-params={props.searchParams.toString()}>
            {props.title}
        </div>
    ),
}));
jest.mock('../../../Components/dashboardDrilldown/DefectFilterPanel', () => ({
    DefectFilterPanel: (props: { title?: string; viewAllHref?: string; searchParams: URLSearchParams }) => (
        <div data-testid="mock-defect-panel" data-view-all-href={props.viewAllHref} data-params={props.searchParams.toString()}>
            {props.title}
        </div>
    ),
}));

beforeEach(() => {
    // jsdom has no window.matchMedia; @mui/x-charts' useReducedMotion calls
    // it on mount. See Components/charts/__tests__/charts.test.tsx -- same
    // stub, same reason, `beforeEach` because CRA's jest config resets
    // mocks between tests.
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

const withProviders = (ui: React.ReactElement) => (
    <ThemeProvider theme={theme}>
        <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>
);

function reportState<T>(overrides: Partial<ReportState<T>> = {}): ReportState<T> {
    return {
        data: undefined,
        isLoading: false,
        isUnavailable: false,
        errorMessage: null,
        stale: false,
        staleReason: undefined,
        computedAt: undefined,
        ...overrides,
    };
}

describe('TesterSection', () => {
    const SUB = 'user-abc-123';

    it('shows the current user’s assigned/completed counts from the workload report, matched by sub', () => {
        const workload = reportState<WorkloadData>({
            data: {
                categories: ['other-user', SUB],
                series: [
                    { id: 'assigned', label: 'Assigned', data: [3, 7] },
                    { id: 'completed', label: 'Completed', data: [1, 4] },
                ],
            },
        });
        render(withProviders(<TesterSection sub={SUB} workload={workload} />));
        expect(screen.getByText('7')).toBeInTheDocument();
        expect(screen.getByText('4')).toBeInTheDocument();

        const assignedLink = screen.getByRole('link', { name: /view assigned tests/i });
        expect(assignedLink).toHaveAttribute('href', myAssignedTestsLink(SUB));
    });

    it('shows designed empty guidance, not "0", when the user has no workload row at all', () => {
        const workload = reportState<WorkloadData>({
            data: { categories: ['someone-else'], series: [{ id: 'assigned', label: 'Assigned', data: [2] }] },
        });
        render(withProviders(<TesterSection sub={SUB} workload={workload} />));
        expect(screen.getByText(/no tests assigned to you yet in this project/i)).toBeInTheDocument();
        expect(screen.queryByText('0')).not.toBeInTheDocument();
    });

    it('shows a distinct "not available yet" message, not "0", when workload is 503-unavailable', () => {
        const workload = reportState<WorkloadData>({ isUnavailable: true });
        render(withProviders(<TesterSection sub={SUB} workload={workload} />));
        expect(screen.getByText(/workload metrics aren.t available yet/i)).toBeInTheDocument();
    });

    it('surfaces a stale workload report instead of silently showing it as current', () => {
        const workload = reportState<WorkloadData>({
            data: { categories: [SUB], series: [{ id: 'assigned', label: 'Assigned', data: [5] }] },
            stale: true,
            staleReason: 'testPlanExecutionService unreachable',
            computedAt: '2026-08-30T00:00:00.000Z',
        });
        render(withProviders(<TesterSection sub={SUB} workload={workload} />));
        expect(screen.getByTestId('stale-banner')).toHaveTextContent(/testPlanExecutionService unreachable/);
    });

    it('wires the failed-tests and open-defects panels with the exact filter params dashboardLinks.ts builds', () => {
        const workload = reportState<WorkloadData>();
        render(withProviders(<TesterSection sub={SUB} workload={workload} />));

        const execPanel = screen.getByTestId('mock-exec-panel');
        expect(execPanel).toHaveAttribute('data-params', `assignedTo=${SUB}&status=fail`);
        expect(execPanel).toHaveAttribute('data-view-all-href', myFailedTestsLink(SUB));

        const defectPanel = screen.getByTestId('mock-defect-panel');
        expect(defectPanel).toHaveAttribute('data-params', `assignedTo=${SUB}&open=1`);
        expect(defectPanel).toHaveAttribute('data-view-all-href', myOpenDefectsLink(SUB));
    });
});

describe('TestManagerSection', () => {
    const baseProps = () => ({
        coverage: reportState<CoverageData>(),
        planProgress: reportState<PlanProgressData>(),
        passRateTrend: reportState<PassRateTrendData>(),
    });

    it('shows the real 0%-tested coverage split plus an actionable caption, not just a bare "0"', () => {
        const props = baseProps();
        props.coverage = reportState<CoverageData>({
            data: {
                label: 'Requirement coverage',
                total: 5,
                tested: 0,
                untested: 5,
                segments: { noTestsLinked: 5, notFullyVerified: 0, executedFailing: 0, executedPassing: 0 },
                breakdown: {
                    data: [
                        { id: 'noTestsLinked', label: 'No tests linked', value: 5 },
                        { id: 'notFullyVerified', label: 'Tests linked, not fully verified', value: 0 },
                        { id: 'executedFailing', label: 'Executed, failing', value: 0 },
                        { id: 'executedPassing', label: 'Executed, all passing', value: 0 },
                    ],
                },
            },
        });
        render(withProviders(<TestManagerSection {...props} />));
        expect(screen.getByText(/0 of 5 requirements have a linked test/i)).toBeInTheDocument();
        // WP-044: requirementsLink() now builds /projects/:projectId/requirements
        // (currentProject.ts's route-driven singleton, default project id 1
        // outside any mounted /projects/:id route) instead of the old flat
        // /requirements -- asserted through the same builder the component
        // itself calls, not a hardcoded literal, so this doesn't re-drift.
        expect(screen.getByRole('link', { name: /view requirements/i })).toHaveAttribute('href', requirementsLink());
    });

    it('shows guided empty-state text (not the real-data caption) when the project truly has zero requirements', () => {
        const props = baseProps();
        props.coverage = reportState<CoverageData>({
            data: {
                label: 'Requirement coverage',
                total: 0,
                tested: 0,
                untested: 0,
                segments: { noTestsLinked: 0, notFullyVerified: 0, executedFailing: 0, executedPassing: 0 },
                note: 'no requirements defined in this project yet',
                breakdown: { data: [] },
            },
        });
        render(withProviders(<TestManagerSection {...props} />));
        expect(screen.getByText(/no requirements defined yet/i)).toBeInTheDocument();
        expect(screen.queryByText(/requirements have a linked test/i)).not.toBeInTheDocument();
    });

    it('shows a distinct "not available yet" message for a 503-unavailable coverage report, not a red error', () => {
        const props = baseProps();
        props.coverage = reportState<CoverageData>({ isUnavailable: true });
        render(withProviders(<TestManagerSection {...props} />));
        expect(screen.getByText(/coverage isn.t available yet/i)).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('sums the blocked series across plans for the "Blocked tests" tile and links to the filtered execution view', () => {
        const props = baseProps();
        props.planProgress = reportState<PlanProgressData>({
            data: {
                categories: ['PLN-5', 'PLN-6'],
                series: [
                    { id: 'executed', label: 'Executed', data: [4, 2] },
                    { id: 'passed', label: 'Passed', data: [3, 1] },
                    { id: 'blocked', label: 'Blocked', data: [1, 2] },
                ],
            },
        });
        render(withProviders(<TestManagerSection {...props} />));
        const blockedTile = screen.getByRole('figure', { name: 'Blocked tests' });
        expect(within(blockedTile).getByText('3')).toBeInTheDocument(); // 1 + 2
        expect(screen.getByRole('link', { name: /view blocked tests/i })).toHaveAttribute('href', blockedTestsLink());
    });

    it('shows a note that parameterised cases count one result per data row', () => {
        const props = baseProps();
        props.planProgress = reportState<PlanProgressData>({
            data: {
                categories: ['PLN-1'],
                series: [
                    { id: 'executed', label: 'Executed', data: [3] },
                    { id: 'passed', label: 'Passed', data: [2] },
                    { id: 'blocked', label: 'Blocked', data: [0] },
                ],
            },
        });
        render(withProviders(<TestManagerSection {...props} />));
        expect(screen.getByText(/counts include one result per data row for parameterised cases/i)).toBeInTheDocument();
    });
});

describe('QaExecSection', () => {
    const baseProps = () => ({
        releaseReadiness: reportState<ReleaseReadinessData>(),
        defectSummary: reportState<DefectSummaryData>(),
        planProgress: reportState<PlanProgressData>(),
    });

    it('links "N releases need attention" to exactly the red releaseIds from live data', () => {
        const props = baseProps();
        props.releaseReadiness = reportState<ReleaseReadinessData>({
            data: {
                total: 3,
                rollup: { data: [{ id: 'green', label: 'Green', value: 1 }, { id: 'red', label: 'Red', value: 2 }] },
                releases: [
                    { releaseId: 'REL-1', status: 'released', overall: 'green', passed: true, ruleCount: 2 },
                    { releaseId: 'REL-2', status: 'in-progress', overall: 'red', passed: false, ruleCount: 2 },
                    { releaseId: 'REL-3', status: 'frozen', overall: 'red', passed: false, ruleCount: 1 },
                ],
            },
        });
        render(withProviders(<QaExecSection {...props} />));
        const link = screen.getByRole('link', { name: /2 releases need attention/i });
        expect(link).toHaveAttribute('href', releasesNeedingAttentionLink(['REL-2', 'REL-3']));
    });

    it('shows guided empty-state guidance when no releases are tracked yet (the real current project-1 state)', () => {
        const props = baseProps();
        props.releaseReadiness = reportState<ReleaseReadinessData>({ data: { total: 0, rollup: { data: [] }, releases: [] } });
        render(withProviders(<QaExecSection {...props} />));
        expect(screen.getByText(/no releases tracked yet/i)).toBeInTheDocument();
    });

    it('shows a positive all-clear message, with no drilldown, when every release is green', () => {
        const props = baseProps();
        props.releaseReadiness = reportState<ReleaseReadinessData>({
            data: {
                total: 1,
                rollup: { data: [{ id: 'green', label: 'Green', value: 1 }] },
                releases: [{ releaseId: 'REL-1', status: 'released', overall: 'green', passed: true, ruleCount: 1 }],
            },
        });
        render(withProviders(<QaExecSection {...props} />));
        expect(screen.getByText(/all tracked releases are green/i)).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: /need attention/i })).not.toBeInTheDocument();
    });

    it('forces the defect-age chart into its guided empty state instead of 4 always-zero bars when there are no defects', () => {
        const props = baseProps();
        props.defectSummary = reportState<DefectSummaryData>({
            data: {
                total: 0,
                byStatus: { categories: [], series: [] },
                bySeverity: { data: [] },
                // Real backend behavior: byAge's 4 category labels are always
                // present even with zero defects (every count is 0) -- this
                // is the exact "zeros soup" shape the section must not render
                // as-is.
                byAge: {
                    categories: ['0-7 days', '8-30 days', '31-90 days', '90+ days'],
                    series: [{ id: 'count', label: 'Defects', data: [0, 0, 0, 0] }],
                },
            },
        });
        render(withProviders(<QaExecSection {...props} />));
        const ageChart = screen.getByRole('figure', { name: 'Defect age' });
        expect(within(ageChart).getByText(/no defects logged yet/i)).toBeInTheDocument();
        expect(screen.queryByText('0-7 days')).not.toBeInTheDocument();
    });
});
