import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { FormControl, MenuItem, Select, SelectChangeEvent } from '@mui/material';
import { getProjects } from '../../api/projectApi';

// WP-044 — project switcher, app bar. Renders only when the current route
// is project-scoped (useParams().projectId is set) -- on /projects (the
// org-wide project list) or /page404 there's no "current project" to
// switch, so this renders nothing there rather than a confusing selector
// with no real meaning.
//
// Switching preserves whatever sub-route you're on: from
// /projects/1/testexecution?status=fail, picking project 2 navigates to
// /projects/2/testexecution?status=fail, not back to project 2's
// dashboard. Layouts/ProjectRouteLayout.tsx's <Outlet key={projectId}>
// then remounts the whole subtree fresh under the new project.
export function ProjectSwitcher() {
    const params = useParams<{ projectId?: string }>();
    const location = useLocation();
    const navigate = useNavigate();

    const currentId = params.projectId ? Number(params.projectId) : null;

    const { data: projects } = useQuery({
        queryKey: ['usePermissions', 'projects'],
        queryFn: () => getProjects(),
        // Same cache entry usePermissions.tsx/ProjectMembersPanel already
        // populate -- mounting the switcher alongside either doesn't add a
        // second request.
        enabled: currentId !== null
    });

    if (currentId === null) {
        return null;
    }

    const handleChange = (event: SelectChangeEvent<number>) => {
        const nextId = Number(event.target.value);
        if (!Number.isFinite(nextId) || nextId === currentId) {
            return;
        }
        const rest = location.pathname.replace(/^\/projects\/[^/]+/, '') || '/dashboard';
        navigate(`/projects/${nextId}${rest}${location.search}`);
    };

    // Always include the current project as an option even before the
    // list has loaded (or if it 404s from the list for some reason) so the
    // Select never renders with an out-of-range value.
    const options = projects && projects.some((p) => p.id === currentId)
        ? projects
        : [{ id: currentId, name: `Project ${currentId}`, key: String(currentId) }, ...(projects ?? [])];

    return (
        <FormControl size="small" sx={{ minWidth: 160, mr: 2 }}>
            <Select
                value={currentId}
                onChange={handleChange}
                displayEmpty
                sx={{
                    color: '#fff',
                    '.MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.5)' },
                    '.MuiSvgIcon-root': { color: '#fff' }
                }}
                inputProps={{ 'aria-label': 'Switch project' }}
            >
                {options.map((p) => (
                    <MenuItem key={p.id} value={p.id}>
                        {p.name}
                    </MenuItem>
                ))}
            </Select>
        </FormControl>
    );
}

export default ProjectSwitcher;
