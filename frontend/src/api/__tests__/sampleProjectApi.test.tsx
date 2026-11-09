import axiosPrivate from '../axios';
import { seedSampleProject, SampleSeedError } from '../sampleProjectApi';
import {
    SAMPLE_DEFECT,
    SAMPLE_REQUIREMENTS,
    SAMPLE_TEST_CASES
} from '../../data/sampleBankingProject';

// WP-133 — the seeder, and the content's own invariants.
//
// Two different jobs here, and the second is the more valuable one.
//
// 1. The seeder sends the payload shapes the services actually accept. Most of
//    that was verified live, but one mistake was silent: the defect links were
//    first written with module id 3, every call returned 201, and the
//    traceability report showed nothing. There is no validation on those
//    numbers, so only a report notices a wrong one. Hence an explicit
//    assertion on the module ids.
//
// 2. The CONTENT keeps the properties the whole WP rests on. The sample is
//    valuable because every report has something real to say: a coverage gap,
//    a failing test, a blocked test, an unexecuted test, and a defect joining a
//    requirement to a case. Those are properties of the prose, and prose gets
//    edited. Without these assertions someone could tidy the content into
//    something uniformly green and silently destroy the reason it exists.
jest.mock('../axios', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() }
}));

const post = (axiosPrivate as any).post as jest.Mock;

// Minimal server stand-in: returns the generated ids the seeder threads
// through, so link payloads can be asserted against real values.
function wireHappyPath() {
    let reqN = 0;
    let caseN = 0;
    post.mockImplementation((url: string) => {
        if (url === '/api/v1/sharedstep') return Promise.resolve({ data: { data: { _id: 'ss-mongo-1' } } });
        if (url === '/api/v1/dataset') return Promise.resolve({ data: { data: { id: 1 } } });
        if (url === '/api/v1/requirement') {
            reqN += 1;
            return Promise.resolve({ data: { data: { reqId: `Req-${reqN}` } } });
        }
        if (url === '/api/v1/testrepo') {
            caseN += 1;
            return Promise.resolve({ data: { data: { TestCaseId: `TC-${caseN}` } } });
        }
        if (url === '/api/v1/testplan') return Promise.resolve({ data: { data: { _id: 'plan-mongo-1' } } });
        if (url === '/api/v1/testexecution') return Promise.resolve({ data: { data: { id: 1 } } });
        if (url === '/api/v1/defects') return Promise.resolve({ data: { data: { defectId: 'Bug-1' } } });
        if (url === '/api/v1/linkIssue') return Promise.resolve({ data: { data: { id: 1 } } });
        if (url === '/api/v1/releases') return Promise.resolve({ data: { data: { id: 1 } } });
        return Promise.reject(new Error(`unexpected POST ${url}`));
    });
}

const callsTo = (url: string) => post.mock.calls.filter((c) => c[0] === url);

beforeEach(() => {
    jest.clearAllMocks();
    wireHappyPath();
});

describe('WP-133: the sample content keeps the properties the reports need', () => {
    it('has a requirement with no test coverage, so coverage shows a real gap', () => {
        const covered = new Set(SAMPLE_TEST_CASES.flatMap((tc) => tc.covers));
        const uncovered = SAMPLE_REQUIREMENTS.filter((r) => !covered.has(r.key));
        // Exactly one: zero makes coverage a vacuous 100%, and several makes
        // the sample look neglected rather than realistic.
        expect(uncovered).toHaveLength(1);
    });

    it('has a mix of results, not a uniformly green run', () => {
        const by = (r: string) => SAMPLE_TEST_CASES.filter((tc) => tc.result === r).length;
        expect(by('fail')).toBeGreaterThanOrEqual(1);
        expect(by('blocked')).toBeGreaterThanOrEqual(1);
        expect(by('pass')).toBeGreaterThanOrEqual(1);
        // Unexecuted cases are a real state plan-progress distinguishes.
        expect(SAMPLE_TEST_CASES.filter((tc) => !tc.result).length).toBeGreaterThanOrEqual(1);
    });

    it('the defect joins a requirement and a failing case that both exist', () => {
        // The double link is what makes a traceability row carry a test AND a
        // defect. A typo in either key would produce links to nothing, with
        // every request still returning 201.
        const failing = SAMPLE_TEST_CASES.find((tc) => tc.key === SAMPLE_DEFECT.failsTestCase);
        expect(failing).toBeDefined();
        expect(failing!.result).toBe('fail');
        expect(SAMPLE_REQUIREMENTS.some((r) => r.key === SAMPLE_DEFECT.coversRequirement)).toBe(true);
        expect(failing!.covers).toContain(SAMPLE_DEFECT.coversRequirement);
    });

    it('every test case covers a requirement that exists', () => {
        const keys = new Set(SAMPLE_REQUIREMENTS.map((r) => r.key));
        for (const tc of SAMPLE_TEST_CASES) {
            for (const k of tc.covers) {
                expect(keys).toContain(k);
            }
        }
    });

    it('requirement lifecycle states are spread, not all approved', () => {
        const states = new Set(SAMPLE_REQUIREMENTS.map((r) => r.status));
        expect(states.size).toBeGreaterThan(1);
    });

    it('every case has at least one step with an expected result', () => {
        for (const tc of SAMPLE_TEST_CASES) {
            expect(tc.steps.length).toBeGreaterThan(0);
            for (const s of tc.steps) {
                expect(s.testStep.trim().length).toBeGreaterThan(0);
                expect(s.Expected.trim().length).toBeGreaterThan(0);
            }
        }
    });
});

describe('WP-133: seedSampleProject', () => {
    it('creates everything, in an order that lets later objects reference earlier ones', async () => {
        const result = await seedSampleProject(42);
        expect(result.requirements).toBe(SAMPLE_REQUIREMENTS.length);
        expect(result.testCases).toBe(SAMPLE_TEST_CASES.length);
        expect(callsTo('/api/v1/sharedstep')).toHaveLength(1);
        expect(callsTo('/api/v1/dataset')).toHaveLength(1);
        expect(callsTo('/api/v1/testplan')).toHaveLength(1);
        expect(callsTo('/api/v1/testexecution')).toHaveLength(1);
        expect(callsTo('/api/v1/defects')).toHaveLength(1);
        expect(callsTo('/api/v1/releases')).toHaveLength(1);
    });

    it('stamps X-Project-Id on every call rather than trusting the interceptor', async () => {
        // api/axios.tsx injects whichever project route last mounted, which is
        // not necessarily the project being seeded.
        await seedSampleProject(42);
        for (const call of post.mock.calls) {
            expect(call[2]).toEqual({ headers: { 'X-Project-Id': '42' } });
        }
    });

    it('links the defect with module id 5, not 3 — the bug that failed silently', async () => {
        await seedSampleProject(42);
        const defectLinks = callsTo('/api/v1/linkIssue')
            .map((c) => c[1])
            .filter((b: any) => String(b.sourceId).startsWith('Bug-'));
        expect(defectLinks).toHaveLength(2);
        for (const link of defectLinks) {
            // 3 produced 201s and an empty traceability report.
            expect(link.srcModule).toBe(5);
        }
        // One edge to a case, one to a requirement.
        expect(defectLinks.map((l: any) => l.destinationModule).sort()).toEqual([1, 2]);
    });

    it('links requirements to cases as REQUIREMENT(2) -> TEST_CASE(1)', async () => {
        await seedSampleProject(42);
        const covLinks = callsTo('/api/v1/linkIssue')
            .map((c) => c[1])
            .filter((b: any) => String(b.sourceId).startsWith('Req-'));
        const expected = SAMPLE_TEST_CASES.reduce((n, tc) => n + tc.covers.length, 0);
        expect(covLinks).toHaveLength(expected);
        for (const link of covLinks) {
            expect(link.srcModule).toBe(2);
            expect(link.destinationModule).toBe(1);
        }
    });

    it("sends unexecuted cases as 'No Run' rather than omitting them", async () => {
        await seedSampleProject(42);
        const body = callsTo('/api/v1/testexecution')[0][1] as any;
        expect(body.TestCases).toHaveLength(SAMPLE_TEST_CASES.length);
        const notRun = body.TestCases.filter((c: any) => c.TestStatus === 'No Run');
        expect(notRun.length).toBe(SAMPLE_TEST_CASES.filter((tc) => !tc.result).length);
        // Attached to the plan, or the release's pass-rate gate has nothing to
        // measure and evaluates as unmet.
        expect(body.TestPlanId).toBe('plan-mongo-1');
    });

    it('attaches the plan to the release so its quality gates can evaluate', async () => {
        await seedSampleProject(42);
        const body = callsTo('/api/v1/releases')[0][1] as any;
        expect(body.linkedTestPlanIds).toEqual(['plan-mongo-1']);
        expect(body.qualityGates.map((g: any) => g.type).sort()).toEqual(['maxOpenDefects', 'minPassRate']);
    });

    it('names the step that failed instead of failing generically', async () => {
        post.mockImplementation((url: string) => {
            if (url === '/api/v1/sharedstep') return Promise.resolve({ data: { data: { _id: 'ss-1' } } });
            if (url === '/api/v1/dataset') return Promise.reject({ response: { data: { error: 'nope' } } });
            return Promise.resolve({ data: { data: {} } });
        });
        // Because there is no rollback, "which step" is the only way a user can
        // tell what state the project is in.
        await expect(seedSampleProject(42)).rejects.toThrow(SampleSeedError);
        await expect(seedSampleProject(42)).rejects.toThrow(/creating the dataset.*nope/);
    });

    it('reports progress for each step', async () => {
        const seen: string[] = [];
        await seedSampleProject(42, (p) => seen.push(p.step));
        expect(seen).toContain('creating requirements');
        expect(seen).toContain('recording the test run');
        expect(seen[seen.length - 1]).toBe('done');
    });
});
