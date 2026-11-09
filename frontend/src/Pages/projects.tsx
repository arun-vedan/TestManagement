import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    MenuItem,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Typography
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import GroupIcon from '@mui/icons-material/Group';
import MainLayout from '../Components/Layout/MainLayout';
import { EmptyState } from '../Components/common/EmptyState';
import { StatusChip, StatusChipColor } from '../Components/common/StatusChip';
import CustomizedSnackbars from '../Components/snackBar/simpleSnackBar';
import {
    Organization,
    Project,
    createOrganization,
    createProject,
    deleteProject,
    getOrganizations,
    getProjects,
    updateProject
} from '../api/projectApi';

// WP-020: real Organization -> Project CRUD, replacing the previously
// unreachable page (Pages/projects.tsx was never wired into App.tsx's
// route table, and the old "Add New Project" flow called backend routes
// that never existed -- see the WP-020 discovery note in
// EXECUTION_LOG.md). `members` is deliberately surfaced here since it is
// the anchor WP-022 (RBAC) will enforce against.
//
// Plain, functional MUI per the owner's 2026-08-28 design direction -- no
// bespoke visual work. WP-044 will re-platform this onto
// /projects/:projectId/... later. An organization switcher is out of scope
// (deferred until multi-org is real); this page manages projects within
// whichever organization is selected in the create dialog, defaulting to
// the first organization found (or offering to create one if none exist).

const STATUS_COLORS: Record<string, StatusChipColor> = {
    active: 'success',
    archived: 'default'
};

const NEW_ORG_VALUE = '__new__';

export default function Projects() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [loading, setLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [errorOpen, setErrorOpen] = useState(false);

    const [createOpen, setCreateOpen] = useState(false);
    const [createOrgId, setCreateOrgId] = useState('');
    const [newOrgName, setNewOrgName] = useState('');
    const [newOrgKey, setNewOrgKey] = useState('');
    const [newProjectName, setNewProjectName] = useState('');
    const [newProjectKey, setNewProjectKey] = useState('');

    const [editProject, setEditProject] = useState<Project | null>(null);
    const [editName, setEditName] = useState('');
    const [editKey, setEditKey] = useState('');
    const [editStatus, setEditStatus] = useState<'active' | 'archived'>('active');

    // WP-044: member management moved to Settings > Members
    // (/projects/:projectId/settings/members, Components/settings/
    // ProjectMembersPanel.tsx) -- this page is org-wide (every project
    // across every organization), not scoped to one project, so it now
    // just navigates there per-row instead of hosting its own dialog.
    const navigate = useNavigate();

    const organizationName = useMemo(() => {
        const byId: Record<string, string> = {};
        organizations.forEach((o) => {
            byId[o._id] = o.name;
        });
        return byId;
    }, [organizations]);

    const showError = (message: string) => {
        setErrorMessage(message);
        setErrorOpen(true);
    };

    const loadAll = async () => {
        setLoading(true);
        try {
            const [orgs, projs] = await Promise.all([getOrganizations(), getProjects()]);
            setOrganizations(orgs);
            setProjects(projs);
        } catch (err: any) {
            showError(err?.response?.data?.error || 'Unable to load projects');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadAll();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const openCreate = () => {
        setCreateOrgId(organizations.length > 0 ? organizations[0]._id : NEW_ORG_VALUE);
        setNewOrgName('');
        setNewOrgKey('');
        setNewProjectName('');
        setNewProjectKey('');
        setCreateOpen(true);
    };

    const handleCreate = async () => {
        if (!newProjectName || !newProjectKey) {
            showError('Project name and key are required');
            return;
        }
        try {
            let organizationId = createOrgId;
            if (createOrgId === NEW_ORG_VALUE) {
                if (!newOrgName || !newOrgKey) {
                    showError('Organization name and key are required');
                    return;
                }
                // createdBy is derived server-side from the caller's token (WP-020b).
                const org = await createOrganization({ name: newOrgName, key: newOrgKey });
                organizationId = org._id;
                setOrganizations((prev) => [...prev, org]);
            }
            const project = await createProject({
                name: newProjectName,
                key: newProjectKey,
                organizationId
            });
            setProjects((prev) => [...prev, project]);
            setCreateOpen(false);
        } catch (err: any) {
            showError(err?.response?.data?.error || 'Unable to create project');
        }
    };

    const openEdit = (project: Project) => {
        setEditProject(project);
        setEditName(project.name);
        setEditKey(project.key);
        setEditStatus(project.status);
    };

    const handleEditSave = async () => {
        if (!editProject) {
            return;
        }
        try {
            const updated = await updateProject(editProject._id, {
                name: editName,
                key: editKey,
                status: editStatus
            });
            setProjects((prev) => prev.map((p) => (p._id === updated._id ? updated : p)));
            setEditProject(null);
        } catch (err: any) {
            showError(err?.response?.data?.error || 'Unable to update project');
        }
    };

    const handleDelete = async (project: Project) => {
        if (!window.confirm(`Delete project "${project.name}"? This cannot be undone.`)) {
            return;
        }
        try {
            await deleteProject(project._id);
            setProjects((prev) => prev.filter((p) => p._id !== project._id));
        } catch (err: any) {
            showError(err?.response?.data?.error || 'Unable to delete project');
        }
    };

    const openMembers = (project: Project) => {
        navigate(`/projects/${project.id}/settings/members`);
    };

    return (
        <MainLayout>
            {errorOpen ? (
                <CustomizedSnackbars
                    errorMessage={errorMessage}
                    refresh={errorOpen}
                    closeError={() => setErrorOpen(false)}
                    severity={'error'}
                />
            ) : null}
            <Box mt={'8vh'}>
                <Stack spacing={3}>
                    <Stack direction={'row'} justifyContent={'space-between'} alignItems={'center'}>
                        <Typography variant="h5" color={'primary'}>
                            Projects
                        </Typography>
                        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
                            New Project
                        </Button>
                    </Stack>

                    {!loading && projects.length === 0 ? (
                        <EmptyState message="No projects yet. Create one to get started." />
                    ) : (
                        <TableContainer>
                            <Table size="small">
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Name</TableCell>
                                        <TableCell>Key</TableCell>
                                        <TableCell>Organization</TableCell>
                                        <TableCell>Status</TableCell>
                                        <TableCell>Members</TableCell>
                                        <TableCell align="right">Actions</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {projects.map((project) => (
                                        <TableRow key={project._id}>
                                            <TableCell>{project.name}</TableCell>
                                            <TableCell>{project.key}</TableCell>
                                            <TableCell>
                                                {organizationName[project.organizationId] || project.organizationId}
                                            </TableCell>
                                            <TableCell>
                                                <StatusChip status={project.status} colorMap={STATUS_COLORS} />
                                            </TableCell>
                                            <TableCell>{project.members?.length ?? 0}</TableCell>
                                            <TableCell align="right">
                                                <IconButton size="small" onClick={() => openMembers(project)} title="Members">
                                                    <GroupIcon fontSize="small" />
                                                </IconButton>
                                                <IconButton size="small" onClick={() => openEdit(project)} title="Edit">
                                                    <EditIcon fontSize="small" />
                                                </IconButton>
                                                <IconButton size="small" onClick={() => handleDelete(project)} title="Delete">
                                                    <DeleteIcon fontSize="small" />
                                                </IconButton>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    )}
                </Stack>
            </Box>

            {/* Create project dialog */}
            <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
                <DialogTitle>New Project</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} mt={1}>
                        <TextField
                            select
                            label="Organization"
                            value={createOrgId}
                            onChange={(e) => setCreateOrgId(e.target.value)}
                            fullWidth
                        >
                            {organizations.map((org) => (
                                <MenuItem key={org._id} value={org._id}>
                                    {org.name}
                                </MenuItem>
                            ))}
                            <MenuItem value={NEW_ORG_VALUE}>+ Create new organization</MenuItem>
                        </TextField>
                        {createOrgId === NEW_ORG_VALUE ? (
                            <Stack spacing={2} pl={2}>
                                <TextField
                                    label="Organization name"
                                    value={newOrgName}
                                    onChange={(e) => setNewOrgName(e.target.value)}
                                    fullWidth
                                />
                                <TextField
                                    label="Organization key"
                                    value={newOrgKey}
                                    onChange={(e) => setNewOrgKey(e.target.value.toLowerCase())}
                                    helperText="Lowercase letters, numbers and hyphens only"
                                    fullWidth
                                />
                            </Stack>
                        ) : null}
                        <TextField
                            label="Project name"
                            value={newProjectName}
                            onChange={(e) => setNewProjectName(e.target.value)}
                            fullWidth
                        />
                        <TextField
                            label="Project key"
                            value={newProjectKey}
                            onChange={(e) => setNewProjectKey(e.target.value)}
                            fullWidth
                        />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button variant="contained" onClick={handleCreate}>
                        Create
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Edit project dialog */}
            <Dialog open={!!editProject} onClose={() => setEditProject(null)} fullWidth maxWidth="sm">
                <DialogTitle>Edit Project</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} mt={1}>
                        <TextField label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} fullWidth />
                        <TextField label="Key" value={editKey} onChange={(e) => setEditKey(e.target.value)} fullWidth />
                        <TextField
                            select
                            label="Status"
                            value={editStatus}
                            onChange={(e) => setEditStatus(e.target.value as 'active' | 'archived')}
                            fullWidth
                        >
                            <MenuItem value="active">active</MenuItem>
                            <MenuItem value="archived">archived</MenuItem>
                        </TextField>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setEditProject(null)}>Cancel</Button>
                    <Button variant="contained" onClick={handleEditSave}>
                        Save
                    </Button>
                </DialogActions>
            </Dialog>

        </MainLayout>
    );
}
