import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectMembersPanel } from '../ProjectMembersPanel';
import {
    getProjects,
    getOrganizationMembers,
    getProjectInvites,
    createProjectInvite,
    revokeProjectInvite,
    addProjectMember
} from '../../../api/projectApi';

// WP-132 — the member panel's two new paths.
//
// The free-text "User id" box this replaces is the thing under test by
// absence: a test asserting it is GONE is what stops it coming back, since
// nothing else in the suite would notice a regression to pasting raw UUIDs.
//
// No network: same mocking convention as FieldsPanel.test.tsx, including the
// api/axios mock, because projectApi.ts -> api/axios.tsx -> src/keycloak.js
// pulls in keycloak-js, which is ESM-only and unparseable by Jest's default
// transform.
jest.mock('../../../api/axios', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() }
}));
jest.mock('../../../api/projectApi', () => {
    const actual = jest.requireActual('../../../api/projectApi');
    return {
        ...actual,
        getProjects: jest.fn(),
        getOrganizationMembers: jest.fn(),
        getProjectInvites: jest.fn(),
        createProjectInvite: jest.fn(),
        revokeProjectInvite: jest.fn(),
        addProjectMember: jest.fn(),
        updateProjectMemberRole: jest.fn(),
        removeProjectMember: jest.fn()
    };
});

const mockGetProjects = getProjects as jest.Mock;
const mockGetOrgMembers = getOrganizationMembers as jest.Mock;
const mockGetInvites = getProjectInvites as jest.Mock;
const mockCreateInvite = createProjectInvite as jest.Mock;
const mockRevokeInvite = revokeProjectInvite as jest.Mock;
const mockAddMember = addProjectMember as jest.Mock;

const PROJECT = {
    _id: 'proj-mongo-id',
    id: 42,
    name: 'Apollo',
    key: 'APOLLO',
    organizationId: 'org-1',
    status: 'active',
    members: [{ userId: 'existing-sub', role: 'admin', addedAt: '2026-01-01T00:00:00.000Z' }]
};

const ORG_MEMBERS = [
    // Already in the project -> must not be offered as a candidate.
    { userId: 'existing-sub', orgRole: 'org_admin', username: 'ada', email: 'ada@x.test', firstName: 'Ada', lastName: 'L', resolved: true },
    // Not in the project -> the one real candidate.
    { userId: 'newcomer-sub', orgRole: 'org_member', username: 'grace', email: 'grace@x.test', firstName: 'Grace', lastName: 'H', resolved: true },
    // Keycloak account gone -> shown by raw id rather than as a blank row.
    { userId: 'orphan-sub', orgRole: 'org_member', username: null, email: null, firstName: null, lastName: null, resolved: false }
];

function renderPanel() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <ProjectMembersPanel projectId={42} />
        </QueryClientProvider>
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetProjects.mockResolvedValue([PROJECT]);
    mockGetOrgMembers.mockResolvedValue(ORG_MEMBERS);
    mockGetInvites.mockResolvedValue([]);
});

describe('WP-132: ProjectMembersPanel', () => {
    it('no longer offers a free-text "User id" field', async () => {
        renderPanel();
        await screen.findByTestId('org-member-picker');
        // The regression guard. Pasting a raw Keycloak sub was the old way in,
        // and nothing else in the suite would catch its return.
        expect(screen.queryByLabelText('User id')).toBeNull();
    });

    it('offers a picker of organization members who are not already in the project', async () => {
        renderPanel();
        await screen.findByTestId('org-member-picker');
        await waitFor(() => expect(mockGetOrgMembers).toHaveBeenCalledWith('org-1'));

        // MUI's Autocomplete opens from its own input, not from the wrapper the
        // data-testid sits on. Targeted by label because the two Role selects
        // are comboboxes as well, so getByRole('combobox') is ambiguous here.
        const input = screen.getByLabelText('Organization member');
        fireEvent.keyDown(input, { key: 'ArrowDown' });

        // Grace is a candidate; Ada is already a member and must not be listed.
        const options = await screen.findAllByRole('option');
        const text = options.map((o) => o.textContent).join(' | ');
        expect(text).toContain('Grace');
        expect(text).not.toContain('Ada');
        // The unresolved member still appears, by id.
        expect(text).toContain('orphan-sub');
    });

    it('adds the picked member at the chosen role', async () => {
        mockAddMember.mockResolvedValue(PROJECT);
        renderPanel();
        await screen.findByTestId('org-member-picker');
        await waitFor(() => expect(mockGetOrgMembers).toHaveBeenCalledWith('org-1'));

        const input = screen.getByLabelText('Organization member');
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        const option = await screen.findByText(/Grace/);
        fireEvent.click(option);
        fireEvent.click(screen.getByTitle('Add member'));
        await waitFor(() =>
            expect(mockAddMember).toHaveBeenCalledWith('proj-mongo-id', 'newcomer-sub', 'viewer')
        );
    });

    it('invites an email address and shows the one-time link', async () => {
        mockCreateInvite.mockResolvedValue({
            invite: { _id: 'inv-1', email: 'new@x.test', role: 'viewer', status: 'pending' },
            inviteUrl: 'http://localhost:3000/accept-invite?token=TOK123'
        });
        renderPanel();
        const email = await screen.findByTestId('invite-email');
        fireEvent.change(email, { target: { value: 'new@x.test' } });
        fireEvent.click(screen.getByTestId('send-invite'));

        await waitFor(() =>
            expect(mockCreateInvite).toHaveBeenCalledWith('proj-mongo-id', 'new@x.test', 'viewer')
        );
        // The link is shown once because it cannot be retrieved again -- only
        // the token's hash is stored server-side.
        const shown = await screen.findByTestId('invite-url');
        expect(shown.textContent).toContain('token=TOK123');
    });

    it('will not send an invite with an empty address', async () => {
        renderPanel();
        await screen.findByTestId('invite-email');
        expect(screen.getByTestId('send-invite')).toBeDisabled();
        expect(mockCreateInvite).not.toHaveBeenCalled();
    });

    it('lists pending invitations and distinguishes an expired one from a live one', async () => {
        mockGetInvites.mockResolvedValue([
            { _id: 'inv-live', email: 'live@x.test', role: 'contributor', status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z', expired: false, projectId: 42, organizationId: 'org-1', invitedBy: 'x', createdAt: '2026-01-01T00:00:00.000Z' },
            { _id: 'inv-dead', email: 'dead@x.test', role: 'viewer', status: 'pending', expiresAt: '2020-01-01T00:00:00.000Z', expired: true, projectId: 42, organizationId: 'org-1', invitedBy: 'x', createdAt: '2026-01-01T00:00:00.000Z' },
            // Accepted invites are history, not pending work.
            { _id: 'inv-done', email: 'done@x.test', role: 'viewer', status: 'accepted', expiresAt: '2099-01-01T00:00:00.000Z', expired: false, projectId: 42, organizationId: 'org-1', invitedBy: 'x', createdAt: '2026-01-01T00:00:00.000Z' }
        ]);
        renderPanel();
        expect(await screen.findByText('live@x.test')).toBeInTheDocument();
        expect(screen.getByText('dead@x.test')).toBeInTheDocument();
        expect(screen.queryByText('done@x.test')).toBeNull();
        // 'pending' and 'usable' are different: expiry is a function of time,
        // so the server reports it separately and the UI must show it.
        expect(screen.getByText('expired')).toBeInTheDocument();
    });

    it('revokes a pending invitation', async () => {
        mockGetInvites.mockResolvedValue([
            { _id: 'inv-live', email: 'live@x.test', role: 'contributor', status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z', expired: false, projectId: 42, organizationId: 'org-1', invitedBy: 'x', createdAt: '2026-01-01T00:00:00.000Z' }
        ]);
        mockRevokeInvite.mockResolvedValue({ _id: 'inv-live', status: 'revoked' });
        renderPanel();
        await screen.findByText('live@x.test');
        fireEvent.click(screen.getByTitle('Revoke invitation'));
        await waitFor(() => expect(mockRevokeInvite).toHaveBeenCalledWith('proj-mongo-id', 'inv-live'));
    });

    it('surfaces the server error when an invite is refused', async () => {
        mockCreateInvite.mockRejectedValue({
            response: { data: { error: 'nope@x.test is already a member of this project' } }
        });
        renderPanel();
        fireEvent.change(await screen.findByTestId('invite-email'), {
            target: { value: 'nope@x.test' }
        });
        fireEvent.click(screen.getByTestId('send-invite'));
        // The server's message distinguishes already-a-member from escalation
        // from mail-not-configured; a generic failure toast would hide which.
        expect(await screen.findByText(/already a member/i)).toBeInTheDocument();
    });
});
