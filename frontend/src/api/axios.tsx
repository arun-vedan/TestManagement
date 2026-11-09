import axios from 'axios';
import keycloak from '../keycloak';
import { getCurrentProjectId, PROJECT_ID_HEADER } from '../currentProject';
export const BASE_URL = process.env.REACT_APP_API_BASE_URL


let axiosPrivate = axios.create({
    baseURL: BASE_URL
});

axiosPrivate.interceptors.request.use(
    async (config) => {
        if (keycloak.authenticated) {
            // Update the token if it's about to expire
            await keycloak.updateToken(30); // Ensures token is valid for at least 30 seconds
            // Set the Authorization header with the token
            config.headers.Authorization = `Bearer ${keycloak.token}`;
        }
        // WP-022/WP-044: see currentProject.ts for why this is a live getter,
        // not a constant. getCurrentProjectId() reflects whichever
        // /projects/:projectId route last mounted (Layouts/ProjectRouteLayout.tsx
        // writes it synchronously on every route change). Harmless for every
        // route that doesn't check it (requireProjectScope() is opt-in
        // per-route, WP-021) and required for testrepo/requirement/defects/
        // releases/audit/apikeys, which 403 without it. Don't override a
        // caller that deliberately set its own X-Project-Id.
        if (!config.headers[PROJECT_ID_HEADER]) {
            config.headers[PROJECT_ID_HEADER] = String(getCurrentProjectId());
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

export default axiosPrivate
