import axiosPrivate from './axios';

// WP-010 (Sprint 2.4): defect status workflow. Deliberately a *new* module,
// not an addition to apiCalls.tsx — that file is a chokepoint a concurrent
// WP owns and WP-015 rewrites wholesale shortly after (same reasoning as
// testPlanApi.ts, see that file's header comment). Kept self-contained here.
//
// Unlike LifecycleStatus.tsx's fixed 5-state vocabulary (draft/review/
// approved/deprecated/archived, hardcoded client-side), defect status is
// data-driven: istatusservice owns the real vocabulary and the parentId
// transition graph (see backend/statusService/models/IssueStatus.js and
// backend/defectService/controllers/defects.js's updateDefectStatus for the
// verified graph semantics). This module fetches that graph directly from
// istatusservice through Kong — GET /api/v1/issuestatus is one of the 14
// routes already exposed there — rather than only through defectService, so
// the UI can compute the client-side "which transitions are actually legal
// from here" set instead of just offering every status and waiting for a
// 400. defectService's PUT /:id/status remains the sole source of truth:
// it re-validates against the same graph server-side regardless of what the
// UI offers.

export interface IssueStatus {
    id: number;
    istatus: string;
    // Ids of the statuses a defect can transition FROM to reach this one
    // (verified against real data in srckube-issuestatus.staus — see
    // EXECUTION_LOG.md's WP-010 entry for the raw documents and reasoning).
    parentId: number[];
}

export const getIssueStatuses = async (): Promise<IssueStatus[]> => {
    const resp = await axiosPrivate.get('/api/v1/issuestatus?limit=1000');
    return resp.data.data;
};

export const updateDefectStatus = async (defectId: string, status: string) => {
    const resp = await axiosPrivate.put(`/api/v1/defects/${defectId}/status`, { status });
    return resp.data;
};
