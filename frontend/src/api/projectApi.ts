import axiosPrivate from './axios';

// WP-020: Organization & Project entities. A *new* module, per the pattern
// WP-011/WP-014 established (linkApi.ts, testPlanApi.ts) -- apiCalls.tsx is
// off-limits (WP-015 is rewriting it wholesale). Backed by userService's
// new /api/v1/organizations and /api/v1/projects routes (see
// backend/userService/{models,controllers,routes}/{Organization,Project,
// organizations,projects}.js and the Kong routes added in
// srckube-kong/kong.yml under the existing "userService" Kong service).
//
// This deliberately does NOT reuse the legacy PObject/PContext shape
// (Context/ProjectContext.tsx, model/ProjectContext.tsx) -- that type
// belongs to an unrelated, unreachable k8s-deployment "create project"
// wizard (Pages/createNewProject.tsx: deploys a namespace/deployment/
// service/ingress) whose backend routes (/api/v1/project, /api/v1/
// deployments, /api/v1/service, /api/v1/ingress) do not exist anywhere in
// Kong or in any backend service -- see the WP-020 discovery note in
// EXECUTION_LOG.md. Reshaping PObject to match the new Project shape would
// ripple into components outside this WP's scope (App.tsx, mainList.tsx,
// NewProjectDetails.tsx) that read its old fields.

export const PROJECT_ROLES = ['admin', 'manager', 'contributor', 'viewer'] as const;
export type ProjectRole = typeof PROJECT_ROLES[number];

export interface ProjectMember {
    userId: string;
    role: ProjectRole;
    addedAt?: string;
}

export type EntityStatus = 'active' | 'archived';

export interface Organization {
    _id: string;
    name: string;
    key: string;
    status: EntityStatus;
    createdBy: string;
    createdAt?: string;
    updatedAt?: string;
}

export interface Project {
    _id: string;
    /** Legacy-compatible auto-incrementing numeric id (mirrors moduleService's Module.id pattern). */
    id: number;
    name: string;
    key: string;
    organizationId: string;
    status: EntityStatus;
    createdBy: string;
    members: ProjectMember[];
    createdAt?: string;
    updatedAt?: string;
}

const ORG_BASE = '/api/v1/organizations';
const PROJECT_BASE = '/api/v1/projects';

export const getOrganizations = async (): Promise<Organization[]> => {
    const resp = await axiosPrivate.get(ORG_BASE);
    return resp.data.data;
};

// WP-020b: createdBy is derived server-side from the caller's Keycloak
// token (see backend/userService/controllers/organizations.js) -- it is no
// longer accepted from the client, so it is not part of this payload.
export const createOrganization = async (payload: { name: string; key: string }): Promise<Organization> => {
    const resp = await axiosPrivate.post(ORG_BASE, payload);
    return resp.data.data;
};

export const getProjects = async (organizationId?: string): Promise<Project[]> => {
    const resp = await axiosPrivate.get(PROJECT_BASE, {
        params: organizationId ? { organizationId } : undefined
    });
    return resp.data.data;
};

// WP-020b: createdBy is derived server-side from the caller's Keycloak
// token (see backend/userService/controllers/projects.js) -- it is no
// longer accepted from the client, so it is not part of this payload.
export const createProject = async (payload: {
    name: string;
    key: string;
    organizationId: string;
}): Promise<Project> => {
    const resp = await axiosPrivate.post(PROJECT_BASE, payload);
    return resp.data.data;
};

export const updateProject = async (
    projectMongoId: string,
    payload: Partial<Pick<Project, 'name' | 'key' | 'status'>>
): Promise<Project> => {
    const resp = await axiosPrivate.put(`${PROJECT_BASE}/${projectMongoId}`, payload);
    return resp.data.data;
};

export const deleteProject = async (projectMongoId: string): Promise<void> => {
    await axiosPrivate.delete(`${PROJECT_BASE}/${projectMongoId}`);
};

export const addProjectMember = async (
    projectMongoId: string,
    userId: string,
    role: ProjectRole
): Promise<Project> => {
    const resp = await axiosPrivate.post(`${PROJECT_BASE}/${projectMongoId}/members`, { userId, role });
    return resp.data.data;
};

export const updateProjectMemberRole = async (
    projectMongoId: string,
    userId: string,
    role: ProjectRole
): Promise<Project> => {
    const resp = await axiosPrivate.put(
        `${PROJECT_BASE}/${projectMongoId}/members/${encodeURIComponent(userId)}`,
        { role }
    );
    return resp.data.data;
};

export const removeProjectMember = async (projectMongoId: string, userId: string): Promise<Project> => {
    const resp = await axiosPrivate.delete(`${PROJECT_BASE}/${projectMongoId}/members/${encodeURIComponent(userId)}`);
    return resp.data.data;
};

// ---------------------------------------------------------------------------
// WP-132 — invitations, and the organization member picker that replaces the
// raw "User id" text field in ProjectMembersPanel.
// ---------------------------------------------------------------------------

export type InviteStatus = 'pending' | 'accepted' | 'revoked';

export interface ProjectInvite {
    _id: string;
    email: string;
    projectId: number;
    organizationId: string;
    role: ProjectRole;
    status: InviteStatus;
    expiresAt: string;
    invitedBy: string;
    acceptedBy?: string;
    acceptedAt?: string;
    createdAt: string;
    // Server-computed: a row can be status 'pending' and still unusable,
    // because expiry is a function of time rather than a write. The UI must
    // not offer an accept that would be refused.
    expired?: boolean;
}

export interface OrgMember {
    userId: string;
    orgRole: string;
    username: string | null;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    // false when the Keycloak account behind this membership is gone; the UI
    // shows the raw id rather than a blank row.
    resolved: boolean;
}

export const getProjectInvites = async (projectMongoId: string): Promise<ProjectInvite[]> => {
    const resp = await axiosPrivate.get(`${PROJECT_BASE}/${projectMongoId}/invites`);
    return resp.data.data;
};

// Returns the created invite plus the one-time link. The raw token is never
// retrievable again -- only its hash is stored server-side -- so the link is
// surfaced to the sender here for the case where mail is unreliable.
export const createProjectInvite = async (
    projectMongoId: string,
    email: string,
    role: ProjectRole
): Promise<{ invite: ProjectInvite; inviteUrl: string }> => {
    const resp = await axiosPrivate.post(`${PROJECT_BASE}/${projectMongoId}/invites`, { email, role });
    return { invite: resp.data.data, inviteUrl: resp.data.inviteUrl };
};

export const revokeProjectInvite = async (
    projectMongoId: string,
    inviteId: string
): Promise<ProjectInvite> => {
    const resp = await axiosPrivate.delete(`${PROJECT_BASE}/${projectMongoId}/invites/${inviteId}`);
    return resp.data.data;
};

// Backs the picker. Scoped to one organization the caller belongs to --
// deliberately NOT /api/v1/users/kcUsers, which is a single-user lookup
// against the whole realm and would expose a platform-wide user directory.
export const getOrganizationMembers = async (organizationId: string): Promise<OrgMember[]> => {
    const resp = await axiosPrivate.get(`/api/v1/organizations/${organizationId}/members`);
    return resp.data.data;
};

export const acceptInvite = async (
    token: string
): Promise<{ projectId: number; projectName: string; role: ProjectRole }> => {
    const resp = await axiosPrivate.post('/api/v1/invites/accept', { token });
    return resp.data.data;
};
