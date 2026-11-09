import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Box,
    IconButton,
    MenuItem,
    Skeleton,
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
import {
    Alert,
    Autocomplete,
    Button,
    Chip,
    Divider
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import { EmptyState } from '../common/EmptyState';
import CustomizedSnackbars from '../snackBar/simpleSnackBar';
import {
    OrgMember,
    ProjectRole,
    PROJECT_ROLES,
    addProjectMember,
    createProjectInvite,
    getOrganizationMembers,
    getProjectInvites,
    getProjects,
    removeProjectMember,
    revokeProjectInvite,
    updateProjectMemberRole
} from '../../api/projectApi';

// WP-044 -- Settings > Members. This is WP-020's membership UI (originally
// a dialog embedded in Pages/projects.tsx, opened per-row from the
// org-wide project list) relocated to live under the *current* project's
// Settings, per this WP's acceptance ("Settings hosts fields/modules/
// folders/members (WP-020's membership UI lives here)"). Pages/projects.tsx
// still lists every project across every organization -- it is not itself
// project-scoped, so it now just links each row's "Members" action here
// (/projects/:projectId/settings/members) instead of opening its own copy
// of this dialog. Logic (add/change role/remove) is unchanged from the
// original, just re-hosted and re-shaped from a Dialog into an inline
// panel.
//
// WP-132 replaced the free-text "User id" box that used to sit at the bottom
// of this panel. It required an admin to paste a raw Keycloak `sub` UUID --
// an identifier this product never displayed anywhere -- and it only worked
// for someone who already had an account. There are now two ways to add
// somebody, matching the two situations that actually occur:
//
//   1. they are already in this organization  -> pick them from a list
//   2. they have no account at all            -> invite their email address
//
// The picker is backed by GET /api/v1/organizations/:id/members, NOT by
// /api/v1/users/kcUsers as WP-132's plan suggested: that endpoint is a
// single-user lookup against the entire realm, so using it here would have
// exposed a platform-wide user directory to solve a UI problem. See the
// controller comment on listOrgMembers.
//
// Takes the numeric route projectId (not a Mongo _id) because that's what
// the URL/X-Project-Id header carry (this WP's own "numeric id, not key"
// decision -- see EXECUTION_LOG.md). Member mutations need the Mongo
// _id (api/projectApi.ts's addProjectMember/updateProjectMemberRole/
// removeProjectMember all take one), so this resolves id -> project via
// the same GET /api/v1/projects usePermissions.tsx already calls (same
// react-query key, same cache entry -- mounting both on one Settings page
// doesn't double the request).

export interface ProjectMembersPanelProps {
    projectId: number;
}

export function ProjectMembersPanel({ projectId }: ProjectMembersPanelProps) {
    const queryClient = useQueryClient();
    const [errorMessage, setErrorMessage] = useState('');
    const [errorOpen, setErrorOpen] = useState(false);
    const [selectedOrgMember, setSelectedOrgMember] = useState<OrgMember | null>(null);
    const [newMemberRole, setNewMemberRole] = useState<ProjectRole>('viewer');
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteRole, setInviteRole] = useState<ProjectRole>('viewer');
    // Shown once, after a successful invite. The raw token is not retrievable
    // again (only its hash is stored), so if mail does not arrive this link is
    // the only copy -- which matters while inbox placement is still unresolved
    // (WP-130's open SPF/DKIM clause).
    const [lastInviteUrl, setLastInviteUrl] = useState('');

    const showError = (message: string) => {
        setErrorMessage(message);
        setErrorOpen(true);
    };

    const { data: projects, isLoading } = useQuery({
        queryKey: ['usePermissions', 'projects'],
        queryFn: () => getProjects()
    });

    const project = projects?.find((p) => p.id === projectId);

    const { data: orgMembers } = useQuery({
        queryKey: ['orgMembers', project?.organizationId],
        queryFn: () => getOrganizationMembers(project!.organizationId),
        enabled: Boolean(project?.organizationId)
    });

    const { data: invites } = useQuery({
        queryKey: ['projectInvites', project?._id],
        queryFn: () => getProjectInvites(project!._id),
        enabled: Boolean(project?._id)
    });

    // Someone already in the project is not a candidate to add to it.
    const candidates = (orgMembers || []).filter(
        (m) => !(project?.members || []).some((pm) => pm.userId === m.userId)
    );

    const pendingInvites = (invites || []).filter((i) => i.status === 'pending');

    const invalidate = () => {
        queryClient.invalidateQueries({ queryKey: ['usePermissions', 'projects'] });
    };

    const invalidateInvites = () => {
        queryClient.invalidateQueries({ queryKey: ['projectInvites', project?._id] });
    };

    const addMutation = useMutation({
        mutationFn: () => addProjectMember(project!._id, selectedOrgMember!.userId, newMemberRole),
        onSuccess: () => {
            invalidate();
            setSelectedOrgMember(null);
            setNewMemberRole('viewer');
        },
        onError: (err: any) => showError(err?.response?.data?.error || 'Unable to add member')
    });

    const inviteMutation = useMutation({
        mutationFn: () => createProjectInvite(project!._id, inviteEmail.trim(), inviteRole),
        onSuccess: (result) => {
            invalidateInvites();
            setInviteEmail('');
            setInviteRole('viewer');
            setLastInviteUrl(result.inviteUrl);
        },
        onError: (err: any) =>
            showError(err?.response?.data?.error || 'Unable to send the invitation')
    });

    const revokeInviteMutation = useMutation({
        mutationFn: (inviteId: string) => revokeProjectInvite(project!._id, inviteId),
        onSuccess: invalidateInvites,
        onError: (err: any) =>
            showError(err?.response?.data?.error || 'Unable to revoke the invitation')
    });

    const roleMutation = useMutation({
        mutationFn: (vars: { userId: string; role: ProjectRole }) =>
            updateProjectMemberRole(project!._id, vars.userId, vars.role),
        onSuccess: invalidate,
        onError: (err: any) => showError(err?.response?.data?.error || 'Unable to update member role')
    });

    const removeMutation = useMutation({
        mutationFn: (userId: string) => removeProjectMember(project!._id, userId),
        onSuccess: invalidate,
        onError: (err: any) => showError(err?.response?.data?.error || 'Unable to remove member')
    });

    if (isLoading) {
        return <Skeleton variant="rounded" height={160} data-testid="members-panel-loading" />;
    }

    if (!project) {
        return <EmptyState message="This project could not be loaded, or you are not a member of it." />;
    }

    return (
        <Box>
            {errorOpen ? (
                <CustomizedSnackbars
                    errorMessage={errorMessage}
                    refresh={errorOpen}
                    closeError={() => setErrorOpen(false)}
                    severity={'error'}
                />
            ) : null}
            <Stack spacing={2}>
                <Typography variant="body2" color="text.secondary">
                    Who can access {project.name} and what they can do. Roles: {PROJECT_ROLES.join(', ')}.
                </Typography>

                {project.members.length === 0 ? (
                    <EmptyState message="No members yet." />
                ) : (
                    <TableContainer>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell>User</TableCell>
                                    <TableCell>Role</TableCell>
                                    <TableCell align="right">Remove</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {project.members.map((member) => (
                                    <TableRow key={member.userId}>
                                        <TableCell>{member.userId}</TableCell>
                                        <TableCell>
                                            <TextField
                                                select
                                                size="small"
                                                value={member.role}
                                                disabled={roleMutation.isPending}
                                                onChange={(e) =>
                                                    roleMutation.mutate({ userId: member.userId, role: e.target.value as ProjectRole })
                                                }
                                            >
                                                {PROJECT_ROLES.map((role) => (
                                                    <MenuItem key={role} value={role}>
                                                        {role}
                                                    </MenuItem>
                                                ))}
                                            </TextField>
                                        </TableCell>
                                        <TableCell align="right">
                                            <IconButton
                                                size="small"
                                                disabled={removeMutation.isPending}
                                                onClick={() => removeMutation.mutate(member.userId)}
                                                title="Remove"
                                            >
                                                <DeleteIcon fontSize="small" />
                                            </IconButton>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                )}

                <Divider />

                {/* 1. Already in this organization -- pick them. */}
                <Typography variant="subtitle2">Add someone from this organization</Typography>
                <Stack direction={'row'} spacing={2} alignItems={'center'} flexWrap={'wrap'} useFlexGap>
                    <Autocomplete
                        size="small"
                        sx={{ minWidth: 280 }}
                        options={candidates}
                        value={selectedOrgMember}
                        onChange={(_e, value) => setSelectedOrgMember(value)}
                        // A member whose Keycloak account has been deleted still
                        // appears, by raw id, so it can be seen and acted on rather
                        // than rendering as a blank row.
                        getOptionLabel={(m) =>
                            m.resolved
                                ? `${[m.firstName, m.lastName].filter(Boolean).join(' ') || m.username || m.userId}${
                                      m.email ? ` (${m.email})` : ''
                                  }`
                                : m.userId
                        }
                        isOptionEqualToValue={(a, b) => a.userId === b.userId}
                        noOptionsText={
                            (orgMembers || []).length === 0
                                ? 'No one else in this organization yet'
                                : 'Everyone in this organization is already a member'
                        }
                        renderInput={(params) => (
                            <TextField {...params} label="Organization member" data-testid="org-member-picker" />
                        )}
                    />
                    <TextField
                        select
                        label="Role"
                        size="small"
                        value={newMemberRole}
                        onChange={(e) => setNewMemberRole(e.target.value as ProjectRole)}
                        sx={{ minWidth: 140 }}
                    >
                        {PROJECT_ROLES.map((role) => (
                            <MenuItem key={role} value={role}>
                                {role}
                            </MenuItem>
                        ))}
                    </TextField>
                    <IconButton
                        color="primary"
                        disabled={!selectedOrgMember || addMutation.isPending}
                        onClick={() => addMutation.mutate()}
                        title="Add member"
                    >
                        <PersonAddIcon />
                    </IconButton>
                </Stack>

                <Divider />

                {/* 2. No account at all -- invite the address. */}
                <Typography variant="subtitle2">Invite someone by email</Typography>
                <Typography variant="body2" color="text.secondary">
                    They do not need an account yet. They will be asked to create one, and must use
                    this same address so the invitation can be matched to them.
                </Typography>
                <Stack direction={'row'} spacing={2} alignItems={'center'} flexWrap={'wrap'} useFlexGap>
                    <TextField
                        label="Email address"
                        size="small"
                        type="email"
                        sx={{ minWidth: 280 }}
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        inputProps={{ 'data-testid': 'invite-email' }}
                    />
                    <TextField
                        select
                        label="Role"
                        size="small"
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as ProjectRole)}
                        sx={{ minWidth: 140 }}
                    >
                        {PROJECT_ROLES.map((role) => (
                            <MenuItem key={role} value={role}>
                                {role}
                            </MenuItem>
                        ))}
                    </TextField>
                    <IconButton
                        color="primary"
                        disabled={!inviteEmail.trim() || inviteMutation.isPending}
                        onClick={() => inviteMutation.mutate()}
                        title="Send invitation"
                        data-testid="send-invite"
                    >
                        <MailOutlineIcon />
                    </IconButton>
                </Stack>

                {lastInviteUrl ? (
                    <Alert severity="success" onClose={() => setLastInviteUrl('')}>
                        <Typography variant="body2">
                            Invitation sent. This link is shown once and cannot be retrieved again
                            &mdash; copy it if you need to pass it on another way:
                        </Typography>
                        <Typography
                            variant="caption"
                            sx={{ wordBreak: 'break-all', display: 'block', mt: 0.5 }}
                            data-testid="invite-url"
                        >
                            {lastInviteUrl}
                        </Typography>
                        <Button size="small" sx={{ mt: 0.5 }} onClick={() => navigator.clipboard?.writeText(lastInviteUrl)}>
                            Copy link
                        </Button>
                    </Alert>
                ) : null}

                {pendingInvites.length > 0 ? (
                    <>
                        <Divider />
                        <Typography variant="subtitle2">Pending invitations</Typography>
                        <TableContainer>
                            <Table size="small">
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Email</TableCell>
                                        <TableCell>Role</TableCell>
                                        <TableCell>Expires</TableCell>
                                        <TableCell align="right">Revoke</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {pendingInvites.map((invite) => (
                                        <TableRow key={invite._id}>
                                            <TableCell>{invite.email}</TableCell>
                                            <TableCell>{invite.role}</TableCell>
                                            <TableCell>
                                                {/* 'pending' and 'still usable' are different
                                                    things: expiry is a function of time, not a
                                                    write, so the server reports it separately. */}
                                                {invite.expired ? (
                                                    <Chip size="small" color="warning" label="expired" />
                                                ) : (
                                                    new Date(invite.expiresAt).toLocaleDateString()
                                                )}
                                            </TableCell>
                                            <TableCell align="right">
                                                <IconButton
                                                    size="small"
                                                    disabled={revokeInviteMutation.isPending}
                                                    onClick={() => revokeInviteMutation.mutate(invite._id)}
                                                    title="Revoke invitation"
                                                >
                                                    <DeleteIcon fontSize="small" />
                                                </IconButton>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </>
                ) : null}
            </Stack>
        </Box>
    );
}

export default ProjectMembersPanel;
