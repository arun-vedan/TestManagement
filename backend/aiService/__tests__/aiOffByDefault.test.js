// WP-156 — AI off by default, time-boxed on request.
//
// The default used to be opt-OUT: a project with no settings document had AI
// ENABLED, so every new tenant on a self-serve product started spending
// against the provider without anyone choosing to. It is now opt-in, with an
// optional expiry.
//
// UNIT-LEVEL ON PURPOSE, for two reasons. The behaviour under test is a
// decision made from one document and the clock, and a live suite would have
// to stand up a provider to reach the routes behind this gate -- which is
// exactly what is unavailable in this environment (aiService's live suites
// currently fail with 503 from an absent provider). It also keeps this change
// out of aiService's live test files, which another session is working in.
//
// What the acceptance asks for, each covered below: disabled by default, works
// inside a window, and stops automatically when the window expires.

const { ErrorResponse } = require('@srckube/service-core');

jest.mock('../models/AiProjectSettings', () => ({ findOne: jest.fn() }));
const AiProjectSettings = require('../models/AiProjectSettings');
const { checkProjectEnabled } = require('../middleware/checkProjectEnabled');

function run(settings) {
    AiProjectSettings.findOne.mockResolvedValue(settings);
    const req = { projectScope: { projectId: 42 } };
    return new Promise((resolve) => {
        checkProjectEnabled(req, {}, (err) => resolve(err));
    });
}

const HOUR = 60 * 60 * 1000;

// WP-166 — the deployment-wide switch is checked BEFORE everything WP-156
// added, and it is OFF for the closed beta. Without this the suite below
// would test nothing: every case would stop at the global gate and return its
// message instead of the per-project one.
//
// Set per-test rather than globally so the global layer gets its own
// describe block further down, where turning it off is the point.
beforeEach(() => {
    jest.clearAllMocks();
    process.env.AI_GLOBALLY_ENABLED = 'true';
});

afterEach(() => {
    delete process.env.AI_GLOBALLY_ENABLED;
});

describe('WP-156: AI is off unless a project turns it on', () => {
    it('is DISABLED when the project has no settings document — the new default', async () => {
        // The whole point of the WP. Previously this case passed straight
        // through and the project could spend against the provider.
        const err = await run(null);
        expect(err).toBeInstanceOf(ErrorResponse);
        expect(err.statusCode).toBe(403);
        expect(err.message).toMatch(/AI feature is disabled for this project/i);
        // Actionable: an admin reading this must know who can change it.
        expect(err.message).toMatch(/project admin/i);
    });

    it('is DISABLED when the document exists but enabled is false', async () => {
        const err = await run({ projectId: 42, enabled: false, enabledUntil: null });
        expect(err.statusCode).toBe(403);
    });

    it('is DISABLED when enabled is missing or not strictly true', async () => {
        // Guards against a document written by an older client, or a value
        // like "true" as a string, being treated as enablement.
        for (const value of [undefined, null, 'true', 1, {}]) {
            // eslint-disable-next-line no-await-in-loop
            const err = await run({ projectId: 42, enabled: value });
            expect(err).toBeInstanceOf(ErrorResponse);
            expect(err.statusCode).toBe(403);
        }
    });

    it('is ENABLED when a project turns it on with no expiry', async () => {
        // Indefinite enablement stays possible deliberately: an operator who
        // wants AI on permanently should say so, not work around the window.
        const err = await run({ projectId: 42, enabled: true, enabledUntil: null });
        expect(err).toBeUndefined();
    });

    it('is ENABLED inside the window', async () => {
        const err = await run({
            projectId: 42,
            enabled: true,
            enabledUntil: new Date(Date.now() + HOUR)
        });
        expect(err).toBeUndefined();
    });

    it('STOPS AUTOMATICALLY once the window has passed, with nothing having to run', async () => {
        // The expiry is compared on every request rather than applied by a
        // job that flips the flag back. A scheduled job that fails silently
        // leaves a metered feature switched on; this cannot fail that way.
        const expiry = new Date(Date.now() - HOUR);
        const err = await run({ projectId: 42, enabled: true, enabledUntil: expiry });
        expect(err).toBeInstanceOf(ErrorResponse);
        expect(err.statusCode).toBe(403);
        // A DIFFERENT message from "never enabled" -- someone turned this on
        // and the window ran out, and an admin chasing it needs to know which.
        expect(err.message).toMatch(/that period has ended/i);
        expect(err.message).toContain(expiry.toISOString());
        expect(err.message).not.toMatch(/^AI feature is disabled for this project/);
    });

    it('treats the exact expiry instant as expired, not as the last usable moment', async () => {
        // An inclusive boundary is the safe direction for a cost control.
        const err = await run({ projectId: 42, enabled: true, enabledUntil: new Date(Date.now()) });
        expect(err).toBeInstanceOf(ErrorResponse);
        expect(err.message).toMatch(/that period has ended/i);
    });

    it('propagates a lookup failure instead of silently enabling or disabling', async () => {
        // Failing OPEN would spend money during a database problem; failing
        // closed with a bare 403 would read as "an admin disabled this". The
        // error is passed on so the shared handler reports a server fault.
        AiProjectSettings.findOne.mockRejectedValue(new Error('mongo unavailable'));
        const err = await new Promise((resolve) => {
            checkProjectEnabled({ projectScope: { projectId: 42 } }, {}, resolve);
        });
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(ErrorResponse);
        expect(err.message).toMatch(/mongo unavailable/);
    });
});

// WP-166 — the deployment-wide switch, which sits in FRONT of everything
// above.
//
// Two switches answer two different questions, and conflating them is the
// mistake this block guards against. The per-project flag answers "should this
// project use AI?" and a project admin owns it. This one answers "should this
// deployment offer AI at all?" and only whoever runs the deployment can answer
// it. During the closed beta the answer is no, because the AI features are not
// considered good enough to put in front of testers.
//
// It is also what makes the beta terms honest: they state that customer
// content does not leave vedan during the beta, and the per-project flag alone
// could not support that sentence, because any project admin could flip it.
describe('WP-166: the deployment-wide AI kill switch', () => {
    it('refuses even a project that has AI explicitly enabled', async () => {
        delete process.env.AI_GLOBALLY_ENABLED;
        // The case that matters: an admin HAS turned it on for their project,
        // and it still must not run.
        const err = await run({ enabled: true, enabledUntil: null });
        expect(err).toBeInstanceOf(ErrorResponse);
        expect(err.statusCode).toBe(403);
        expect(err.message).toMatch(/turned off for this deployment/i);
        // Says plainly that the switch they can reach is not the one refusing,
        // so they stop looking in the settings UI.
        expect(err.message).toMatch(/cannot be enabled per project/i);
    });

    it('is textually distinct from the per-project refusal', async () => {
        delete process.env.AI_GLOBALLY_ENABLED;
        const globalErr = await run({ enabled: true, enabledUntil: null });
        process.env.AI_GLOBALLY_ENABLED = 'true';
        const projectErr = await run(null);
        // Both are 403 and both are correct HTTP semantics. What must never be
        // ambiguous is WHICH gate said no -- the same rule WP-050 applied to
        // its three failure cases.
        expect(globalErr.statusCode).toBe(projectErr.statusCode);
        expect(globalErr.message).not.toEqual(projectErr.message);
        expect(projectErr.message).not.toMatch(/deployment/i);
    });

    it('does not consult the database at all when globally off', async () => {
        delete process.env.AI_GLOBALLY_ENABLED;
        await run({ enabled: true, enabledUntil: null });
        // A disabled feature should cost nothing. It also means the switch
        // keeps working if the AI database is unreachable.
        expect(AiProjectSettings.findOne).not.toHaveBeenCalled();
    });

    it('FAILS CLOSED on anything that is not exactly "true"', async () => {
        // The deliberate inversion of the usual feature-flag default. A typo
        // that silently re-enabled a feature which ships content to a
        // third-party provider is worse than one that disables a feature.
        for (const value of ['', 'false', 'FALSE', 'no', '0', 'ture', 'yes', '1']) {
            process.env.AI_GLOBALLY_ENABLED = value;
            // eslint-disable-next-line no-await-in-loop
            const err = await run({ enabled: true, enabledUntil: null });
            expect(err).toBeInstanceOf(ErrorResponse);
            expect(err.message).toMatch(/turned off for this deployment/i);
        }
    });

    it('lets the per-project gate decide once explicitly enabled', async () => {
        // Proves the global switch is a gate in front, not a replacement: with
        // it on, WP-156's behaviour is unchanged.
        process.env.AI_GLOBALLY_ENABLED = 'TRUE';
        expect(await run({ enabled: true, enabledUntil: null })).toBeUndefined();
        expect((await run(null)).message).toMatch(/disabled for this project/i);
    });
});
