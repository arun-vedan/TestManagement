import { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { useParams } from 'react-router-dom';
import App from '../App';
import { getCurrentProjectId, setCurrentProjectId, DEFAULT_PROJECT_ID } from '../currentProject';

// WP-044 — end-to-end proof of App.tsx's own route table: every
// project-scoped route mounts the right page on a deep link, every old
// flat path redirects to the equivalent project-scoped route, /projects
// (org-wide, not project-scoped) is untouched, and Settings' nested tabs
// deep-link correctly. This is the strongest proof available without a
// real browser (see the WP brief's own "no browser available" hazard) --
// it renders the actual App component and its actual route table, not a
// re-description of it.
//
// Every heavy page is mocked to a trivial marker (same pattern
// Pages/dashboard/__tests__/dashboard.test.tsx uses for MainLayout) --
// this file is about ROUTING, not any individual page's internals, which
// have their own test suites. App.tsx hardcodes <BrowserRouter>, so
// window.history.pushState() before each render is what selects the
// initial deep link (the same mechanism a real browser uses to load a
// URL); MemoryRouter can't be substituted in without changing App.tsx.

// Prefixed "mock" deliberately -- jest hoists jest.mock() factories above
// this file's other top-level declarations, and only refuses to let them
// close over an out-of-scope variable unless its name starts with "mock"
// (case-insensitive), which is exactly the case here.
function mockMarkerFor(name: string) {
    return function Marker() {
        const params = useParams<{ projectId?: string }>();
        return <div data-testid={`page-${name}`}>{name} projectId={params.projectId ?? '(none)'}</div>;
    };
}

jest.mock('../Pages/dashboard', () => ({ __esModule: true, default: mockMarkerFor('dashboard') }));
jest.mock('../Pages/reports', () => ({ __esModule: true, default: mockMarkerFor('reports') }));
jest.mock('../workbench/Workbench', () => ({ __esModule: true, default: mockMarkerFor('workbench') }));
jest.mock('../Pages/projects', () => ({ __esModule: true, default: mockMarkerFor('projects-list') }));
jest.mock('../Pages/profile', () => ({ __esModule: true, default: mockMarkerFor('profile') }));
jest.mock('../Pages/Page404', () => ({ __esModule: true, default: mockMarkerFor('404') }));

// SettingsShell itself is real (URL-driven Tabs + Outlet) -- only its tab
// bodies are mocked, so this proves settings' own nested deep-linking too.
jest.mock('../Pages/settings/MembersTab', () => ({ __esModule: true, default: mockMarkerFor('settings-members') }));
jest.mock('../Pages/settings/ApiKeysTab', () => ({ __esModule: true, default: mockMarkerFor('settings-apikeys') }));
jest.mock('../Pages/settings/AuditTab', () => ({ __esModule: true, default: mockMarkerFor('settings-audit') }));
// Wave D-1 -- Fields is a real tab now (Components/settings/FieldsPanel.tsx
// via Pages/settings/FieldsTab.tsx), no longer ReservedTab. Only Modules
// and Folders still render through the generic reserved-tab mock below.
jest.mock('../Pages/settings/FieldsTab', () => ({ __esModule: true, default: mockMarkerFor('settings-fields') }));
jest.mock('../Pages/settings/EnvironmentsTab', () => ({ __esModule: true, default: mockMarkerFor('settings-environments') }));
jest.mock('../Pages/settings/ReservedTab', () => ({
    __esModule: true,
    default: ({ label }: { label: string }) => <div data-testid={`page-settings-reserved-${label.toLowerCase()}`}>{label}</div>
}));

// App.tsx pulls <DndProvider> in at the top level for the workbench tree's
// drag/drop (workbench/tree/EntityTree.tsx et al -- WP-078 moved its
// backend from @minoru/react-dnd-treeview's MultiBackend to plain
// react-dnd-html5-backend's HTML5Backend), nothing this routing test
// exercises. Trivial passthrough mock, same reasoning as mocking the page
// components above: this file is about the route table, not drag/drop.
jest.mock('react-dnd', () => ({
    __esModule: true,
    DndProvider: ({ children }: { children: ReactNode }) => <>{children}</>
}));

function renderAppAt(path: string) {
    window.history.pushState({}, '', path);
    return render(<App />);
}

beforeEach(() => {
    setCurrentProjectId(DEFAULT_PROJECT_ID);
});

describe('App route table (WP-044) — deep links into every project-scoped route', () => {
    it.each([
        ['/projects/1/dashboard', 'page-dashboard'],
        ['/projects/1/reports', 'page-reports'],
        // WP-072 -- the new workbench shell, shipped alongside these
        // routes rather than replacing any of them (strangler approach).
        ['/projects/1/workbench/testcases', 'page-workbench']
    ])('%s deep-links straight to %s, with projectId threaded from the route', (path, testId) => {
        renderAppAt(path);
        expect(screen.getByTestId(testId)).toHaveTextContent('projectId=1');
    });

    // WP-F18b Task 4 -- Releases' own project-scoped page (Pages/
    // releases.tsx) is retired; this route now redirects straight into the
    // workbench instead of rendering a page component (there is no
    // `page-releases` marker to mock any more), the same shape as
    // requirements/testrepo/testplan/testexecution/defects below.
    it('/projects/1/releases redirects to the workbench Releases module, with projectId preserved', () => {
        renderAppAt('/projects/1/releases');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent('projectId=1');
        expect(window.location.pathname).toBe('/projects/1/workbench/releases');
    });

    // WP-075 -- Requirements' own project-scoped page is retired; this
    // route now redirects straight into the workbench instead of
    // rendering a page component (there is no `page-requirements` marker
    // to mock any more).
    it('/projects/1/requirements redirects to the workbench Requirements module, with projectId preserved', () => {
        renderAppAt('/projects/1/requirements');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent('projectId=1');
        expect(window.location.pathname).toBe('/projects/1/workbench/requirements');
    });

    // WP-074 Step 7 -- Test Cases' own project-scoped page is retired;
    // this route now redirects straight into the workbench instead of
    // rendering a page component (there is no `page-testrepo` marker to
    // mock any more).
    it('/projects/1/testrepo redirects to the workbench Test Cases module, with projectId preserved', () => {
        renderAppAt('/projects/1/testrepo');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent('projectId=1');
        expect(window.location.pathname).toBe('/projects/1/workbench/testcases');
    });

    // WP-076 -- Test Plans' own project-scoped page is retired; this route
    // now redirects straight into the workbench instead of rendering a page
    // component (there is no `page-testplan` marker to mock any more).
    it('/projects/1/testplan redirects to the workbench Test Plans module, with projectId preserved', () => {
        renderAppAt('/projects/1/testplan');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent('projectId=1');
        expect(window.location.pathname).toBe('/projects/1/workbench/testplans');
    });

    // WP-076 -- Test Execution's own project-scoped page is retired; this
    // route now redirects straight into the workbench instead of rendering a
    // page component (there is no `page-testexecution` marker to mock any
    // more).
    it('/projects/1/testexecution redirects to the workbench Test Runs module, with projectId preserved', () => {
        renderAppAt('/projects/1/testexecution');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent('projectId=1');
        expect(window.location.pathname).toBe('/projects/1/workbench/testruns');
    });

    // WP-077 -- Defects' own project-scoped page is retired; this route now
    // redirects straight into the workbench instead of rendering a page
    // component (there is no `page-defects` marker to mock any more).
    it('/projects/1/defects redirects to the workbench Defects module, with projectId preserved', () => {
        renderAppAt('/projects/1/defects');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent('projectId=1');
        expect(window.location.pathname).toBe('/projects/1/workbench/defects');
    });

    // WP-078 Part A — Workbench.tsx used to be rendered directly by this
    // route with no MainLayout, so there was no way out to Home/Projects/
    // Reports/Settings from it ("the workbench is currently a dead end").
    // App.tsx now wraps this one route in <MainLayout fillHeight>. Workbench
    // itself is mocked to a marker in this file (routing-only concern), but
    // MainLayout is NOT mocked, so its real MainDrawer renders here,
    // proving the route itself supplies the chrome rather than relying on
    // Workbench.tsx to do it.
    it('the workbench route renders inside the app chrome (MainDrawer), not as a bare page', () => {
        renderAppAt('/projects/1/workbench/testcases');
        expect(screen.getByTestId('page-workbench')).toBeInTheDocument();
        // WP-F18b Task 4 -- 'Releases' dropped off this list along with its
        // own drawer entry (MainDrawer.tsx); the workbench rail is now its
        // only nav entry point, same as every other module.
        ['Home', 'Projects', 'Reports', 'Settings'].forEach((label) => {
            expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
        });
    });

    it('a bare /projects/:projectId (no sub-path) redirects to that project\'s dashboard', () => {
        renderAppAt('/projects/3');
        expect(screen.getByTestId('page-dashboard')).toHaveTextContent('projectId=3');
    });

    // WP-F18b Task 4 -- was a direct-render assertion against `page-releases`
    // before this task retired that page; now proves the same thing the
    // requirements/testrepo/testplan/testexecution/defects redirect chains
    // below prove -- a non-default project's id survives the redirect into
    // the workbench, not just a direct render.
    it('deep-links to a non-default project carry that project\'s id through the releases redirect, not the default', () => {
        renderAppAt('/projects/7/releases');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent('projectId=7');
        expect(window.location.pathname).toBe('/projects/7/workbench/releases');
        expect(getCurrentProjectId()).toBe(7);
    });
});

describe('App route table (WP-044) — Settings nested tabs deep-link', () => {
    it('a bare .../settings redirects to the Members tab', () => {
        renderAppAt('/projects/1/settings');
        expect(screen.getByTestId('page-settings-members')).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Members', selected: true })).toBeInTheDocument();
    });

    it.each([
        ['/projects/1/settings/members', 'page-settings-members', 'Members'],
        ['/projects/1/settings/apikeys', 'page-settings-apikeys', 'API Keys'],
        ['/projects/1/settings/audit', 'page-settings-audit', 'Audit Log'],
        ['/projects/1/settings/fields', 'page-settings-fields', 'Fields'],
        ['/projects/1/settings/environments', 'page-settings-environments', 'Environments']
    ])('%s deep-links to its tab body and shows %s selected', (path, testId, tabLabel) => {
        renderAppAt(path);
        expect(screen.getByTestId(testId)).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: tabLabel, selected: true })).toBeInTheDocument();
    });

    // Modules and Folders were removed from the tab strip at the owner's
    // request -- both were reserved stubs, and a Modules tab in particular
    // would have administered a collection nothing reads (see settings/
    // index.tsx). They are HIDDEN, not deleted: the routes still resolve, so
    // an existing bookmark does not 404 and re-enabling is a one-line change.
    //
    // This asserts exactly that split -- body still reachable, no tab offered
    // -- rather than deleting the old cases, which would have left the
    // hidden-vs-deleted distinction untested and free to rot either way.
    it.each([
        ['/projects/1/settings/modules', 'page-settings-reserved-modules', 'Modules'],
        ['/projects/1/settings/folders', 'page-settings-reserved-folders', 'Folders']
    ])('%s still resolves, but offers no tab', (path, testId, tabLabel) => {
        renderAppAt(path);
        expect(screen.getByTestId(testId)).toBeInTheDocument();
        expect(screen.queryByRole('tab', { name: tabLabel })).not.toBeInTheDocument();
    });
});

describe('App route table (WP-044) — old bookmarks redirect', () => {
    it.each([
        ['/', 'page-dashboard', 'dashboard'],
        ['/dashboard', 'page-dashboard', 'dashboard']
    ])('old bookmark %s redirects to the %s page under the active project', (oldPath, testId) => {
        setCurrentProjectId(5);
        renderAppAt(oldPath);
        expect(screen.getByTestId(testId)).toHaveTextContent('projectId=5');
    });

    // WP-F18b Task 4 -- proves the CHAIN still resolves now that the
    // project-scoped `releases` route itself redirects onward: flat
    // /releases -> LegacyRedirect (unchanged) -> /projects/:id/releases ->
    // WorkbenchModuleRedirect (App.tsx, this WP) ->
    // /projects/:id/workbench/releases. Same shape as the requirements/
    // testrepo/testplan/testexecution/defects chains below, added when this
    // task retired the last page rendered directly off a project-scoped
    // route (there is no `page-releases` marker left to mock).
    it('old /releases bookmark chains through the project-scoped redirect into the workbench', () => {
        setCurrentProjectId(5);
        renderAppAt('/releases');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent('projectId=5');
        expect(window.location.pathname).toBe('/projects/5/workbench/releases');
    });

    // WP-075 -- proves the CHAIN still resolves now that the project-scoped
    // `requirements` route itself redirects onward: flat /requirements ->
    // LegacyRedirect (unchanged) -> /projects/:id/requirements ->
    // WorkbenchModuleRedirect (App.tsx, this WP) ->
    // /projects/:id/workbench/requirements. A single render of <App>
    // follows both redirects (react-router resolves nested <Navigate>
    // renders within one commit here), so this is one assertion on the
    // FINAL landing spot, not two separate hops.
    it('old /requirements bookmark chains through the project-scoped redirect into the workbench', () => {
        setCurrentProjectId(5);
        renderAppAt('/requirements');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent('projectId=5');
        expect(window.location.pathname).toBe('/projects/5/workbench/requirements');
    });

    // WP-074 Step 7 -- proves the CHAIN still resolves now that the
    // project-scoped `testrepo` route itself redirects onward: flat
    // /testrepo -> LegacyRedirect (unchanged) -> /projects/:id/testrepo ->
    // WorkbenchModuleRedirect (App.tsx, generalised in WP-075) ->
    // /projects/:id/workbench/testcases. A single render of <App> follows
    // both redirects (react-router resolves nested <Navigate> renders
    // within one commit here), so this is one assertion on the FINAL
    // landing spot, not two separate hops.
    it('old /testrepo bookmark chains through the project-scoped redirect into the workbench', () => {
        setCurrentProjectId(5);
        renderAppAt('/testrepo');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent('projectId=5');
        expect(window.location.pathname).toBe('/projects/5/workbench/testcases');
    });

    // WP-076 -- proves the CHAIN still resolves now that the project-scoped
    // `testplan` route itself redirects onward: flat /testplan ->
    // LegacyRedirect (unchanged) -> /projects/:id/testplan ->
    // WorkbenchModuleRedirect (App.tsx, this WP) ->
    // /projects/:id/workbench/testplans. A single render of <App> follows
    // both redirects (react-router resolves nested <Navigate> renders
    // within one commit here), so this is one assertion on the FINAL
    // landing spot, not two separate hops.
    it('old /testplan bookmark chains through the project-scoped redirect into the workbench', () => {
        setCurrentProjectId(5);
        renderAppAt('/testplan');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent('projectId=5');
        expect(window.location.pathname).toBe('/projects/5/workbench/testplans');
    });

    // WP-076 -- proves the CHAIN still resolves now that the project-scoped
    // `testexecution` route itself redirects onward: flat /testexecution ->
    // LegacyRedirect (unchanged) -> /projects/:id/testexecution ->
    // WorkbenchModuleRedirect (App.tsx, this WP) ->
    // /projects/:id/workbench/testruns. A single render of <App> follows
    // both redirects (react-router resolves nested <Navigate> renders
    // within one commit here), so this is one assertion on the FINAL
    // landing spot, not two separate hops.
    it('old /testexecution bookmark chains through the project-scoped redirect into the workbench', () => {
        setCurrentProjectId(5);
        renderAppAt('/testexecution');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent('projectId=5');
        expect(window.location.pathname).toBe('/projects/5/workbench/testruns');
    });

    // WP-077 -- proves the CHAIN still resolves now that the project-scoped
    // `defects` route itself redirects onward: flat /defects ->
    // LegacyRedirect (unchanged) -> /projects/:id/defects ->
    // WorkbenchModuleRedirect (App.tsx, this WP) ->
    // /projects/:id/workbench/defects. A single render of <App> follows
    // both redirects (react-router resolves nested <Navigate> renders
    // within one commit here), so this is one assertion on the FINAL
    // landing spot, not two separate hops.
    it('old /defects bookmark chains through the project-scoped redirect into the workbench', () => {
        setCurrentProjectId(5);
        renderAppAt('/defects');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent('projectId=5');
        expect(window.location.pathname).toBe('/projects/5/workbench/defects');
    });

    it('old /audit bookmark redirects into Settings > Audit Log, not a dead top-level page', () => {
        setCurrentProjectId(2);
        renderAppAt('/audit');
        expect(screen.getByTestId('page-settings-audit')).toBeInTheDocument();
        expect(window.location.pathname).toBe('/projects/2/settings/audit');
    });

    it('old /apikeys bookmark redirects into Settings > API Keys, not a dead top-level page', () => {
        setCurrentProjectId(2);
        renderAppAt('/apikeys');
        expect(screen.getByTestId('page-settings-apikeys')).toBeInTheDocument();
        expect(window.location.pathname).toBe('/projects/2/settings/apikeys');
    });

    it('a legacy path opened before any project route has mounted this session falls back to the seeded Default Project', () => {
        // setCurrentProjectId was reset to DEFAULT_PROJECT_ID in beforeEach --
        // this is the "brand new session, bookmark opened in a fresh tab" case.
        // /testexecution now chains into the workbench (this WP) rather than
        // rendering a page marker directly -- same chain proven above, just
        // asserting the DEFAULT project rather than an explicitly-set one.
        renderAppAt('/testexecution');
        expect(screen.getByTestId('page-workbench')).toHaveTextContent(`projectId=${DEFAULT_PROJECT_ID}`);
        expect(window.location.pathname).toBe(`/projects/${DEFAULT_PROJECT_ID}/workbench/testruns`);
    });
});

describe('App route table (WP-044) — non-project-scoped routes are untouched', () => {
    it('/projects (the org-wide project list) renders directly -- no redirect, no :projectId', () => {
        renderAppAt('/projects');
        expect(screen.getByTestId('page-projects-list')).toBeInTheDocument();
        expect(window.location.pathname).toBe('/projects');
    });

    it('/profile renders directly, unaffected by this WP', () => {
        renderAppAt('/profile');
        expect(screen.getByTestId('page-profile')).toBeInTheDocument();
    });

    it('an unknown path renders 404, not a redirect loop', () => {
        renderAppAt('/this-route-does-not-exist');
        expect(screen.getByTestId('page-404')).toBeInTheDocument();
    });
});
