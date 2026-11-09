import axiosPrivate from './axios';
import { PROJECT_ID_HEADER } from '../currentProject';
import {
    SAMPLE_DATASET,
    SAMPLE_DEFECT,
    SAMPLE_RELEASE,
    SAMPLE_REQUIREMENTS,
    SAMPLE_SHARED_STEP,
    SAMPLE_TEST_CASES,
    SAMPLE_TEST_PLAN
} from '../data/sampleBankingProject';

// WP-133 — seeds the sample project's content.
//
// WHY THIS RUNS IN THE FRONTEND rather than as a backend endpoint. The content
// spans seven services (requirement, testrepo, sharedstep, dataset, testplan,
// testexecution, defects, linkIssue, releases). A backend seeder would need
// either service-to-service calls with their own authorisation, or a new
// privileged write path that bypasses the per-project authorize() checks every
// other write goes through. Doing it here means every object is created by the
// signed-in user, with their own token, through the same endpoints and the same
// permission checks as if they had typed it in. There is no new way to write
// data, which is the property worth protecting after WP-110's tenancy work.
//
// It is also what the acceptance asks for: "one click from the empty state".
//
// NO ROLLBACK, DELIBERATELY. If a call fails partway, earlier objects stay.
// Unwinding writes across seven services is a distributed transaction, and a
// half-built rollback is worse than none: it can delete a user's real data if
// the seeder is ever pointed at a non-empty project. Instead the caller is told
// exactly which step failed, and the project is left in a state the user can
// inspect or delete. The guard against seeding a project that already has
// content belongs at the call site (the empty state only renders when empty).
//
// Every payload shape here was verified against the running services before
// being written, not read off the models: the dataset takes title + columns +
// rows as arrays of strings (not objects), reports live at /api/v1/reports
// (not /reporting), links carry srcModule/destinationModule as numbers with
// TEST_CASE=1 and REQUIREMENT=2, and the execution status vocabulary is
// pass/fail/blocked with 'No Run' as the unexecuted default.

// Module ids as the REPORTS define them, not as guessed. DEFECT is 5, not 3:
// the first run of this seeder created the defect links with 3, every call
// returned 201, and the traceability report showed zero rows carrying both a
// test case and a defect -- the links existed and nothing read them. There is
// no validation on these numbers, so a wrong one fails silently and only a
// report notices. Verified against reportingService/services/traceability.js
// and linkIssueService/controllers/linkIssue.js.
const MODULE = { TEST_CASE: 1, REQUIREMENT: 2, DEFECT: 5 } as const;

export interface SeedProgress {
    step: string;
    done: number;
    total: number;
}

export interface SeedResult {
    requirements: number;
    testCases: number;
    links: number;
    executed: number;
    defects: number;
    releases: number;
}

export class SampleSeedError extends Error {
    constructor(public step: string, cause: unknown) {
        const detail =
            (cause as any)?.response?.data?.error ||
            (cause as any)?.message ||
            'unknown error';
        super(`Sample data failed while ${step}: ${detail}`);
        this.name = 'SampleSeedError';
    }
}

export async function seedSampleProject(
    projectId: number,
    onProgress?: (p: SeedProgress) => void
): Promise<SeedResult> {
    // Set explicitly rather than relying on api/axios.tsx's interceptor: that
    // reads whichever /projects/:projectId route last mounted, which is not
    // necessarily the project being seeded. The interceptor deliberately does
    // not override a caller-supplied value.
    const h = { headers: { [PROJECT_ID_HEADER]: String(projectId) } };

    // Named steps so a failure says which one, and so progress is meaningful
    // rather than a spinner.
    const TOTAL = 9;
    let done = 0;
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        onProgress?.({ step: name, done, total: TOTAL });
        try {
            const out = await fn();
            done += 1;
            return out;
        } catch (err) {
            throw new SampleSeedError(name, err);
        }
    };

    // 1. the shared step, first, because test cases reference it
    const sharedStep = await step('creating the shared step', async () => {
        const resp = await axiosPrivate.post('/api/v1/sharedstep', SAMPLE_SHARED_STEP, h);
        return resp.data.data;
    });

    // 2. the dataset
    await step('creating the dataset', () => axiosPrivate.post('/api/v1/dataset', SAMPLE_DATASET, h));

    // 3. requirements. `status` is accepted at creation, so the lifecycle
    //    spread needs no transition calls.
    const reqIdByKey = await step('creating requirements', async () => {
        const map: Record<string, string> = {};
        for (const r of SAMPLE_REQUIREMENTS) {
            // eslint-disable-next-line no-await-in-loop
            const resp = await axiosPrivate.post(
                '/api/v1/requirement',
                {
                    requirementSummary: r.summary,
                    requirementDescription: r.description,
                    status: r.status
                },
                h
            );
            map[r.key] = resp.data.data.reqId;
        }
        return map;
    });

    // 4. test cases. A case that uses the shared step gets it as its first
    //    step entry, referencing it by id rather than copying its text.
    const caseIdByKey = await step('creating test cases', async () => {
        const map: Record<string, string> = {};
        for (const tc of SAMPLE_TEST_CASES) {
            const steps = tc.usesSharedStep
                ? [
                      {
                          testStep: SAMPLE_SHARED_STEP.title,
                          Expected: 'The account overview is shown',
                          sharedStepId: sharedStep._id,
                          sharedStepTitle: SAMPLE_SHARED_STEP.title
                      },
                      ...tc.steps
                  ]
                : tc.steps;
            // eslint-disable-next-line no-await-in-loop
            const resp = await axiosPrivate.post(
                '/api/v1/testrepo',
                {
                    TestCaseSummary: tc.summary,
                    TestCaseDescription: tc.description,
                    testSteps: steps
                },
                h
            );
            map[tc.key] = resp.data.data.TestCaseId;
        }
        return map;
    });

    // 5. requirement <-> test case links. These are what the coverage and
    //    traceability reports read; without them both render empty no matter
    //    how many requirements and cases exist.
    let links = 0;
    await step('linking requirements to test cases', async () => {
        for (const tc of SAMPLE_TEST_CASES) {
            for (const reqKey of tc.covers) {
                // eslint-disable-next-line no-await-in-loop
                await axiosPrivate.post(
                    '/api/v1/linkIssue',
                    {
                        sourceId: reqIdByKey[reqKey],
                        srcModule: MODULE.REQUIREMENT,
                        destinationId: caseIdByKey[tc.key],
                        destinationModule: MODULE.TEST_CASE,
                        summary: tc.summary,
                        linkType: 'relates-to'
                    },
                    h
                );
                links += 1;
            }
        }
    });

    // 6. the test plan
    const plan = await step('creating the test plan', async () => {
        const resp = await axiosPrivate.post(
            '/api/v1/testplan',
            { testPlanName: SAMPLE_TEST_PLAN.name, description: SAMPLE_TEST_PLAN.description },
            h
        );
        return resp.data.data;
    });

    // 7. one executed run with mixed results. Cases with no `result` are sent
    //    as 'No Run' rather than omitted, so plan progress can distinguish
    //    "not executed yet" from "not in the plan".
    const executed = await step('recording the test run', async () => {
        const cases = SAMPLE_TEST_CASES.map((tc) => ({
            TestCaseId: caseIdByKey[tc.key],
            TestCaseSummary: tc.summary,
            TestStatus: tc.result ?? 'No Run',
            TestSteps: tc.steps.map((s) => ({
                testStep: s.testStep,
                Expected: s.Expected,
                status: tc.result ?? 'No Run'
            }))
        }));
        await axiosPrivate.post(
            '/api/v1/testexecution',
            { TestPlanId: plan._id, TestCases: cases },
            h
        );
        return SAMPLE_TEST_CASES.filter((tc) => tc.result).length;
    });

    // 8. the defect, linked to BOTH the failing case and the requirement it
    //    covers. The double link is what makes a traceability row carry a test
    //    and a defect at once.
    await step('raising the defect and linking it', async () => {
        const resp = await axiosPrivate.post(
            '/api/v1/defects',
            {
                summary: SAMPLE_DEFECT.summary,
                Description: SAMPLE_DEFECT.description,
                Severity: SAMPLE_DEFECT.severity,
                Status: SAMPLE_DEFECT.status
            },
            h
        );
        const defect = resp.data.data;
        const defectKey = defect.defectId || defect.DefectId || String(defect.id);

        await axiosPrivate.post(
            '/api/v1/linkIssue',
            {
                sourceId: defectKey,
                srcModule: MODULE.DEFECT,
                destinationId: caseIdByKey[SAMPLE_DEFECT.failsTestCase],
                destinationModule: MODULE.TEST_CASE,
                summary: SAMPLE_DEFECT.summary,
                linkType: 'relates-to'
            },
            h
        );
        links += 1;
        await axiosPrivate.post(
            '/api/v1/linkIssue',
            {
                sourceId: defectKey,
                srcModule: MODULE.DEFECT,
                destinationId: reqIdByKey[SAMPLE_DEFECT.coversRequirement],
                destinationModule: MODULE.REQUIREMENT,
                summary: SAMPLE_DEFECT.summary,
                linkType: 'relates-to'
            },
            h
        );
        links += 1;
    });

    // 9. the release, with its plan attached so the pass-rate gate has
    //    something to measure. linkedTestPlanIds holds TestPlan _id strings.
    await step('creating the release and its quality gates', () =>
        axiosPrivate.post(
            '/api/v1/releases',
            {
                name: SAMPLE_RELEASE.name,
                status: SAMPLE_RELEASE.status,
                notes: SAMPLE_RELEASE.notes,
                linkedTestPlanIds: [plan._id],
                qualityGates: SAMPLE_RELEASE.qualityGates
            },
            h
        )
    );

    onProgress?.({ step: 'done', done: TOTAL, total: TOTAL });

    return {
        requirements: SAMPLE_REQUIREMENTS.length,
        testCases: SAMPLE_TEST_CASES.length,
        links,
        executed,
        defects: 1,
        releases: 1
    };
}
