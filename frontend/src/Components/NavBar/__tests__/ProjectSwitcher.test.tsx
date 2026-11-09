import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import { MemoryRouter, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import theme from '../../../Theme/theme';
import ProjectSwitcher from '../ProjectSwitcher';
import { getProjects, Project } from '../../../api/projectApi';

// WP-044 — proves the project switcher's multi-project path. The real
// deployment this WP was verified against has exactly one seeded project
// (numeric id 1, key "default" — see EXECUTION_LOG.md), which makes a
// switcher easy to build but impossible to exercise against live data
// without creating a second project. Rather than mutate shared
// environment state for a UI test, getProjects() is mocked to return two
// projects here (the same technique ViewSwitcher.test.tsx already uses
// for savedViewApi) -- this is the primary proof of the switcher's
// multi-project behavior; EXECUTION_LOG.md's WP-044 report also records a
// live create-second-project/switch/cleanup pass against the running
// backend.

jest.mock('../../../api/projectApi', () => {
    const actual = jest.requireActual('../../../api/projectApi');
    return { ...actual, getProjects: jest.fn() };
});

const mockGetProjects = getProjects as jest.Mock;

const PROJECT_ONE: Project = {
    _id: 'mongo-1',
    id: 1,
    name: 'Default Project',
    key: 'default',
    organizationId: 'org-1',
    status: 'active',
    createdBy: 'seed',
    members: []
};

const PROJECT_TWO: Project = {
    _id: 'mongo-2',
    id: 2,
    name: 'Second Project',
    key: 'second',
    organizationId: 'org-1',
    status: 'active',
    createdBy: 'seed',
    members: []
};

// ProjectSwitcher reads useParams()/useSearchParams() itself -- in the
// real app it's rendered from inside MainDrawer, which every
// project-scoped page renders from within its own matched <Route> (nested
// under ProjectRouteLayout's Outlet), so it always has route params in
// scope. Rendering it as a *sibling* of <Routes> (outside any matched
// route) would give it no params at all, unlike the real app -- this
// wrapper renders it alongside the "landed" marker inside the same
// matched route, matching how it's actually mounted.
function ProjectScopedPage() {
    const { projectId } = useParams<{ projectId: string }>();
    const [searchParams] = useSearchParams();
    return (
        <>
            <ProjectSwitcher />
            <div data-testid="landed">
                projectId={projectId} status={searchParams.get('status') ?? '(none)'}
            </div>
        </>
    );
}

function renderSwitcherAt(initialPath: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <MemoryRouter initialEntries={[initialPath]}>
                    <Routes>
                        <Route path="/projects/:projectId/*" element={<ProjectScopedPage />} />
                        <Route
                            path="/projects"
                            element={
                                <>
                                    <ProjectSwitcher />
                                    <div data-testid="projects-list">projects list</div>
                                </>
                            }
                        />
                    </Routes>
                </MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetProjects.mockResolvedValue([PROJECT_ONE, PROJECT_TWO]);
});

describe('ProjectSwitcher (WP-044)', () => {
    it('renders nothing off a project-scoped route (e.g. the org-wide /projects list)', () => {
        renderSwitcherAt('/projects');
        expect(screen.getByTestId('projects-list')).toBeInTheDocument();
        expect(screen.queryByLabelText('Switch project')).not.toBeInTheDocument();
    });

    it('lists every project from the API, with the route\'s current project selected', async () => {
        renderSwitcherAt('/projects/1/testexecution');
        await waitFor(() => expect(mockGetProjects).toHaveBeenCalled());
        expect(await screen.findByText('Default Project')).toBeInTheDocument();
    });

    it('switching to a different project navigates there, preserving the current sub-route and query string', async () => {
        renderSwitcherAt('/projects/1/testexecution?status=fail');
        await waitFor(() => expect(mockGetProjects).toHaveBeenCalled());
        expect(screen.getByTestId('landed')).toHaveTextContent('projectId=1');
        expect(screen.getByTestId('landed')).toHaveTextContent('status=fail');

        fireEvent.mouseDown(screen.getByLabelText('Switch project'));
        fireEvent.click(await screen.findByRole('option', { name: 'Second Project' }));

        await waitFor(() => expect(screen.getByTestId('landed')).toHaveTextContent('projectId=2'));
        // The sub-route (/testexecution) and query string (?status=fail)
        // survive the switch -- this is the "preserves current sub-route"
        // half of ProjectSwitcher.tsx's own contract, not just a bare
        // dashboard redirect.
        expect(screen.getByTestId('landed')).toHaveTextContent('status=fail');
    });

    it('switching to a different project from a bare project route (no sub-path) lands cleanly, not on a malformed path', async () => {
        renderSwitcherAt('/projects/1/');
        await waitFor(() => expect(mockGetProjects).toHaveBeenCalled());

        fireEvent.mouseDown(screen.getByLabelText('Switch project'));
        fireEvent.click(await screen.findByRole('option', { name: 'Second Project' }));

        await waitFor(() => expect(screen.getByTestId('landed')).toHaveTextContent('projectId=2'));
    });
});
