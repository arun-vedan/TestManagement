import axiosPrivate from './axios';
import { getCurrentProjectId } from '../currentProject';

// WP-024: Audit log. A *new* module, per the pattern WP-011/WP-014/WP-020/
// WP-025 established (linkApi.ts, testPlanApi.ts, projectApi.ts,
// releaseApi.ts) -- apiCalls.tsx is off-limits. Backed by commentsService's
// new /api/v1/audit route (see backend/commentsService/{controllers,routes}
// /audit.js and the new auditroute Kong entry).
//
// Project scope: same convention as releaseApi.ts. WP-044: the route
// (/projects/:projectId/settings/audit) is now the source of truth -- see
// currentProject.ts's header comment. Computed at call time (a function,
// not a module-load-time constant) so a project switch mid-session is
// picked up by the very next call.
const projectScopeHeaders = () => ({ 'X-Project-Id': String(getCurrentProjectId()) });

export interface AuditEvent {
    _id: string;
    ts: string;
    actor: string;
    actorName?: string;
    organizationId?: string;
    projectId?: number;
    entityType: string;
    entityId: string;
    action: string;
    summary?: { before?: unknown; after?: unknown } | Record<string, unknown>;
    correlationId?: string;
    createdAt?: string;
}

export interface AuditFilters {
    entityType?: string;
    entityId?: string;
    actor?: string;
    action?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    page?: number;
}

const AUDIT_BASE = '/api/v1/audit';

export const getAuditEvents = async (filters: AuditFilters = {}): Promise<{ data: AuditEvent[]; total: number }> => {
    const resp = await axiosPrivate.get(AUDIT_BASE, {
        headers: projectScopeHeaders(),
        params: {
            limit: 200,
            ...filters
        }
    });
    return { data: resp.data.data, total: resp.data.total };
};
