import axiosPrivate from './axios';
import { StatusChipColor } from '../Components/common/StatusChip';

// WP-011 (closes the Sprint 2.2 / PB-05 frontend gap): a *new* module rather
// than an addition to apiCalls.tsx -- that file is explicitly off-limits for
// this work package (WP-015 rewrites it wholesale shortly), and WP-014
// already established the pattern of putting new call sites in their own
// module (see ./testPlanApi.ts) to avoid churn there. This module owns:
//
//  - creating/updating the `linkType` field the backend has enforced since
//    Sprint 2.2 but the UI never sent -- every link silently defaulted to
//    'relates-to' (see backend/linkIssueService/models/linkIssue.js and
//    Components/LinkIssue/linkissue.tsx, which previously omitted the field
//    entirely from its POST payload).
//  - the two coverage-gap endpoints that already existed on
//    linkIssueService (Sprint 2.2, PB-05) but had no UI surface:
//    GET /api/v1/linkIssue/coverage/untested-requirements
//    GET /api/v1/linkIssue/coverage/orphan-testcases
//    (verified against backend/linkIssueService/routes/linkIssue.js and
//    controllers/linkIssue.js directly, not assumed from a spec).
//
// linkType enum verified against backend/linkIssueService/models/linkIssue.js:
//   enum: ['tests', 'blocks', 'duplicates', 'relates-to'], default 'relates-to'

export const LINK_TYPES = ['tests', 'blocks', 'duplicates', 'relates-to'] as const;
export type LinkType = typeof LINK_TYPES[number];

// Chip colors for the four link types, reusing common/StatusChip's colorMap
// mechanism (same mechanism LifecycleStatus.tsx uses for governance
// statuses) rather than a bespoke chip.
export const LINK_TYPE_COLORS: Record<LinkType, StatusChipColor> = {
    tests: 'success',
    blocks: 'error',
    duplicates: 'warning',
    'relates-to': 'default',
};

export interface UntestedRequirement {
    reqId: string;
    requirementSummary?: string;
}

export interface OrphanTestCase {
    TestCaseId: string;
    TestCaseSummary?: string;
}

// Updates a single link document's type. The backend stores each side of a
// link as its own document (see linkissue.tsx's linkIssuesHandle, which
// POSTs a forward doc and a reverse doc) -- this updates exactly the
// document whose Mongo _id is passed in.
export const updateLinkType = async (linkMongoId: string, linkType: LinkType) => {
    const resp = await axiosPrivate.put(`/api/v1/linkIssue/${linkMongoId}`, { linkType });
    return resp.data.data;
};

// Best-effort lookup of the reciprocal link document (sourceId/destinationId
// swapped) so a type change made from one side can be mirrored on the
// other, keeping the pair's type consistent regardless of which entity's
// tab the user is viewing. Returns undefined if no reciprocal doc is found
// -- callers should treat that as non-fatal, since the primary update (and
// the coverage flag it drives for the side being viewed) has already
// succeeded by the time this is called.
export const findLink = async (sourceId: string, destinationId: string) => {
    const resp = await axiosPrivate.get(
        `/api/v1/linkIssue?sourceId=${encodeURIComponent(sourceId)}&destinationId=${encodeURIComponent(destinationId)}`
    );
    return resp.data.data && resp.data.data[0];
};

export const getUntestedRequirements = async (): Promise<UntestedRequirement[]> => {
    const resp = await axiosPrivate.get('/api/v1/linkIssue/coverage/untested-requirements');
    return resp.data.data;
};

export const getOrphanTestCases = async (): Promise<OrphanTestCase[]> => {
    const resp = await axiosPrivate.get('/api/v1/linkIssue/coverage/orphan-testcases');
    return resp.data.data;
};
