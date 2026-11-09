import { useParams } from 'react-router-dom';
import { EnvironmentsPanel } from '../../Components/settings/EnvironmentsPanel';
import { EmptyState } from '../../Components/common/EmptyState';

// WP-F18b Task 1 — Settings > Environments. New tab (not a ReservedTab
// slot -- `modules` and `folders` stay reserved for WP-F17, per this WP's
// plan). Reads :projectId from the route, same convention FieldsTab.tsx
// and MembersTab.tsx established.
export default function EnvironmentsTab() {
    const { projectId: projectIdParam } = useParams<{ projectId: string }>();
    const projectId = Number(projectIdParam);

    if (!Number.isFinite(projectId)) {
        return <EmptyState message="No project selected." />;
    }

    return <EnvironmentsPanel projectId={projectId} />;
}
