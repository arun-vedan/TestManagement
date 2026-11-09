import axiosPrivate from './axios';

// WP-051 -- AI test-case generation from a requirement. A *new* module,
// same convention as ./linkApi.ts and ./testPlanApi.ts (isolated call
// sites rather than growing apiCalls.tsx).
//
// GR-8 is why this file is shaped the way it is: generateTestCases() is the
// ONLY call into aiService, and it is read-only from the caller's point of
// view -- it returns candidates, nothing more. acceptCandidate() below
// never calls aiService at all; it drives testRepoService's and
// linkIssueService's own normal, already-governed APIs directly (the same
// endpoints Components/LinkIssue/linkissue.tsx and TabContent.tsx already
// use), so lifecycle ('draft'), tenant scoping, RBAC and audit logging on
// the created test case are the real backend code paths -- not something
// this module could get wrong or bypass. createdBy is derived server-side
// by testRepoService from the caller's own bearer token (see
// backend/testRepoService/controllers/testrepo.js#createTestCase); nothing
// here can forge it.

export interface TestCaseCandidateStep {
    testStep: string;
    Expected: string;
}

export interface TestCaseCandidate {
    TestCaseSummary: string;
    description?: string;
    preconditions?: string;
    TestSteps: TestCaseCandidateStep[];
}

export interface GenerateTestCasesMeta {
    requestedCount: number;
    receivedCount: number;
    droppedCandidates: number;
    truncatedCount: number;
    exemplarCount: number;
}

export interface GenerateTestCasesResult {
    requirementId: string;
    reqId: string;
    candidates: TestCaseCandidate[];
    generatedBy: 'ai';
    model: string;
    meta: GenerateTestCasesMeta;
}

export const generateTestCases = async (
    requirementId: string,
    count?: number,
    style?: string
): Promise<GenerateTestCasesResult> => {
    const resp = await axiosPrivate.post('/api/v1/ai/generate-testcases', {
        requirementId,
        ...(count ? { count } : {}),
        ...(style ? { style } : {}),
    });
    return resp.data.data;
};

export interface AcceptCandidateRequirement {
    reqId: string;
    requirementSummary?: string;
}

// Turns one reviewed (possibly human-edited) candidate into a real draft
// test case + a 'tests'-typed link back to its source requirement, exactly
// the two-document link shape Components/LinkIssue/linkissue.tsx's manual
// "Link" button already creates (a forward doc from the test case's side, a
// reverse doc from the requirement's side) -- so this candidate is
// indistinguishable, for coverage purposes, from a test case a human linked
// by hand.
//
// PARTIAL-FAILURE HANDLING: three sequential calls (create test case ->
// forward link -> reverse link), no server-side transaction across two
// services to fall back on. If a link call fails after the test case was
// already created, this makes a best-effort compensating rollback (delete
// the test case) so accepting never leaves an unlinked, silently-orphaned
// draft behind -- same "delete what this step already created, then
// rethrow" shape as testRepoService's own bulk endpoints
// (controllers/testrepo.js's bulkUpdateTestCases/bulkDeleteTestCases). The
// rollback is itself best-effort (its own failure is swallowed) since the
// only alternative to swallowing it would be masking the original error.
export const acceptCandidate = async (
    requirement: AcceptCandidateRequirement,
    candidate: TestCaseCandidate
) => {
    const created = await axiosPrivate.post('/api/v1/testrepo', {
        TestCaseSummary: candidate.TestCaseSummary,
        TestCaseDescription: candidate.description || candidate.TestCaseSummary,
        TestSteps: candidate.TestSteps,
        status: 'draft',
        generatedBy: 'ai',
    });
    const testCase = created.data.data;

    try {
        await axiosPrivate.post('/api/v1/linkIssue', {
            sourceId: testCase.TestCaseId,
            srcModule: 1,
            destinationId: requirement.reqId,
            destinationModule: 2,
            srcSummary: candidate.TestCaseSummary,
            summary: requirement.requirementSummary,
            linkType: 'tests',
        });
        await axiosPrivate.post('/api/v1/linkIssue', {
            sourceId: requirement.reqId,
            srcModule: 2,
            destinationId: testCase.TestCaseId,
            destinationModule: 1,
            srcSummary: requirement.requirementSummary,
            summary: candidate.TestCaseSummary,
            linkType: 'tests',
        });
    } catch (linkErr) {
        await axiosPrivate.delete(`/api/v1/testrepo/${testCase._id}`).catch(() => {});
        throw linkErr;
    }

    return testCase;
};

// =====================================================================
// WP-052 -- duplicate detection + requirement ambiguity linting.
//
// Same GR-8 shape as everything above: every aiService call here is
// read-only from the caller's point of view (advisory candidates/findings
// only). The two writes this feature makes -- linking two test cases as
// duplicates, and applying a lint suggestion -- each go through the OWNING
// service's own normal, already-governed API (linkIssueService's
// /api/v1/linkIssue for linking, aiService's own
// /api/v1/ai/apply-lint-finding for applying, which itself forwards to
// requirementService's /api/v1/requirement/:id server-side -- see
// backend/aiService/controllers/ai.js#applyLintFinding's header comment for
// why that write lives there and not here), never a shortcut this module
// invents.
// =====================================================================

export interface DuplicateCandidate {
    testCaseId: string;
    TestCaseSummary?: string;
    score: number;
    reason?: string;
}

export interface CheckDuplicateResult {
    candidates: DuplicateCandidate[];
    threshold: number;
    scannedCount: number;
}

export const checkDuplicateTestCase = async (params: {
    testCaseId?: string;
    TestCaseSummary: string;
    TestCaseDescription?: string;
    parentId?: number;
}): Promise<CheckDuplicateResult> => {
    const resp = await axiosPrivate.post('/api/v1/ai/check-duplicate-testcase', params);
    return resp.data.data;
};

export interface DuplicatePair {
    aId: string;
    aSummary?: string;
    bId: string;
    bSummary?: string;
    score: number;
    reason?: string;
}

export interface AuditDuplicatesResult {
    pairs: DuplicatePair[];
    threshold: number;
    scannedCount: number;
    moduleGroupCount: number;
    skippedGroupCount: number;
    /** > 0 means some pairwise comparisons failed (provider hiccup) -- this
     * audit is PARTIAL, not a confirmed all-clear for the pairs that
     * couldn't be compared. See backend/aiService/controllers/ai.js
     * #auditDuplicates -- a 200 only happens when at least one comparison
     * succeeded; if EVERY comparison failed the endpoint returns 503
     * instead of a false all-clear. */
    failedComparisonCount: number;
}

export const auditDuplicates = async (parentId?: number): Promise<AuditDuplicatesResult> => {
    const resp = await axiosPrivate.post('/api/v1/ai/audit-duplicates', parentId !== undefined ? { parentId } : {});
    return resp.data.data;
};

export const dismissDuplicate = async (aId: string, bId: string) => {
    const resp = await axiosPrivate.post('/api/v1/ai/dismiss-duplicate', { aId, bId });
    return resp.data.data;
};

export const undismissDuplicate = async (aId: string, bId: string) => {
    const resp = await axiosPrivate.delete('/api/v1/ai/dismiss-duplicate', { data: { aId, bId } });
    return resp.data.data;
};

// Mirrors acceptCandidate()'s two-document link shape above (a forward doc
// + a reverse doc, same convention Components/LinkIssue/linkissue.tsx's
// manual "Link" button uses) -- linkType 'duplicates' (WP-011's enum),
// srcModule/destinationModule both 1 (test case <-> test case). An explicit
// user action (the one write GR-8 allows without further confirmation,
// since it's exactly what the user clicked "Link as duplicate" to do).
export const linkAsDuplicate = async (
    a: { testCaseId: string; summary?: string },
    b: { testCaseId: string; summary?: string }
) => {
    await axiosPrivate.post('/api/v1/linkIssue', {
        sourceId: a.testCaseId,
        srcModule: 1,
        destinationId: b.testCaseId,
        destinationModule: 1,
        srcSummary: a.summary,
        summary: b.summary,
        linkType: 'duplicates',
    });
    await axiosPrivate.post('/api/v1/linkIssue', {
        sourceId: b.testCaseId,
        srcModule: 1,
        destinationId: a.testCaseId,
        destinationModule: 1,
        srcSummary: b.summary,
        summary: a.summary,
        linkType: 'duplicates',
    });
};

export interface LintFinding {
    type: string;
    description: string;
    excerpt: string;
    suggestedRewrite: string;
}

export interface LintRequirementResult {
    requirementId: string;
    reqId: string;
    status: string;
    findings: LintFinding[];
}

export const lintRequirement = async (requirementId: string): Promise<LintRequirementResult> => {
    const resp = await axiosPrivate.post('/api/v1/ai/lint-requirement', { requirementId });
    return resp.data.data;
};

// Applies ONE finding's suggested rewrite. Server-side lifecycle-gated
// (draft/review only -- rejected 409 on approved/deprecated/archived, see
// applyLintFinding's header comment) -- this function does not attempt to
// pre-check status itself; the caller (AiLintPanel) surfaces whatever the
// server says, including the 409 case, rather than hiding the Apply button
// and calling that enforcement.
export const applyLintFinding = async (requirementId: string, excerpt: string, suggestedRewrite: string) => {
    const resp = await axiosPrivate.post('/api/v1/ai/apply-lint-finding', { requirementId, excerpt, suggestedRewrite });
    return resp.data.data;
};

// =====================================================================
// WP-053 -- AI-assisted reporting. Read-only from the caller's point of
// view (GR-8): summarize-report mutates nothing, it just returns markdown.
// Same "new API calls in a new module, never apiCalls.tsx" convention as
// every other function in this file (WP-051/052) -- appended here rather
// than a separate module since this IS already that dedicated module for
// every aiService call.
// =====================================================================

export type SummarizeReportScope = 'release' | 'plan' | 'timerange';

export interface SummarizeReportUngroundedFigure {
    raw: string;
    kind: string;
}

// See backend/aiService/lib/groundingCheck.js's header comment for the
// full design reasoning behind `rule` and what `ungroundedFigures` can
// contain -- this is the post-check's result, surfaced structurally so the
// UI can never silently drop a violation even if it ignored the markdown's
// own inline "**[UNVERIFIED FIGURE: ...]**" markers.
export interface SummarizeReportGrounding {
    grounded: boolean;
    citedCount: number;
    groundedCount: number;
    ungroundedFigures: SummarizeReportUngroundedFigure[];
    rule: string;
}

export interface SummarizeReportSourceReport {
    reportType: string;
    computedAt: string;
    stale: boolean;
}

export interface SummarizeReportResult {
    scope: SummarizeReportScope;
    releaseId?: string;
    planId?: string;
    days?: number;
    markdown: string;
    generatedBy: 'ai';
    /** Set fresh by the server on every call, never cached/reused -- the "AI-generated, with a timestamp" label this feature must carry (WP-053 acceptance). */
    generatedAt: string;
    model: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    latencyMs: number;
    grounding: SummarizeReportGrounding;
    /** True when ANY reporting-service aggregate this summary was built from was served stale (reportingService's own cached-but-unrefreshable fallback). */
    stale: boolean;
    staleReports: string[];
    sourceReports: SummarizeReportSourceReport[];
}

export const summarizeReport = async (
    scope: SummarizeReportScope,
    opts?: { releaseId?: string; planId?: string; days?: number }
): Promise<SummarizeReportResult> => {
    const resp = await axiosPrivate.post('/api/v1/ai/summarize-report', { scope, ...opts });
    return resp.data.data;
};

// WP-166 follow-up -- GET /api/v1/ai/availability (aiService). Always 200
// for a project member, with a verdict rather than a 403: the caller is
// asking whether AI is on, not attempting an AI action. `message` is
// display-ready when unavailable and null when available.
export interface AiAvailability {
    available: boolean;
    reason: null | 'deployment-disabled' | 'project-disabled' | 'window-expired';
    message: string | null;
    /** false: nobody using this deployment can turn it on -> hide the feature. */
    actionableByProjectAdmin: boolean;
    enabledUntil: string | null;
}

export const getAiAvailability = async (): Promise<AiAvailability> => {
    const resp = await axiosPrivate.get('/api/v1/ai/availability');
    return resp.data.data;
};
