import { Navigate, useLocation } from 'react-router-dom';
import { getCurrentProjectId } from '../currentProject';

// WP-044 — every pre-re-platform flat path (/dashboard, /requirements,
// /testrepo, /testplan, /testexecution, /defects, /releases, /audit,
// /apikeys, and bare /) now renders one of these instead of its old page
// component directly. It 302s (client-side, via <Navigate replace>) to
// the equivalent /projects/:projectId/... route, so an old bookmark still
// lands on the same content instead of a dead route.
//
// Which project? getCurrentProjectId() -- the same module singleton
// Layouts/ProjectRouteLayout.tsx writes to. For a genuinely fresh session
// (never visited a /projects/:id route yet, e.g. a bookmark opened in a
// new tab) it's still initialized to DEFAULT_PROJECT_ID (1), the one real
// seeded project in this deployment and the same fallback every
// api/*Api.ts module already hardcoded before this WP -- not a new
// assumption. `replace` (not push) so the redirect doesn't leave the dead
// old URL in browser history for back-button to return to.
export interface LegacyRedirectProps {
    /** Path *within* a project, e.g. '/dashboard' or '/settings/apikeys'. */
    to: string;
}

export default function LegacyRedirect({ to }: LegacyRedirectProps) {
    const location = useLocation();
    const projectId = getCurrentProjectId();
    return <Navigate to={`/projects/${projectId}${to}${location.search}`} replace />;
}
