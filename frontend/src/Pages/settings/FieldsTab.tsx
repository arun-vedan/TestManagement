import { useParams } from 'react-router-dom';
import { FieldsPanel } from '../../Components/settings/FieldsPanel';
import { EmptyState } from '../../Components/common/EmptyState';

// Wave D-1 — Settings > Fields. Replaces the ReservedTab stub this slot was
// deliberately reserved with (see ReservedTab.tsx's own header comment:
// "the tab exists so a future WP has an obvious home" -- this is that WP).
// Reads :projectId straight from the route, same convention MembersTab.tsx
// established ("all pages read projectId from the route", not the ambient
// currentProject.ts singleton) for exactly the same reason: this tab is
// explicit about which project's field definitions it's managing.
export default function FieldsTab() {
    const { projectId: projectIdParam } = useParams<{ projectId: string }>();
    const projectId = Number(projectIdParam);

    if (!Number.isFinite(projectId)) {
        return <EmptyState message="No project selected." />;
    }

    return <FieldsPanel projectId={projectId} />;
}
