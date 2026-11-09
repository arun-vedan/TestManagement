// WP-135 (partial) — the per-tenant storage ceiling.
//
// Unit-tested rather than exercised live because the default quota is 2 GiB:
// a live test would have to upload two gigabytes to cross it, which is a slow,
// disk-hungry way to assert a comparison. The live suite
// (uploadLimits.test.js) covers the per-file cap and the type allow-list,
// which are the limits that CAN be crossed cheaply.
//
// What matters here is the behaviour at and around the boundary, and the
// failure posture when the usage figure cannot be read at all.

jest.mock('mongoose', () => ({
    connection: { db: { collection: jest.fn() } }
}));

const mongoose = require('mongoose');

function wireUsage(result) {
    const toArray = typeof result === 'function' ? result : () => Promise.resolve(result);
    mongoose.connection.db.collection.mockReturnValue({
        aggregate: () => ({ toArray })
    });
}

function runMiddleware(req) {
    // eslint-disable-next-line global-require
    const { requireProjectStorageQuota } = require('../middleware/projectStorageQuota');
    const res = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
    let nextCalled = false;
    return requireProjectStorageQuota()(req, res, () => { nextCalled = true; }).then(() => ({
        res,
        nextCalled
    }));
}

const ORIGINAL = { ...process.env };

// NO jest.resetModules() here, deliberately. Resetting the registry hands the
// middleware a FRESH mongoose mock from the factory above, while this file
// still holds the old one -- so every configured usage figure was invisible to
// the code under test and every case failed as a 503. It is also unnecessary:
// the limits are read from process.env at CALL time (see intFromEnv in
// utils/upload.js), not at import, so changing an env var between tests needs
// no reload.
beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.UPLOAD_MAX_PROJECT_BYTES;
});
afterAll(() => { process.env = ORIGINAL; });

describe('WP-135: requireProjectStorageQuota', () => {
    it('lets an upload through when the project is under quota, and reports the remaining allowance', async () => {
        process.env.UPLOAD_MAX_PROJECT_BYTES = String(1000);
        wireUsage([{ _id: null, bytes: 400, files: 3 }]);
        const req = { projectScope: { projectId: 42 } };
        const { nextCalled, res } = await runMiddleware(req);
        expect(nextCalled).toBe(true);
        expect(res.statusCode).toBeNull();
        // Surfaced so a UI can show remaining allowance without a second call.
        expect(req.projectStorage).toEqual({
            usedBytes: 400, files: 3, quotaBytes: 1000, remainingBytes: 600
        });
    });

    it('lets an empty project through', async () => {
        wireUsage([]); // no files at all -> the aggregate returns nothing
        const { nextCalled } = await runMiddleware({ projectScope: { projectId: 42 } });
        expect(nextCalled).toBe(true);
    });

    it('refuses with 413 once usage reaches the quota, and says what to do about it', async () => {
        process.env.UPLOAD_MAX_PROJECT_BYTES = String(10 * 1024 * 1024);
        wireUsage([{ _id: null, bytes: 10 * 1024 * 1024, files: 7 }]);
        const { nextCalled, res } = await runMiddleware({ projectScope: { projectId: 42 } });
        expect(nextCalled).toBe(false);
        expect(res.statusCode).toBe(413);
        expect(String(res.body.error)).toMatch(/10 MiB of its 10 MiB/);
        expect(String(res.body.error)).toMatch(/7 files/);
        // Actionable, per the WP's acceptance -- a bare 413 tells a user
        // nothing they can act on.
        expect(String(res.body.error)).toMatch(/delete some attachments/i);
    });

    it('is inclusive at the boundary: exactly-at-quota is refused, one byte under is allowed', async () => {
        process.env.UPLOAD_MAX_PROJECT_BYTES = String(1000);

        wireUsage([{ _id: null, bytes: 1000, files: 1 }]);
        const atQuota = await runMiddleware({ projectScope: { projectId: 1 } });
        expect(atQuota.res.statusCode).toBe(413);

        wireUsage([{ _id: null, bytes: 999, files: 1 }]);
        const underQuota = await runMiddleware({ projectScope: { projectId: 1 } });
        expect(underQuota.nextCalled).toBe(true);
    });

    it('FAILS CLOSED with 503 when the usage figure cannot be read', async () => {
        // Deliberately the opposite posture to aiService's rate limiter, which
        // fails OPEN on a Redis blip because a cost cap must not take the
        // product down. This is a storage ceiling backed by the SAME database
        // the upload is about to be written to: if the aggregate cannot run,
        // the write is unlikely to succeed either, and passing uploads through
        // unmetered during a database problem is how a disk fills.
        wireUsage(() => Promise.reject(new Error('connection lost')));
        const { nextCalled, res } = await runMiddleware({ projectScope: { projectId: 42 } });
        expect(nextCalled).toBe(false);
        expect(res.statusCode).toBe(503);
        expect(String(res.body.error)).toMatch(/cannot verify/i);
    });

    it('refuses rather than skipping the check when there is no verified project scope', async () => {
        // Mounted after requireProjectScope(), so this is a wiring mistake,
        // not an anonymous caller. Skipping the quota because the scope is
        // missing would make the ceiling optional.
        wireUsage([{ _id: null, bytes: 0, files: 0 }]);
        const { nextCalled, res } = await runMiddleware({});
        expect(nextCalled).toBe(false);
        expect(res.statusCode).toBe(500);
    });

    it('filters usage to the calling project, not the whole bucket', async () => {
        // GridFS stores tenancy at metadata.projectId (uploadService has no
        // Mongoose model). Aggregating without that $match would bill every
        // project for every other project's files.
        let pipeline;
        mongoose.connection.db.collection.mockReturnValue({
            aggregate: (p) => { pipeline = p; return { toArray: () => Promise.resolve([]) }; }
        });
        await runMiddleware({ projectScope: { projectId: 77 } });
        expect(pipeline[0]).toEqual({ $match: { 'metadata.projectId': 77 } });
        expect(mongoose.connection.db.collection).toHaveBeenCalledWith('filesBucket.files');
    });
});
