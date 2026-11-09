import axiosPrivate from '../axios';
import { getCurrentProjectId, setCurrentProjectId, PROJECT_ID_HEADER, DEFAULT_PROJECT_ID } from '../../currentProject';

// WP-044 — proves the X-Project-Id header api/axios.tsx's request
// interceptor attaches is driven by currentProject.ts's route-updated
// singleton, not a fixed constant. This is the load-bearing mechanism
// behind the WP's acceptance criterion "the route ... flows into that
// [X-Project-Id] header" -- Layouts/ProjectRouteLayout.tsx calls exactly
// the same setCurrentProjectId() this test calls directly, so this proves
// the header-sourcing half of that chain without needing a live backend
// or a browser.
//
// keycloak is mocked the same way Pages/dashboard/__tests__/dashboard.test.tsx
// mocks it -- unauthenticated, so the interceptor's token-refresh branch is
// skipped and only the X-Project-Id logic under test runs.
jest.mock('../../keycloak', () => ({
    __esModule: true,
    default: { tokenParsed: undefined, authenticated: false }
}));

// axios doesn't expose a public "run this request through my configured
// interceptors" API -- reaching into interceptors.request's internal
// handlers list to invoke the fulfilled callback directly is the
// standard technique for unit-testing an interceptor in isolation,
// without mocking the network layer or a whole request/response cycle.
function runRequestInterceptor(config: any) {
    const handlers = (axiosPrivate.interceptors.request as any).handlers;
    expect(handlers.length).toBeGreaterThan(0);
    return handlers[0].fulfilled(config);
}

describe('api/axios.tsx X-Project-Id sourcing (WP-044)', () => {
    afterEach(() => {
        // Don't leak project id state between tests -- restore to the
        // documented default the way a fresh module load would start.
        setCurrentProjectId(DEFAULT_PROJECT_ID);
    });

    it('attaches X-Project-Id from currentProject.ts\'s current value, not a fixed constant', async () => {
        setCurrentProjectId(7);
        const config = await runRequestInterceptor({ headers: {} });
        expect(config.headers[PROJECT_ID_HEADER]).toBe('7');
    });

    it('picks up a project switch immediately -- the next request after setCurrentProjectId sees the new value', async () => {
        setCurrentProjectId(1);
        const first = await runRequestInterceptor({ headers: {} });
        expect(first.headers[PROJECT_ID_HEADER]).toBe('1');

        // Exactly what Layouts/ProjectRouteLayout.tsx does on a route
        // change to a different :projectId.
        setCurrentProjectId(2);
        const second = await runRequestInterceptor({ headers: {} });
        expect(second.headers[PROJECT_ID_HEADER]).toBe('2');
    });

    it('does not override a caller that deliberately set its own X-Project-Id', async () => {
        setCurrentProjectId(9);
        const config = await runRequestInterceptor({ headers: { [PROJECT_ID_HEADER]: '999' } });
        expect(config.headers[PROJECT_ID_HEADER]).toBe('999');
    });

    it('falls back to the seeded Default Project before any route has set one', () => {
        // A fresh module load (currentProject.ts's own initial value,
        // before Layouts/ProjectRouteLayout.tsx ever mounts) -- the
        // fallback every legacy bookmark redirects against.
        expect(getCurrentProjectId()).toBe(DEFAULT_PROJECT_ID);
    });
});
