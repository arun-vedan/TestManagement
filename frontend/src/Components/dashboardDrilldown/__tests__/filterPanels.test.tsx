import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { TestExecutionFilterPanel } from '../TestExecutionFilterPanel';
import { DefectFilterPanel } from '../DefectFilterPanel';
import { getTestExecutionList, getDefectList } from '../../../api/apiCalls';
import { getIssueStatuses } from '../../../api/defectStatusApi';

// WP-041 — proves the dashboard's drill-down links land on a REAL,
// correctly-filtered page, not just that an anchor tag with a plausible
// href exists (the acceptance criterion this whole file exists for):
//   1. a panel with no recognized query param renders nothing at all (a
//      plain visit to whichever host renders it -- Pages/dashboard's own
//      sections/TesterSection.tsx for TestExecutionFilterPanel, and
//      workbench/EntityDetail.tsx for DefectFilterPanel since WP-077
//      retired Pages/defects.tsx into the workbench -- is unaffected);
//   2. a panel WITH a query param calls the underlying list API with the
//      exact Mongo filter that param is supposed to produce
//      (dashboardLinks.ts's own vocabulary), and renders the rows that
//      call returns;
//   3. a zero-row result renders the panel's designed guidance, not a
///     blank/zero table;
//   4. an API failure renders a visible error state, not a silent blank.

jest.mock('../../../api/apiCalls', () => ({
    getTestExecutionList: jest.fn(),
    getDefectList: jest.fn(),
}));
jest.mock('../../../api/defectStatusApi', () => ({
    getIssueStatuses: jest.fn(),
}));

const mockGetTestExecutionList = getTestExecutionList as jest.Mock;
const mockGetDefectList = getDefectList as jest.Mock;
const mockGetIssueStatuses = getIssueStatuses as jest.Mock;

const withProviders = (ui: React.ReactElement) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <MemoryRouter>{ui}</MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>
    );
};

beforeEach(() => {
    mockGetTestExecutionList.mockReset();
    mockGetDefectList.mockReset();
    mockGetIssueStatuses.mockReset();
    mockGetIssueStatuses.mockResolvedValue([
        { id: 1, istatus: 'New', parentId: [] },
        { id: 2, istatus: 'Open', parentId: [1] },
        { id: 8, istatus: 'Closed', parentId: [1, 2] },
    ]);
});

describe('TestExecutionFilterPanel', () => {
    it('renders nothing when the URL carries no recognized filter param', () => {
        const { container } = render(withProviders(<TestExecutionFilterPanel searchParams={new URLSearchParams()} />));
        expect(container).toBeEmptyDOMElement();
        expect(mockGetTestExecutionList).not.toHaveBeenCalled();
    });

    it('requests the exact Mongo filter assignedTo+status=fail map to, and renders the matching rows', async () => {
        mockGetTestExecutionList.mockResolvedValue([
            { _id: 'e1', TestExecutionId: 'TE-9', assignedTo: 'user-abc', TestCases: [{ TestStatus: 'Fail' }] },
        ]);
        render(
            withProviders(
                <TestExecutionFilterPanel searchParams={new URLSearchParams({ assignedTo: 'user-abc', status: 'fail' })} />
            )
        );

        await waitFor(() => expect(mockGetTestExecutionList).toHaveBeenCalled());
        const queryString = mockGetTestExecutionList.mock.calls[0][0] as string;
        // dashboardLinks.ts's EXECUTION_STATUS_FILTER_VALUES maps 'fail' -> the
        // real stored TestStatus casing 'Fail' -- this is the literal proof
        // that the URL's ?status=fail really turns into that Mongo filter.
        expect(queryString).toContain('assignedTo=user-abc');
        expect(queryString).toContain('TestCases.TestStatus=Fail');

        expect(await screen.findByText('TE-9')).toBeInTheDocument();
        expect(screen.getByText('Fail')).toBeInTheDocument();
    });

    it('shows designed empty-state guidance, not a blank table, when nothing matches', async () => {
        mockGetTestExecutionList.mockResolvedValue([]);
        render(withProviders(<TestExecutionFilterPanel searchParams={new URLSearchParams({ assignedTo: 'user-abc' })} />));
        expect(await screen.findByText(/no test executions match this filter/i)).toBeInTheDocument();
    });

    it('shows a visible error state, distinct from an empty one, on API failure', async () => {
        mockGetTestExecutionList.mockRejectedValue(new Error('network down'));
        render(withProviders(<TestExecutionFilterPanel searchParams={new URLSearchParams({ assignedTo: 'user-abc' })} />));
        expect(await screen.findByRole('alert')).toHaveTextContent(/unable to load filtered test executions/i);
    });

    it('renders an "Open in Test Execution" link to the given viewAllHref when provided', async () => {
        mockGetTestExecutionList.mockResolvedValue([]);
        render(
            withProviders(
                <TestExecutionFilterPanel
                    searchParams={new URLSearchParams({ assignedTo: 'user-abc' })}
                    viewAllHref="/testexecution?assignedTo=user-abc"
                />
            )
        );
        const link = await screen.findByRole('link', { name: /open in test execution/i });
        expect(link).toHaveAttribute('href', '/testexecution?assignedTo=user-abc');
    });

    // WP-046 — these panels are mounted directly on the dashboard
    // (Pages/dashboard/sections/TesterSection.tsx's "My failed tests"), one
    // of this WP's four target pages. dashboard.a11y.test.tsx mocks them
    // out (their own drill-down-correctness proof above is this file's
    // job, not the dashboard's), so their real markup -- including the
    // "Open in ..." link and the populated/empty/error states -- is
    // verified under axe here instead.
    it('is axe clean populated, empty, and on error', async () => {
        // A fresh render (fresh QueryClient, from withProviders) per state
        // rather than rerender()ing one instance -- react-query caches by
        // query key inside a shared QueryClient, so rerendering with a new
        // mock resolution but the same/overlapping key kept serving the
        // FIRST render's cached data instead of refetching (confirmed
        // empirically: findByText for the empty-state copy timed out
        // because the populated row was still showing).
        mockGetTestExecutionList.mockResolvedValue([
            { _id: 'e1', TestExecutionId: 'TE-9', assignedTo: 'user-abc', TestCases: [{ TestStatus: 'Fail' }] },
        ]);
        let view = render(
            withProviders(
                <TestExecutionFilterPanel
                    searchParams={new URLSearchParams({ assignedTo: 'user-abc', status: 'fail' })}
                    viewAllHref="/testexecution?assignedTo=user-abc"
                />
            )
        );
        await screen.findByText('TE-9');
        expect(await axe(view.container)).toHaveNoViolations();
        view.unmount();

        mockGetTestExecutionList.mockResolvedValue([]);
        view = render(
            withProviders(<TestExecutionFilterPanel searchParams={new URLSearchParams({ assignedTo: 'user-abc' })} />)
        );
        await screen.findByText(/no test executions match this filter/i);
        expect(await axe(view.container)).toHaveNoViolations();
        view.unmount();

        mockGetTestExecutionList.mockRejectedValue(new Error('network down'));
        view = render(
            withProviders(<TestExecutionFilterPanel searchParams={new URLSearchParams({ assignedTo: 'user-abc' })} />)
        );
        await screen.findByRole('alert');
        expect(await axe(view.container)).toHaveNoViolations();
    });
});

describe('DefectFilterPanel', () => {
    it('renders nothing when the URL carries no recognized filter param', () => {
        const { container } = render(withProviders(<DefectFilterPanel searchParams={new URLSearchParams()} />));
        expect(container).toBeEmptyDOMElement();
        expect(mockGetDefectList).not.toHaveBeenCalled();
    });

    it('requests assignedTo as a real Mongo filter and excludes closed defects when open=1', async () => {
        mockGetDefectList.mockResolvedValue([
            { _id: 'd1', defectId: 'DEF-1', summary: 'Still open', Severity: 'High', Status: '2', assignedTo: 'user-abc' },
            { _id: 'd2', defectId: 'DEF-2', summary: 'Already closed', Severity: 'High', Status: '8', assignedTo: 'user-abc' },
        ]);
        render(
            withProviders(<DefectFilterPanel searchParams={new URLSearchParams({ assignedTo: 'user-abc', open: '1' })} />)
        );

        await waitFor(() => expect(mockGetDefectList).toHaveBeenCalled());
        expect((mockGetDefectList.mock.calls[0][0] as string)).toContain('assignedTo=user-abc');

        expect(await screen.findByText('DEF-1')).toBeInTheDocument();
        expect(screen.queryByText('DEF-2')).not.toBeInTheDocument();
    });

    it('filters by severity as a direct Mongo field match', async () => {
        mockGetDefectList.mockResolvedValue([
            { _id: 'd3', defectId: 'DEF-3', summary: 'High one', Severity: 'High', Status: '1' },
        ]);
        render(withProviders(<DefectFilterPanel searchParams={new URLSearchParams({ severity: 'High' })} />));
        await waitFor(() => expect(mockGetDefectList).toHaveBeenCalled());
        expect((mockGetDefectList.mock.calls[0][0] as string)).toContain('Severity=High');
        expect(await screen.findByText('DEF-3')).toBeInTheDocument();
    });

    it('shows positive, designed guidance (not zeros soup) when there are no open defects', async () => {
        mockGetDefectList.mockResolvedValue([]);
        render(
            withProviders(<DefectFilterPanel searchParams={new URLSearchParams({ assignedTo: 'user-abc', open: '1' })} />)
        );
        expect(await screen.findByText(/no open defects match this filter/i)).toBeInTheDocument();
    });

    // WP-046 — same reasoning as TestExecutionFilterPanel's axe test above:
    // this panel is mounted directly on the dashboard target page
    // (TesterSection's "My open defects"), mocked out there, verified here.
    it('is axe clean populated and empty', async () => {
        // Fresh render per state -- see TestExecutionFilterPanel's own axe
        // test above for why rerender() isn't used (react-query cache
        // reuse across a shared QueryClient).
        mockGetDefectList.mockResolvedValue([
            { _id: 'd1', defectId: 'DEF-1', summary: 'Still open', Severity: 'High', Status: '2', assignedTo: 'user-abc' },
        ]);
        let view = render(
            withProviders(<DefectFilterPanel searchParams={new URLSearchParams({ assignedTo: 'user-abc', open: '1' })} />)
        );
        await screen.findByText('DEF-1');
        expect(await axe(view.container)).toHaveNoViolations();
        view.unmount();

        mockGetDefectList.mockResolvedValue([]);
        view = render(
            withProviders(<DefectFilterPanel searchParams={new URLSearchParams({ assignedTo: 'user-abc', open: '1' })} />)
        );
        await screen.findByText(/no open defects match this filter/i);
        expect(await axe(view.container)).toHaveNoViolations();
    });
});
