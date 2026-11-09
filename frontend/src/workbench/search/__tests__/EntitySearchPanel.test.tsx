import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider, useWorkbench } from '../../WorkbenchStoreProvider';
import { tabKey } from '../../store/workbenchStore';
import EntitySearchPanel from '../EntitySearchPanel';
import { getWCTCList, getWCReqList, getWCDefectList, getWCPlanList, getWCRunList } from '../../../api/apiCalls';

// Wave B-2 -- <EntitySearchPanel>, the "search" panel mode's real
// implementation (PRODUCT_GAP_REGISTER.md A2). Only api/apiCalls is
// mocked -- entitySearchConfigs.ts and the react-query hook it's read
// through are real, so this exercises the actual debounce -> query ->
// render -> select -> openTab path end to end, no network involved.
//
// Typing is simulated with `fireEvent.change` (not
// `userEvent.type`/keystroke-by-keystroke) so the debounce test can fire
// several distinct input values in a tight loop and assert on the number
// of resulting endpoint calls precisely -- see that test's own comment.
//
// WP-F01 gave modules 3 and 4 real backend wildcard-search routes too, so
// they moved out of the "not available" describe block below and into the
// same real-search coverage as 1, 2 and 5. Only module 6 (releases) still
// has no config and exercises the `!config` branch.

jest.mock('../../../api/apiCalls', () => ({
    getWCTCList: jest.fn(),
    getWCReqList: jest.fn(),
    getWCDefectList: jest.fn(),
    getWCPlanList: jest.fn(),
    getWCRunList: jest.fn(),
}));

const mockGetWCTCList = getWCTCList as jest.Mock;
const mockGetWCReqList = getWCReqList as jest.Mock;
const mockGetWCDefectList = getWCDefectList as jest.Mock;
const mockGetWCPlanList = getWCPlanList as jest.Mock;
const mockGetWCRunList = getWCRunList as jest.Mock;

function renderPanel(module: 1 | 2 | 3 | 4 | 5 | 6) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let latestTabs: ReturnType<typeof useWorkbench<Array<{ key: string; module: number; entityId: string; title: string }>>> = [];
    let latestSelection: string | null = null;
    function Harness() {
        latestTabs = useWorkbench((s) => s.tabs);
        latestSelection = useWorkbench((s) => s.selection[module]);
        return <EntitySearchPanel module={module} />;
    }
    render(
        <QueryClientProvider client={client}>
            <WorkbenchStoreProvider projectId={1}>
                <Harness />
            </WorkbenchStoreProvider>
        </QueryClientProvider>,
    );
    return { getTabs: () => latestTabs, getSelection: () => latestSelection };
}

beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
});

describe('EntitySearchPanel — modules with real wildcard search (1, 2, 3, 4, 5)', () => {
    it('shows a prompt and calls no endpoint when the query is empty', () => {
        renderPanel(1);
        expect(screen.getByText(/type to search/i)).toBeInTheDocument();
        expect(mockGetWCTCList).not.toHaveBeenCalled();
    });

    it('debounces: a burst of keystrokes calls the module endpoint once, with only the final text', async () => {
        mockGetWCTCList.mockResolvedValue([]);
        renderPanel(1);
        const input = screen.getByRole('searchbox', { name: /search test cases/i });

        // Four rapid keystrokes, fired synchronously -- exactly what would
        // happen typing "test" quickly. Debouncing must collapse these into
        // ONE request for the final value, not four (one per keystroke).
        fireEvent.change(input, { target: { value: 't' } });
        fireEvent.change(input, { target: { value: 'te' } });
        fireEvent.change(input, { target: { value: 'tes' } });
        fireEvent.change(input, { target: { value: 'test' } });

        // Give it more than the debounce window and confirm it settled at
        // exactly one call -- if debouncing were absent (or broken), this
        // would already be 4.
        await waitFor(() => expect(mockGetWCTCList).toHaveBeenCalledTimes(1));
        expect(mockGetWCTCList).toHaveBeenCalledWith('test');
    });

    it('renders results for module 1 (test cases) via getWCTCList', async () => {
        mockGetWCTCList.mockResolvedValue([
            { _id: 'm1', TestCaseId: 'TC-104', TestCaseSummary: 'Login works', projectId: 1 },
        ]);
        renderPanel(1);
        const input = screen.getByRole('searchbox', { name: /search test cases/i });
        fireEvent.change(input, { target: { value: 'login' } });

        expect(await screen.findByRole('button', { name: /TC-104.*Login works/i })).toBeInTheDocument();
        expect(mockGetWCTCList).toHaveBeenCalledWith('login');
    });

    it('selecting a test-case result opens a tab keyed by module 1 + the result id, and sets selection', async () => {
        mockGetWCTCList.mockResolvedValue([
            { _id: 'm1', TestCaseId: 'TC-104', TestCaseSummary: 'Login works', projectId: 1 },
        ]);
        const { getTabs, getSelection } = renderPanel(1);
        const input = screen.getByRole('searchbox', { name: /search test cases/i });
        fireEvent.change(input, { target: { value: 'login' } });

        const result = await screen.findByRole('button', { name: /TC-104.*Login works/i });
        await userEvent.click(result);

        const tabs = getTabs();
        expect(tabs).toHaveLength(1);
        expect(tabs[0].module).toBe(1);
        expect(tabs[0].entityId).toBe('TC-104');
        expect(tabs[0].title).toBe('TC-104');
        expect(tabs[0].key).toBe(tabKey(1, 'TC-104'));
        expect(getSelection()).toBe('TC-104');
    });

    it('renders results for module 2 (requirements) via getWCReqList', async () => {
        mockGetWCReqList.mockResolvedValue([
            { _id: 'm2', reqId: 'REQ-8', requirementSummary: 'Must log in', projectId: 1 },
        ]);
        renderPanel(2);
        const input = screen.getByRole('searchbox', { name: /search requirements/i });
        fireEvent.change(input, { target: { value: 'log' } });

        expect(await screen.findByRole('button', { name: /REQ-8.*Must log in/i })).toBeInTheDocument();
        expect(mockGetWCReqList).toHaveBeenCalledWith('log');
    });

    it('renders results for module 5 (defects) via getWCDefectList', async () => {
        mockGetWCDefectList.mockResolvedValue([
            { _id: 'm5', defectId: 'DEF-3', summary: 'Login button broken', projectId: 1 },
        ]);
        renderPanel(5);
        const input = screen.getByRole('searchbox', { name: /search defects/i });
        fireEvent.change(input, { target: { value: 'broken' } });

        expect(await screen.findByRole('button', { name: /DEF-3.*Login button broken/i })).toBeInTheDocument();
        expect(mockGetWCDefectList).toHaveBeenCalledWith('broken');
    });

    it('renders results for module 3 (test plans) via getWCPlanList', async () => {
        mockGetWCPlanList.mockResolvedValue([
            { _id: 'm3', TestPlanId: 'PLN-3', objective: 'Verify login', projectId: 1 },
        ]);
        renderPanel(3);
        const input = screen.getByRole('searchbox', { name: /search test plans/i });
        fireEvent.change(input, { target: { value: 'login' } });

        expect(await screen.findByRole('button', { name: /PLN-3.*Verify login/i })).toBeInTheDocument();
        expect(mockGetWCPlanList).toHaveBeenCalledWith('login');
    });

    it('renders results for module 4 (test runs) via getWCRunList, with no assignee line', async () => {
        // Ruling 2 (WP-F01): assignedTo is a Keycloak UUID, not a name, so
        // it must never reach the result line -- only the run id shows.
        mockGetWCRunList.mockResolvedValue([
            { _id: 'm4', TestExecutionId: 'Run-7', assignedTo: 'c16a3041-919f-482f-a027-0b18060aa536', projectId: 1 },
        ]);
        renderPanel(4);
        const input = screen.getByRole('searchbox', { name: /search test runs/i });
        fireEvent.change(input, { target: { value: 'Run-7' } });

        const result = await screen.findByRole('button', { name: /^Run-7$/ });
        expect(result).toBeInTheDocument();
        expect(result.textContent).not.toContain('c16a3041');
        expect(mockGetWCRunList).toHaveBeenCalledWith('Run-7');
    });

    it('shows a no-matches state when the search resolves empty', async () => {
        mockGetWCTCList.mockResolvedValue([]);
        renderPanel(1);
        const input = screen.getByRole('searchbox', { name: /search test cases/i });
        fireEvent.change(input, { target: { value: 'zzz' } });

        expect(await screen.findByText(/no.*match.*zzz/i)).toBeInTheDocument();
    });

    it('shows an error state with a retry action when the search fails, and retry re-issues the search', async () => {
        mockGetWCTCList.mockRejectedValueOnce(new Error('network down'));
        mockGetWCTCList.mockResolvedValueOnce([
            { _id: 'm1', TestCaseId: 'TC-1', TestCaseSummary: 'Recovered', projectId: 1 },
        ]);
        renderPanel(1);
        const input = screen.getByRole('searchbox', { name: /search test cases/i });
        fireEvent.change(input, { target: { value: 'x' } });

        const retryButton = await screen.findByRole('button', { name: /retry/i });
        expect(screen.getByText(/unable to search/i)).toBeInTheDocument();

        await userEvent.click(retryButton);

        expect(await screen.findByRole('button', { name: /TC-1.*Recovered/i })).toBeInTheDocument();
    });
});

describe('EntitySearchPanel — modules with no backend wildcard search (6)', () => {
    it('module 6 shows "not available" and calls no endpoint at all', () => {
        renderPanel(6);
        expect(screen.getByText(/search is not available/i)).toBeInTheDocument();
        expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
        expect(mockGetWCTCList).not.toHaveBeenCalled();
        expect(mockGetWCReqList).not.toHaveBeenCalled();
        expect(mockGetWCDefectList).not.toHaveBeenCalled();
        expect(mockGetWCPlanList).not.toHaveBeenCalled();
        expect(mockGetWCRunList).not.toHaveBeenCalled();
    });
});
