import { createContext, useContext } from 'react';
import { Navigate, Outlet, useParams } from 'react-router-dom';
import { DEFAULT_PROJECT_ID, setCurrentProjectId } from '../currentProject';

// WP-044 — the one place that turns "/projects/:projectId/..." into "the
// project every page and every API call is scoped to". Mounted once, as
// the element of the parent <Route path="/projects/:projectId"> in
// App.tsx, wrapping every project-scoped page (dashboard/requirements/
// testrepo/testplan/testexecution/defects/releases/reports/settings) as
// its <Outlet>.
//
// Why this exists at all instead of leaving pages to read
// Context/ProjectContext.tsx (or nothing): the acceptance criterion is
// "all pages read projectId from the route (not just context)" -- deep
// links and a hard refresh must land on the right project with no prior
// client state. Putting the sync in exactly one place (here), keyed off
// useParams(), is what makes that true for every nested page at once
// instead of requiring each page to duplicate the parsing.
//
// Render-time, not useEffect: setCurrentProjectId() runs directly in this
// component's function body, before the JSX below is returned. That
// matters because api/axios.tsx's request interceptor is a plain
// function, not a hook -- it can't read React Context, so it reads the
// module-level singleton in currentProject.ts instead. If this were done
// in a useEffect, effects fire bottom-up on mount (children's effects run
// before their parent's), so a child page's own useEffect/react-query
// fetch could fire, and read the *previous* project id, before this
// layout's effect ever ran. Doing it synchronously during render
// guarantees every descendant -- including the first paint's data fetches
// -- sees the new value. (See currentProject.ts's header comment for the
// fuller "why a plain mutable singleton" rationale.)
//
// <Outlet key={projectId}> deliberately forces every child page to fully
// remount on a project switch, rather than reusing the previous instance
// with new params. Two reasons: (1) several pages hold mutable local tree
// state (folderStructure.tsx et al, per queryClient.ts's own comment)
// that must not silently carry over from one project into another, and
// (2) it sidesteps having to audit every react-query key in every
// project-scoped page for whether it already varies by project -- a fresh
// mount always issues fresh requests under the new project's
// X-Project-Id, matching this WP's acceptance ("prove a hard refresh...
// preserves the project", which a remount is indistinguishable from).
export interface ActiveProjectContextValue {
    projectId: number;
}

export const ActiveProjectContext = createContext<ActiveProjectContextValue | null>(null);

/** Read the numeric project id the current route is scoped to. Throws outside a project-scoped route on purpose -- a page reading this MUST be nested under /projects/:projectId. */
export function useActiveProjectId(): number {
    const ctx = useContext(ActiveProjectContext);
    if (!ctx) {
        throw new Error('useActiveProjectId() called outside a /projects/:projectId route');
    }
    return ctx.projectId;
}

export default function ProjectRouteLayout() {
    const { projectId: projectIdParam } = useParams<{ projectId: string }>();
    const projectId = Number(projectIdParam);

    // Malformed/non-numeric :projectId (a hand-edited URL, a stale link to
    // a deleted project's old id, etc.) -- bounce to the known-good default
    // rather than scoping every API call to NaN/garbage, which would 403
    // everything with no useful signal to the user.
    if (!projectIdParam || !Number.isFinite(projectId) || projectId <= 0) {
        return <Navigate to={`/projects/${DEFAULT_PROJECT_ID}/dashboard`} replace />;
    }

    setCurrentProjectId(projectId);

    return (
        <ActiveProjectContext.Provider value={{ projectId }}>
            <Outlet key={projectId} />
        </ActiveProjectContext.Provider>
    );
}
