import { useParams } from 'react-router-dom';
import { ProjectMembersPanel } from '../../Components/settings/ProjectMembersPanel';
import { EmptyState } from '../../Components/common/EmptyState';

// WP-044 — Settings > Members. Reads :projectId straight from the route
// (not the ambient currentProject.ts singleton) so this tab is explicit
// about which project it's managing, matching this WP's acceptance
// ("all pages read projectId from the route").
export default function MembersTab() {
    const { projectId: projectIdParam } = useParams<{ projectId: string }>();
    const projectId = Number(projectIdParam);

    if (!Number.isFinite(projectId)) {
        return <EmptyState message="No project selected." />;
    }

    return <ProjectMembersPanel projectId={projectId} />;
}
