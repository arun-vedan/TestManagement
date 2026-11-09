import { ApiKeysPanel } from '../apiKeys';

// WP-044 — Settings > API Keys. WP-032's own report flagged this exact
// relocation as pending on this WP landing (/apikeys was top-level only
// because no Settings shell existed yet). ApiKeysPanel already reads the
// active project via api/apiKeyApi.ts's projectScopeHeaders(), which
// reads currentProject.ts's singleton -- kept current by
// Layouts/ProjectRouteLayout.tsx from the route, same as every other
// project-scoped page.
export default function ApiKeysTab() {
    return <ApiKeysPanel />;
}
