// WP-051 -- unit coverage for api/aiApi.ts, mocking axiosPrivate directly
// (same technique as api/__tests__/axios.test.ts uses for the interceptor,
// simpler here since these functions just shape requests/responses).
//
// THE POINT: prove acceptCandidate() drives testRepoService's/
// linkIssueService's OWN normal endpoints (not some aiService shortcut),
// sends the fields GR-8/WP-020b require (status:'draft', generatedBy:'ai',
// and NO createdBy in the body -- testRepoService derives that from the
// caller's token server-side), creates the SAME two-document link shape
// Components/LinkIssue/linkissue.tsx's manual "Link" button creates, and
// compensates (deletes the just-created test case) if a link call fails
// partway through, rather than leaving an orphaned, unlinked draft behind.

import axiosPrivate from '../axios';
import {
    acceptCandidate,
    generateTestCases,
    TestCaseCandidate,
    checkDuplicateTestCase,
    auditDuplicates,
    dismissDuplicate,
    undismissDuplicate,
    linkAsDuplicate,
    lintRequirement,
    applyLintFinding,
} from '../aiApi';

jest.mock('../axios', () => ({
    __esModule: true,
    default: { post: jest.fn(), delete: jest.fn() },
}));

const mockedPost = axiosPrivate.post as jest.Mock;
const mockedDelete = axiosPrivate.delete as jest.Mock;

describe('api/aiApi.ts', () => {
    beforeEach(() => {
        mockedPost.mockReset();
        mockedDelete.mockReset();
    });

    describe('generateTestCases', () => {
        it('posts requirementId, and omits count/style when not provided', async () => {
            mockedPost.mockResolvedValueOnce({ data: { data: { candidates: [] } } });
            await generateTestCases('req-mongo-id');
            expect(mockedPost).toHaveBeenCalledWith('/api/v1/ai/generate-testcases', {
                requirementId: 'req-mongo-id',
            });
        });

        it('includes count and style when provided', async () => {
            mockedPost.mockResolvedValueOnce({ data: { data: { candidates: [] } } });
            await generateTestCases('req-mongo-id', 4, 'BDD');
            expect(mockedPost).toHaveBeenCalledWith('/api/v1/ai/generate-testcases', {
                requirementId: 'req-mongo-id',
                count: 4,
                style: 'BDD',
            });
        });
    });

    describe('acceptCandidate', () => {
        const candidate: TestCaseCandidate = {
            TestCaseSummary: 'Login with valid credentials',
            description: 'Verify login works',
            TestSteps: [{ testStep: 'Enter credentials', Expected: 'Logged in' }],
        };
        const requirement = { reqId: 'Req-4', requirementSummary: 'Users can log in' };

        it('creates a draft test case with generatedBy:ai and NO createdBy in the body, then two tests-typed links', async () => {
            mockedPost
                .mockResolvedValueOnce({ data: { data: { _id: 'tc-mongo-id', TestCaseId: 'TC-9' } } }) // create test case
                .mockResolvedValueOnce({ data: { data: {} } }) // forward link
                .mockResolvedValueOnce({ data: { data: {} } }); // reverse link

            const result = await acceptCandidate(requirement, candidate);

            expect(mockedPost).toHaveBeenNthCalledWith(1, '/api/v1/testrepo', {
                TestCaseSummary: 'Login with valid credentials',
                TestCaseDescription: 'Verify login works',
                TestSteps: candidate.TestSteps,
                status: 'draft',
                generatedBy: 'ai',
            });
            // createdBy is deliberately absent -- WP-020b: it must be
            // derived server-side from the caller's own token, never
            // trusted from the request body.
            expect(mockedPost.mock.calls[0][1]).not.toHaveProperty('createdBy');

            expect(mockedPost).toHaveBeenNthCalledWith(2, '/api/v1/linkIssue', {
                sourceId: 'TC-9',
                srcModule: 1,
                destinationId: 'Req-4',
                destinationModule: 2,
                srcSummary: 'Login with valid credentials',
                summary: 'Users can log in',
                linkType: 'tests',
            });
            expect(mockedPost).toHaveBeenNthCalledWith(3, '/api/v1/linkIssue', {
                sourceId: 'Req-4',
                srcModule: 2,
                destinationId: 'TC-9',
                destinationModule: 1,
                srcSummary: 'Users can log in',
                summary: 'Login with valid credentials',
                linkType: 'tests',
            });

            expect(result).toEqual({ _id: 'tc-mongo-id', TestCaseId: 'TC-9' });
            expect(mockedDelete).not.toHaveBeenCalled();
        });

        it('falls back TestCaseDescription to the summary when no description was given', async () => {
            mockedPost
                .mockResolvedValueOnce({ data: { data: { _id: 'tc-2', TestCaseId: 'TC-10' } } })
                .mockResolvedValueOnce({ data: { data: {} } })
                .mockResolvedValueOnce({ data: { data: {} } });

            await acceptCandidate(requirement, { ...candidate, description: undefined });

            expect(mockedPost.mock.calls[0][1].TestCaseDescription).toBe('Login with valid credentials');
        });

        it('rolls back (deletes) the created test case if a link call fails, and rethrows', async () => {
            const linkError = new Error('linkIssueService unavailable');
            mockedPost
                .mockResolvedValueOnce({ data: { data: { _id: 'tc-orphan-risk', TestCaseId: 'TC-11' } } })
                .mockRejectedValueOnce(linkError);
            mockedDelete.mockResolvedValueOnce({ data: { success: true } });

            await expect(acceptCandidate(requirement, candidate)).rejects.toBe(linkError);

            expect(mockedDelete).toHaveBeenCalledWith('/api/v1/testrepo/tc-orphan-risk');
        });

        it('swallows a rollback-delete failure rather than masking the original error', async () => {
            const linkError = new Error('linkIssueService unavailable');
            mockedPost
                .mockResolvedValueOnce({ data: { data: { _id: 'tc-orphan-risk-2', TestCaseId: 'TC-12' } } })
                .mockRejectedValueOnce(linkError);
            mockedDelete.mockRejectedValueOnce(new Error('delete also failed'));

            await expect(acceptCandidate(requirement, candidate)).rejects.toBe(linkError);
        });
    });

    // WP-052 -- duplicate detection + requirement ambiguity linting.
    describe('checkDuplicateTestCase', () => {
        it('posts the target fields to check-duplicate-testcase and returns the data envelope', async () => {
            mockedPost.mockResolvedValueOnce({ data: { data: { candidates: [], threshold: 55, scannedCount: 0 } } });
            const result = await checkDuplicateTestCase({
                testCaseId: 'TC-1',
                TestCaseSummary: 'Login test',
                TestCaseDescription: 'desc',
                parentId: 5,
            });
            expect(mockedPost).toHaveBeenCalledWith('/api/v1/ai/check-duplicate-testcase', {
                testCaseId: 'TC-1',
                TestCaseSummary: 'Login test',
                TestCaseDescription: 'desc',
                parentId: 5,
            });
            expect(result).toEqual({ candidates: [], threshold: 55, scannedCount: 0 });
        });
    });

    describe('auditDuplicates', () => {
        it('posts parentId when given', async () => {
            mockedPost.mockResolvedValueOnce({ data: { data: { pairs: [] } } });
            await auditDuplicates(9);
            expect(mockedPost).toHaveBeenCalledWith('/api/v1/ai/audit-duplicates', { parentId: 9 });
        });

        it('posts an empty body when parentId is omitted (whole-project audit)', async () => {
            mockedPost.mockResolvedValueOnce({ data: { data: { pairs: [] } } });
            await auditDuplicates();
            expect(mockedPost).toHaveBeenCalledWith('/api/v1/ai/audit-duplicates', {});
        });
    });

    describe('dismissDuplicate / undismissDuplicate', () => {
        it('dismissDuplicate posts aId/bId', async () => {
            mockedPost.mockResolvedValueOnce({ data: { data: { pairKey: 'TC-1|TC-2', dismissed: true } } });
            const result = await dismissDuplicate('TC-1', 'TC-2');
            expect(mockedPost).toHaveBeenCalledWith('/api/v1/ai/dismiss-duplicate', { aId: 'TC-1', bId: 'TC-2' });
            expect(result).toEqual({ pairKey: 'TC-1|TC-2', dismissed: true });
        });

        it('undismissDuplicate sends aId/bId as the DELETE body', async () => {
            mockedDelete.mockResolvedValueOnce({ data: { data: { pairKey: 'TC-1|TC-2', dismissed: false } } });
            const result = await undismissDuplicate('TC-1', 'TC-2');
            expect(mockedDelete).toHaveBeenCalledWith('/api/v1/ai/dismiss-duplicate', { data: { aId: 'TC-1', bId: 'TC-2' } });
            expect(result).toEqual({ pairKey: 'TC-1|TC-2', dismissed: false });
        });
    });

    describe('linkAsDuplicate', () => {
        it('creates a forward + reverse duplicates-typed link, mirroring acceptCandidate\'s two-document shape', async () => {
            mockedPost.mockResolvedValueOnce({ data: { data: {} } }).mockResolvedValueOnce({ data: { data: {} } });

            await linkAsDuplicate({ testCaseId: 'TC-1', summary: 'A' }, { testCaseId: 'TC-2', summary: 'B' });

            expect(mockedPost).toHaveBeenNthCalledWith(1, '/api/v1/linkIssue', {
                sourceId: 'TC-1',
                srcModule: 1,
                destinationId: 'TC-2',
                destinationModule: 1,
                srcSummary: 'A',
                summary: 'B',
                linkType: 'duplicates',
            });
            expect(mockedPost).toHaveBeenNthCalledWith(2, '/api/v1/linkIssue', {
                sourceId: 'TC-2',
                srcModule: 1,
                destinationId: 'TC-1',
                destinationModule: 1,
                srcSummary: 'B',
                summary: 'A',
                linkType: 'duplicates',
            });
        });
    });

    describe('lintRequirement / applyLintFinding', () => {
        it('lintRequirement posts requirementId', async () => {
            mockedPost.mockResolvedValueOnce({ data: { data: { requirementId: 'req-1', findings: [] } } });
            const result = await lintRequirement('req-1');
            expect(mockedPost).toHaveBeenCalledWith('/api/v1/ai/lint-requirement', { requirementId: 'req-1' });
            expect(result).toEqual({ requirementId: 'req-1', findings: [] });
        });

        it('applyLintFinding posts requirementId/excerpt/suggestedRewrite', async () => {
            mockedPost.mockResolvedValueOnce({ data: { data: { requirementDescription: '{"ops":[{"insert":"x\\n"}]}' } } });
            const result = await applyLintFinding('req-1', 'some', 'a specific number of');
            expect(mockedPost).toHaveBeenCalledWith('/api/v1/ai/apply-lint-finding', {
                requirementId: 'req-1',
                excerpt: 'some',
                suggestedRewrite: 'a specific number of',
            });
            expect(result).toEqual({ requirementDescription: '{"ops":[{"insert":"x\\n"}]}' });
        });
    });
});
