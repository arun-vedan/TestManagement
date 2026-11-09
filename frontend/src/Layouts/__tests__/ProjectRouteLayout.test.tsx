import { render, screen, fireEvent } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import ProjectRouteLayout, { useActiveProjectId } from '../ProjectRouteLayout';
import LegacyRedirect from '../LegacyRedirect';
import { getCurrentProjectId, setCurrentProjectId, DEFAULT_PROJECT_ID } from '../../currentProject';

// WP-044 — direct proof of the two components every project-scoped route
// (and every legacy redirect) goes through, isolated from the rest of the
// app (no MainDrawer/keycloak/react-query needed to exercise the routing
// mechanics themselves). App's own route table is covered end-to-end by
// src/__tests__/appRouting.test.tsx; this file is the unit-level proof of
// *why* that works.

let mountCount = 0;

function Marker() {
    // Mount count is how this test proves <Outlet key={projectId}> forces
    // a real remount (fresh component instance) on a project switch,
    // rather than the same instance quietly receiving new params -- the
    // acceptance criterion this exists for is "a hard refresh ... preserves
    // the project", and a remount is how this app makes a client-side
    // project switch behave the same way a real hard refresh would (fresh
    // mount, fresh fetches, no carried-over state).
    mountCount += 1;
    const { projectId } = useParams<{ projectId: string }>();
    const activeProjectId = useActiveProjectId();
    return (
        <div data-testid="marker">
            param={projectId} active={activeProjectId} mounts={mountCount} current={getCurrentProjectId()}
        </div>
    );
}

function renderAt(initialPath: string) {
    return render(
        <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
                <Route path="/projects/:projectId" element={<ProjectRouteLayout />}>
                    <Route path="widget" element={<Marker />} />
                </Route>
                <Route path="/legacy/widget" element={<LegacyRedirect to="/widget" />} />
                <Route path="/projects/:projectId/widget" element={<Marker />} />
            </Routes>
        </MemoryRouter>
    );
}

beforeEach(() => {
    mountCount = 0;
    setCurrentProjectId(DEFAULT_PROJECT_ID);
});

describe('ProjectRouteLayout (WP-044)', () => {
    it('parses :projectId from the URL and exposes it via useParams and useActiveProjectId', () => {
        renderAt('/projects/5/widget');
        expect(screen.getByTestId('marker')).toHaveTextContent('param=5');
        expect(screen.getByTestId('marker')).toHaveTextContent('active=5');
    });

    it('writes the parsed projectId into currentProject.ts synchronously, before the child renders', () => {
        renderAt('/projects/42/widget');
        // If this were written in a useEffect instead of render-time, the
        // child's own render (which reads getCurrentProjectId() into its
        // text) could still observe the *previous* value on first paint --
        // this asserts the value the child actually saw during its render.
        expect(screen.getByTestId('marker')).toHaveTextContent('current=42');
        expect(getCurrentProjectId()).toBe(42);
    });

    it('redirects a malformed/non-numeric :projectId to the seeded Default Project rather than scoping to garbage', () => {
        // A route tree where only .../dashboard exists under the project
        // layout -- landing on it at all proves ProjectRouteLayout redirected
        // to DEFAULT_PROJECT_ID's dashboard rather than trying (and failing)
        // to render anything under the garbage param.
        render(
            <MemoryRouter initialEntries={['/projects/not-a-number']}>
                <Routes>
                    <Route path="/projects/:projectId" element={<ProjectRouteLayout />}>
                        <Route path="dashboard" element={<div data-testid="fallback-landed">fallback</div>} />
                    </Route>
                </Routes>
            </MemoryRouter>
        );
        expect(screen.getByTestId('fallback-landed')).toBeInTheDocument();
        expect(getCurrentProjectId()).toBe(DEFAULT_PROJECT_ID);
    });

    it('forces a fresh mount of its subtree when the route projectId changes (project switch behaves like a fresh load)', () => {
        // A single MemoryRouter/history instance throughout (swapping
        // MemoryRouter's initialEntries prop via rerender() does NOT
        // navigate it -- that prop only seeds its history on first mount).
        // Real client-side navigation, same as ProjectSwitcher.tsx's own
        // navigate() call, is what actually needs proving here.
        render(
            <MemoryRouter initialEntries={['/projects/1/widget']}>
                <Link to="/projects/2/widget" data-testid="switch-project">
                    switch
                </Link>
                <Routes>
                    <Route path="/projects/:projectId" element={<ProjectRouteLayout />}>
                        <Route path="widget" element={<Marker />} />
                    </Route>
                </Routes>
            </MemoryRouter>
        );
        expect(screen.getByTestId('marker')).toHaveTextContent('mounts=1');
        expect(screen.getByTestId('marker')).toHaveTextContent('param=1');

        fireEvent.click(screen.getByTestId('switch-project'));

        // A same-instance param update would leave mounts at 1; a real
        // remount (<Outlet key={projectId}>) increments it.
        expect(screen.getByTestId('marker')).toHaveTextContent('mounts=2');
        expect(screen.getByTestId('marker')).toHaveTextContent('param=2');
        expect(screen.getByTestId('marker')).toHaveTextContent('current=2');
    });

    it('"a hard refresh on a deep link preserves the project" -- mounting fresh at a deep link sets the project from the URL regardless of whatever project was active before', () => {
        // Simulates the part of a hard refresh this test environment can
        // reach without a real browser: all client state (here,
        // currentProject.ts's singleton) starts from a value that has
        // nothing to do with the URL being loaded -- exactly what a fresh
        // page load's module re-initialization looks like from the
        // route's point of view. What must NOT happen is the deep link
        // silently keeping the stale value.
        setCurrentProjectId(999);
        renderAt('/projects/3/widget');
        expect(screen.getByTestId('marker')).toHaveTextContent('param=3');
        expect(screen.getByTestId('marker')).toHaveTextContent('current=3');
        expect(getCurrentProjectId()).toBe(3);
    });
});

describe('LegacyRedirect (WP-044)', () => {
    it('redirects an old flat path to the equivalent path under the currently active project', () => {
        setCurrentProjectId(6);
        renderAt('/legacy/widget');
        expect(screen.getByTestId('marker')).toHaveTextContent('param=6');
    });

    it('falls back to the seeded Default Project for a bookmark opened before any project route has ever mounted this session', () => {
        setCurrentProjectId(DEFAULT_PROJECT_ID);
        renderAt('/legacy/widget');
        expect(screen.getByTestId('marker')).toHaveTextContent(`param=${DEFAULT_PROJECT_ID}`);
    });
});
