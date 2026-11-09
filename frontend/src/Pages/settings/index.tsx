import { Box, Tab, Tabs, Typography } from '@mui/material';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import MainLayout from '../../Components/Layout/MainLayout';

// WP-044 — Settings shell: one MainLayout (one AppBar/Drawer), MUI Tabs
// bound to the URL, and an <Outlet> for whichever tab is active. This is
// the single home the WP's acceptance calls for ("Settings hosts fields/
// modules/folders/members") plus the two previously-flat, genuinely
// project-scoped admin pages this WP relocates here (see EXECUTION_LOG.md's
// WP-044 report for the full per-page placement decision):
//   - Members  (Components/settings/ProjectMembersPanel.tsx) -- WP-020's
//     membership UI, moved off Pages/projects.tsx's per-row dialog.
//   - API Keys (Pages/apiKeys.tsx's extracted ApiKeysPanel) -- WP-032's own
//     report flagged this exact move as pending on this WP landing.
//   - Audit Log (Pages/audit.tsx's extracted AuditLogPanel) -- project-scoped,
//     read-only, admin-facing: the same shape as API Keys.
//   - Fields -- Wave D-1 replaced the reserved stub with a real CRUD tab
//     (Pages/settings/FieldsTab.tsx, Components/settings/FieldsPanel.tsx):
//     pick a module, see its field definitions in a table, create/edit/
//     delete them. Plain CRUD by the owner's own decision, not a form
//     builder -- see FieldsPanel.tsx's header comment.
//   - Environments -- WP-F18b Task 1 added this tab (Pages/settings/
//     EnvironmentsTab.tsx, Components/settings/EnvironmentsPanel.tsx),
//     following the same plain-CRUD pattern Fields established. R1 of
//     that WP's plan: an environment is project-scoped configuration, the
//     same shape as a Field, not a test asset -- it only lived on the old
//     standalone nav page (Pages/releases.tsx) because releases were the
//     first thing that needed it. WP-F18b Task 4 removed that page's own
//     (create-only) environments section along with the page itself; this
//     tab is now the only home, and does strictly more (create/edit/delete).
//   - Modules / Folders -- still reserved tabs, deliberately stubbed
//     (Pages/settings/ReservedTab.tsx). backend/moduleService and
//     folderService exist, but no frontend surface for *configuring* them
//     (as opposed to browsing an existing tree, which
//     Components/folderStructure.tsx already does elsewhere) has been
//     built by any WP yet. Reserving the slot and saying so beats silently
//     omitting it (GR-4).
//
// Tab selection is derived from the URL, not local state, so a direct
// link to e.g. /projects/1/settings/apikeys opens on the right tab and a
// refresh doesn't reset to the first one.
// Modules and Folders are HIDDEN, not deleted. Both were reserved stubs
// (Pages/settings/ReservedTab.tsx) rather than working surfaces, and the
// owner asked for them off the tab strip.
//
// Worth recording why, so nobody restores them assuming the work is simply
// unfinished. A Modules tab would administer `srckube-module`, which holds
// two stale records from 2024 while the app's six modules are hard-coded in
// workbench/modules.ts -- nothing in the frontend reads that collection, so
// renaming a module there would appear to save and change nothing anywhere.
// That is worse than an honest stub. Folders are already created, moved,
// renamed and deleted from the workbench tree, where they are used; a second
// surface would duplicate it.
//
// The ReservedTab component and its routes stay, so re-enabling is a
// one-line change if either becomes real.
const TABS = [
    { value: 'members', label: 'Members' },
    { value: 'apikeys', label: 'API Keys' },
    { value: 'audit', label: 'Audit Log' },
    { value: 'fields', label: 'Fields' },
    { value: 'environments', label: 'Environments' }
] as const;

export default function SettingsShell() {
    const location = useLocation();
    const navigate = useNavigate();
    const { projectId } = useParams<{ projectId: string }>();

    const current = TABS.find((t) => location.pathname.endsWith(`/settings/${t.value}`))?.value ?? 'members';

    return (
        <MainLayout>
            <Box mt={'8vh'}>
                <Typography variant="h5" color={'primary'} mb={2}>
                    Settings
                </Typography>
                <Tabs
                    value={current}
                    onChange={(_, value: string) => navigate(`/projects/${projectId}/settings/${value}`)}
                    variant="scrollable"
                    scrollButtons="auto"
                >
                    {TABS.map((t) => (
                        <Tab key={t.value} value={t.value} label={t.label} />
                    ))}
                </Tabs>
                <Box mt={3}>
                    <Outlet />
                </Box>
            </Box>
        </MainLayout>
    );
}
