// WP-022 (origin) / WP-044 (this revision) — the numeric project id every
// request is scoped to.
//
// backend/shared/service-core/middleware/projectScope.js's requireProjectScope()
// (WP-021) is mandatory on every testRepo/requirement/defect/release/audit/
// apikey route: a request with no `X-Project-Id` header 403s. WP-022 fixed
// that by plumbing a hardcoded constant through the one shared axios
// instance (api/axios.tsx). WP-044 re-platforms every route onto
// /projects/:projectId/... , making the URL the source of truth for which
// project is "current" — this file is now a plain mutable singleton that
// Layouts/ProjectRouteLayout.tsx writes to (once, synchronously, during its
// own render — see that file's header comment for why render-time and not
// useEffect) every time the :projectId route param changes, instead of a
// value nobody ever updates.
//
// Why a module-level mutable singleton instead of only React Context: the
// axios request interceptor below (api/axios.tsx) is a plain function, not
// a React component/hook — it cannot call useContext(). Every request,
// including ones fired from outside any component's render (react-query
// background refetches, mutations), needs a synchronous, always-current
// answer to "what project is this for", and a plain module variable is the
// simplest thing that works from both worlds. Layouts/ProjectRouteLayout.tsx
// additionally exposes the same value through React Context
// (ActiveProjectContext) for components that want to read/display it
// reactively (the project switcher, Settings).
//
// DEFAULT_PROJECT_ID (1) is the fallback used only (a) before any
// project-scoped route has ever mounted in this session, and (b) as the
// redirect target for legacy bookmarks that carry no project of their own
// (see App.tsx's LegacyRedirect). It matches the seeded Default Project
// (id=1) that was already hardcoded everywhere before this WP — see
// Components/folderStructure/folderStructure.tsx's pre-existing
// `let projectId = 1` and every api/*Api.ts module built since WP-021.
export const DEFAULT_PROJECT_ID = 1;
export const PROJECT_ID_HEADER = 'X-Project-Id';

let currentProjectId: number = DEFAULT_PROJECT_ID;

export function getCurrentProjectId(): number {
    return currentProjectId;
}

/** Written exactly by Layouts/ProjectRouteLayout.tsx as the URL's :projectId changes. */
export function setCurrentProjectId(id: number): void {
    if (Number.isFinite(id) && id > 0) {
        currentProjectId = id;
    }
}
