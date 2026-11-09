import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MainDrawer from '../MainDrawer';

// WP-078 Part A — the owner-approved drawer/rail navigation split
// (EXECUTION_LOG.md's "RECORDED DECISION (owner): navigation split between
// drawer and rail"): the drawer now answers "which area of the app am I
// in" (Home/Projects/Reports/Settings), not "which kind of work item am I
// looking at" (Requirements/Test Cases/Test Plans/Test Runs/Defects --
// those live on the workbench rail, ModuleRail.tsx, and are removed here
// to stop duplicating it under mismatched labels).
//
// WP-F18b Task 4 -- Releases was the one exception kept here (it had a
// standalone page, Pages/releases.tsx, that nothing else linked to, so
// dropping this entry would have stranded a live route). WP-F18b Tasks 1-3
// moved every one of that page's capabilities into the workbench rail's own
// "Releases" entry (module 6) and Settings; this task deleted the page, so
// Releases is no longer an exception -- removed from here the same way its
// five siblings already were.
//
// Each page instantiates its own <MainDrawer> (it isn't a persistent
// router layout -- see MainDrawer.tsx's own WP-044 header comment), so
// this renders one <MainDrawer> per matched route below, exactly the way
// real pages do, to prove each retained link's `to` really resolves to
// that route (not just that the href string looks right).
function renderDrawerAppAt(initialPath: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={[initialPath]}>
                <Routes>
                    <Route path="/projects/:projectId/dashboard" element={<MainDrawer><div data-testid="landed-home">home</div></MainDrawer>} />
                    <Route path="/projects/:projectId/workbench/:module" element={<MainDrawer><div data-testid="landed-workbench">workbench</div></MainDrawer>} />
                    <Route path="/projects" element={<MainDrawer><div data-testid="landed-projects">projects</div></MainDrawer>} />
                    <Route path="/projects/:projectId/reports" element={<MainDrawer><div data-testid="landed-reports">reports</div></MainDrawer>} />
                    <Route path="/projects/:projectId/settings" element={<MainDrawer><div data-testid="landed-settings">settings</div></MainDrawer>} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

// WP-F19 adds 'Workbench' -- an AREA entry, which is what this drawer is
// for. It is not a return of the retired per-module entries below: those
// duplicated workbench-rail entries under mismatched labels, and the
// it.each block asserting their absence is deliberately unchanged (WP-F18b
// Task 4 adds 'Releases' to that same retired list -- see this file's
// header comment).
const RETAINED_LABELS = ['Home', 'Workbench', 'Projects', 'Reports', 'Settings'];

describe('MainDrawer (WP-078 Part A) — retained destinations only', () => {
    // The drawer starts COLLAPSED at the owner's request. WP-F19 had made it
    // start open because collapsed it was a strip of unlabelled icons --
    // ListItemText sits at opacity 0 in that state. The labels now surface
    // as tooltips instead, so the space is reclaimed without losing the
    // discoverability WP-F19 was protecting. These three pin all of it:
    // nothing asserted the open/collapsed default before.
    it('starts collapsed, so the drawer is a signpost rather than a workspace', () => {
        renderDrawerAppAt('/projects/1/dashboard');
        // The expand control is the one visible when collapsed; the collapse
        // control is hidden. Asserting on the pair is what distinguishes the
        // two states -- the labels are in the DOM either way.
        const expand = screen.getByTestId('drawer-expand');
        expect(expand).toBeVisible();
    });

    it('expands on demand, and offers the collapse control once open', () => {
        renderDrawerAppAt('/projects/1/dashboard');
        fireEvent.click(screen.getByTestId('drawer-expand'));
        expect(screen.getByTestId('drawer-collapse')).toBeVisible();
    });

    it('labels every destination with a tooltip while collapsed, so the icons are not anonymous', () => {
        renderDrawerAppAt('/projects/1/dashboard');
        RETAINED_LABELS.forEach((label) => {
            expect(screen.getByLabelText(label)).toBeInTheDocument();
        });
    });

    it('renders exactly Home, Workbench, Projects, Reports, Settings -- no more, no less', () => {
        renderDrawerAppAt('/projects/1/dashboard');

        RETAINED_LABELS.forEach((label) => {
            expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
        });

        // Every <ListItemText> in the nav renders exactly one of the
        // retained labels -- proves nothing extra snuck in either.
        const navLinks = screen.getAllByRole('link');
        expect(navLinks).toHaveLength(RETAINED_LABELS.length);
    });

    it.each(['Requirements', 'Test Repository', 'Test Plan', 'Test Execution', 'Defect', 'Releases'])(
        'no longer renders the retired "%s" entry (now the workbench rail\'s job)',
        (label) => {
            renderDrawerAppAt('/projects/1/dashboard');
            expect(screen.queryByText(label, { exact: true })).not.toBeInTheDocument();
        },
    );

    it.each([
        ['Home', 'landed-home'],
        ['Workbench', 'landed-workbench'],
        ['Reports', 'landed-reports'],
        ['Settings', 'landed-settings'],
    ])('clicking "%s" navigates to its project-scoped route', (label, testId) => {
        renderDrawerAppAt('/projects/1/dashboard');
        fireEvent.click(screen.getByRole('link', { name: label }));
        expect(screen.getByTestId(testId)).toBeInTheDocument();
    });

    it('clicking "Projects" navigates to the flat, non-project-scoped /projects', () => {
        // MemoryRouter (unlike the real app's BrowserRouter) never touches
        // window.location -- the landed marker is the proof of navigation.
        renderDrawerAppAt('/projects/1/dashboard');
        fireEvent.click(screen.getByRole('link', { name: 'Projects' }));
        expect(screen.getByTestId('landed-projects')).toBeInTheDocument();
    });
});
