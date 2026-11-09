import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import theme from '../../../Theme/theme';
import { LinkIssues } from '../linkissue';
import { createLink, getLinkedIssuesApi } from '../../../api/apiCalls';
import * as linkApi from '../../../api/linkApi';

// WP-141 -- the UI surface for an external (Jira) link (GR-4). The backend
// stores it as ONE row, entity -> `jira:<KEY>`, with destinationModule 100
// (linkIssueService/utils/externalLink.js). Two properties matter here:
// the panel sends that shape (and never the mirrored reverse write internal
// links get -- there is no Jira-side record to point back from), and an
// existing external link reads as a Jira key, not as `jira:ACME-1` / "100".

jest.mock('../../../api/apiCalls', () => ({
    getLinkedIssuesApi: jest.fn(),
    createLink: jest.fn(),
    deleteLinkcAPI: jest.fn(),
    getWCDefectList: jest.fn(),
    getWCReqList: jest.fn(),
    getWCTCList: jest.fn()
}));

jest.mock('../../../api/linkApi', () => {
    const actual = jest.requireActual('../../../api/linkApi');
    return {
        ...actual,
        getUntestedRequirements: jest.fn(),
        getOrphanTestCases: jest.fn(),
    };
});

const mockGetLinkedIssues = getLinkedIssuesApi as jest.Mock;
const mockCreateLink = createLink as jest.Mock;

const JIRA_ROW = {
    _id: 'link-jira',
    id: 2,
    sourceId: 'Bug-7',
    destinationId: 'jira:ACME-123',
    destinationModule: 100,
    external: { provider: 'jira', key: 'ACME-123' },
    summary: 'Safari login button',
    linkType: 'relates-to'
};

function renderLinkIssues() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <ThemeProvider theme={theme}>
                <LinkIssues srcModule={5} summary="Defect summary" issueId="Bug-7" />
            </ThemeProvider>
        </QueryClientProvider>
    );
}

async function chooseIssueType(name: string) {
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Issue type' }));
    fireEvent.click(await screen.findByRole('option', { name }));
}

async function chooseLinkType(name: string) {
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Link type' }));
    fireEvent.click(await screen.findByRole('option', { name }));
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetLinkedIssues.mockResolvedValue([]);
    (linkApi.getUntestedRequirements as jest.Mock).mockResolvedValue([]);
    (linkApi.getOrphanTestCases as jest.Mock).mockResolvedValue([]);
});

it('shows an existing Jira link by its key and provider, not its storage id', async () => {
    mockGetLinkedIssues.mockResolvedValue([JIRA_ROW]);
    renderLinkIssues();
    expect(await screen.findByText('ACME-123 : Safari login button')).toBeInTheDocument();
    expect(screen.getByText('Jira')).toBeInTheDocument();
    expect(screen.queryByText(/jira:ACME-123/)).not.toBeInTheDocument();
});

it('links a Jira issue by key with a single write in the external shape', async () => {
    mockCreateLink.mockResolvedValue({ ...JIRA_ROW, summary: 'Checkout crash' });
    renderLinkIssues();
    await waitFor(() => expect(mockGetLinkedIssues).toHaveBeenCalled());

    await chooseIssueType('Jira issue');
    fireEvent.change(screen.getByRole('textbox', { name: 'Jira issue key' }), { target: { value: 'acme-123' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Jira issue summary' }), { target: { value: 'Checkout crash' } });
    await chooseLinkType('relates-to');
    fireEvent.click(screen.getByRole('button', { name: /link/i }));

    await waitFor(() => expect(mockCreateLink).toHaveBeenCalledTimes(1));
    expect(mockCreateLink).toHaveBeenCalledWith({
        sourceId: 'Bug-7',
        srcSummary: 'Defect summary',
        srcModule: 5,
        destinationModule: 100,
        external: { provider: 'jira', key: 'ACME-123' },
        summary: 'Checkout crash',
        linkType: 'relates-to'
    });
    // No mirrored reverse write: there is no Jira-side record to link from.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockCreateLink).toHaveBeenCalledTimes(1);
});

it('keeps Link disabled until the key looks like a Jira key', async () => {
    renderLinkIssues();
    await waitFor(() => expect(mockGetLinkedIssues).toHaveBeenCalled());
    await chooseIssueType('Jira issue');
    await chooseLinkType('relates-to');
    const key = screen.getByRole('textbox', { name: 'Jira issue key' });
    const linkButton = screen.getByRole('button', { name: /link/i });

    fireEvent.change(key, { target: { value: 'not a key' } });
    expect(linkButton).toBeDisabled();
    expect(screen.getByText(/like ACME-123/)).toBeInTheDocument();

    fireEvent.change(key, { target: { value: 'ACME-9' } });
    expect(linkButton).not.toBeDisabled();
});

it('shows the server error when linking fails', async () => {
    mockCreateLink.mockRejectedValue({ response: { data: { error: 'Duplicate field value entered' } } });
    renderLinkIssues();
    await waitFor(() => expect(mockGetLinkedIssues).toHaveBeenCalled());
    await chooseIssueType('Jira issue');
    fireEvent.change(screen.getByRole('textbox', { name: 'Jira issue key' }), { target: { value: 'ACME-1' } });
    await chooseLinkType('relates-to');
    fireEvent.click(screen.getByRole('button', { name: /link/i }));
    expect(await screen.findByText('Duplicate field value entered')).toBeInTheDocument();
    const grid = screen.getByRole('grid');
    expect(within(grid).queryByText(/ACME-1/)).not.toBeInTheDocument();
});
