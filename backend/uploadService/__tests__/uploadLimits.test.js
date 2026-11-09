const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-135 (partial) — abuse and cost controls on upload.
//
// Before this, utils/upload.js was `multer({ storage })`: no limits, no
// fileFilter. No per-file cap, no type restriction, no per-tenant ceiling.
// With self-serve signup live that is free, unlimited file hosting, and one
// request could exhaust the disk behind Mongo.
//
// Two halves to this suite, and the split is deliberate:
//
//   - The CONFIG tests are pure unit tests. They cover the thing most likely
//     to rot silently: that a malformed or missing env var falls back to the
//     safe default rather than to Infinity or NaN. A typo in a cap must never
//     remove the cap, and nothing about that needs a container.
//
//   - The LIVE tests go through Kong against the running service, because the
//     limits are enforced by middleware ordering (quota before multer, error
//     translation after) and ordering is exactly what a unit test of the
//     config cannot check.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const runId = Date.now();

describe('WP-135: upload caps — configuration', () => {
    const ORIGINAL = { ...process.env };

    beforeEach(() => {
        jest.resetModules();
        delete process.env.UPLOAD_MAX_FILE_BYTES;
        delete process.env.UPLOAD_MAX_PROJECT_BYTES;
        delete process.env.UPLOAD_MAX_FILES_PER_REQUEST;
        delete process.env.UPLOAD_ALLOWED_MIME_TYPES;
        delete process.env.UPLOAD_ALLOWED_EXTENSIONS;
    });
    afterAll(() => { process.env = ORIGINAL; });

    function load() {
        // eslint-disable-next-line global-require
        return require('../utils/upload');
    }

    it('has conservative defaults when nothing is configured', () => {
        const u = load();
        expect(u.maxFileBytes()).toBe(25 * 1024 * 1024);
        expect(u.maxProjectBytes()).toBe(2048 * 1024 * 1024);
        expect(u.maxFilesPerRequest()).toBe(10);
    });

    it('honours the owner-supplied numbers', () => {
        process.env.UPLOAD_MAX_FILE_BYTES = String(5 * 1024 * 1024);
        process.env.UPLOAD_MAX_PROJECT_BYTES = String(100 * 1024 * 1024);
        process.env.UPLOAD_MAX_FILES_PER_REQUEST = '3';
        const u = load();
        expect(u.maxFileBytes()).toBe(5 * 1024 * 1024);
        expect(u.maxProjectBytes()).toBe(100 * 1024 * 1024);
        expect(u.maxFilesPerRequest()).toBe(3);
    });

    it.each([['garbage'], [''], ['0'], ['-1'], ['1e9'], ['Infinity'], ['null']])(
        'falls back to the default rather than removing the cap when the value is %p',
        (value) => {
            // The failure that matters: a typo in a cap must not become "no
            // cap". Every one of these would otherwise parse to NaN, 0,
            // negative or Infinity and disable the limit.
            process.env.UPLOAD_MAX_FILE_BYTES = value;
            expect(load().maxFileBytes()).toBe(25 * 1024 * 1024);
        }
    );

    it('allows the types a test-management tool needs', () => {
        const types = load().allowedMimeTypes();
        ['image/png', 'application/pdf', 'text/plain', 'text/csv', 'application/json', 'application/xml']
            .forEach((t) => expect(types).toContain(t));
    });

    it('does NOT allow script-capable or executable types by default', () => {
        const types = load().allowedMimeTypes();
        // svg and html can carry script. The download route sets
        // Content-Disposition: attachment today, but an allow-list should not
        // depend on a header elsewhere staying correct.
        ['image/svg+xml', 'text/html', 'application/x-msdownload', 'application/x-sh', 'application/octet-stream']
            .forEach((t) => expect(types).not.toContain(t));
        expect(load().allowedExtensions()).not.toContain('.svg');
        expect(load().allowedExtensions()).not.toContain('.exe');
    });

    it('lets the owner replace the allow-list entirely', () => {
        process.env.UPLOAD_ALLOWED_MIME_TYPES = 'image/png, application/pdf';
        expect(load().allowedMimeTypes()).toEqual(['image/png', 'application/pdf']);
    });

    it('an empty allow-list falls back to the default rather than allowing nothing or everything', () => {
        process.env.UPLOAD_ALLOWED_MIME_TYPES = '   ,  ,';
        expect(load().allowedMimeTypes().length).toBeGreaterThan(5);
    });
});

describe('WP-135: upload caps — live, through Kong', () => {
    let client;
    let projectId;

    beforeAll(async () => {
        const token = await getServiceToken();
        const admin = axios.create({
            baseURL: KONG_URL,
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true
        });
        const org = await admin.post('/api/v1/organizations', {
            name: `wp135 org ${runId}`,
            key: `wp135-${runId}`
        });
        expect(org.status).toBe(201);
        trackOrganization(org.data.data._id);
        const proj = await admin.post('/api/v1/projects', {
            name: `wp135 project ${runId}`,
            key: `w135${String(runId).slice(-6)}`,
            organizationId: org.data.data._id
        });
        expect(proj.status).toBe(201);
        projectId = proj.data.data.id;
        trackProject(projectId);

        client = axios.create({
            baseURL: KONG_URL,
            headers: { Authorization: `Bearer ${token}`, 'X-Project-Id': String(projectId) },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            validateStatus: () => true
        });
    }, 120000);

    async function postFile({ name, type, bytes }) {
        const form = new FormData();
        form.append('file', Buffer.alloc(bytes, 0x41), { filename: name, contentType: type });
        return client.post('/api/v1/attachment/upload/file', form, {
            headers: form.getHeaders()
        });
    }

    it('accepts a normal, allowed attachment', async () => {
        const resp = await postFile({ name: 'screenshot.png', type: 'image/png', bytes: 2048 });
        expect(resp.status).toBe(201);
        expect(resp.data.fileID).toBeTruthy();
    }, 60000);

    it('refuses a file over the per-file cap with 413 and an actionable message', async () => {
        // 30 MiB against the 25 MiB default.
        const resp = await postFile({ name: 'huge.png', type: 'image/png', bytes: 30 * 1024 * 1024 });
        expect(resp.status).toBe(413);
        // The acceptance asks for actionable messages, not a bare status: a
        // user who cannot see the limit cannot comply with it.
        expect(String(resp.data.error)).toMatch(/larger than/i);
        expect(String(resp.data.error)).toMatch(/25 MiB/);
    }, 120000);

    it('refuses a disallowed MIME type with 415, naming what is allowed', async () => {
        const resp = await postFile({ name: 'payload.svg', type: 'image/svg+xml', bytes: 512 });
        expect(resp.status).toBe(415);
        expect(String(resp.data.error)).toMatch(/not accepted/i);
        expect(String(resp.data.error)).toMatch(/image\/png/);
    }, 60000);

    it('refuses a disallowed EXTENSION even when the MIME type is spoofed to an allowed one', async () => {
        // The mimetype is client-supplied, so the allow-list over it is only
        // as honest as the client. Checking the extension too raises the bar:
        // an .exe labelled image/png is still refused.
        const resp = await postFile({ name: 'payload.exe', type: 'image/png', bytes: 512 });
        expect(resp.status).toBe(415);
        expect(String(resp.data.error)).toMatch(/extension/i);
    }, 60000);

    it('still enforces tenancy on upload — an outsider cannot write to this project', async () => {
        // The caps must not have displaced the WP-112 scoping that was
        // already there; middleware was reordered to add them.
        const outsider = await createTestPersona('wp135-outsider');
        try {
            const anon = axios.create({
                baseURL: KONG_URL,
                headers: {
                    Authorization: `Bearer ${await outsider.getToken()}`,
                    'X-Project-Id': String(projectId)
                },
                validateStatus: () => true
            });
            const form = new FormData();
            form.append('file', Buffer.alloc(256, 0x41), { filename: 'x.png', contentType: 'image/png' });
            const resp = await anon.post('/api/v1/attachment/upload/file', form, { headers: form.getHeaders() });
            expect(resp.status).toBe(403);
        } finally {
            await outsider.cleanup();
        }
    }, 120000);

    it('an unauthenticated upload is rejected at the gateway', async () => {
        const anon = axios.create({ baseURL: KONG_URL, validateStatus: () => true });
        const form = new FormData();
        form.append('file', Buffer.alloc(64, 0x41), { filename: 'x.png', contentType: 'image/png' });
        const resp = await anon.post('/api/v1/attachment/upload/file', form, { headers: form.getHeaders() });
        expect(resp.status).toBe(401);
    }, 60000);
});

describe('WP-135 follow-up: Content-Disposition for a user-supplied filename', () => {
    // eslint-disable-next-line global-require
    const { contentDisposition } = require('../utils/upload');

    it('quotes the ASCII fallback and adds the RFC 5987 encoded form', () => {
        expect(contentDisposition('screenshot.png')).toBe(
            'attachment; filename="screenshot.png"; filename*=UTF-8\'\'screenshot.png'
        );
    });

    it('neutralises a quote in the filename instead of breaking the header', () => {
        // The route used to interpolate this raw: `filename=my "report".pdf`
        // ends the quoted string early and the rest is read as another
        // parameter.
        const header = contentDisposition('my "report".pdf');
        expect(header).toContain('filename="my _report_.pdf"');
        // The real name survives in the encoded form.
        expect(header).toContain('%22report%22');
    });

    it('keeps a semicolon or comma safe inside the quoted form', () => {
        const header = contentDisposition('a;b,c.txt');
        expect(header).toContain('filename="a;b,c.txt"');
        expect(header).toContain("filename*=UTF-8''a%3Bb%2Cc.txt");
    });

    it('carries non-ASCII names through the encoded form, with a usable fallback', () => {
        const header = contentDisposition('réspønse-日本語.png');
        // The fallback must still be a well-formed ASCII token...
        expect(header).toMatch(/filename="[\x20-\x7e]+"/);
        // ...and the real name is recoverable.
        expect(header).toContain('%E6%97%A5%E6%9C%AC%E8%AA%9E');
    });

    it('strips any path component', () => {
        // A stored name like this must not reach the client as a traversal
        // hint; a download only needs the basename.
        expect(contentDisposition('../../etc/passwd')).toContain('filename="passwd"');
        expect(contentDisposition('C:\\windows\\system32\\x.txt')).toContain('filename="x.txt"');
    });

    it('falls back to a generic name rather than emitting an empty one', () => {
        expect(contentDisposition('')).toContain('filename="download"');
        expect(contentDisposition(null)).toContain('filename="download"');
        expect(contentDisposition(undefined)).toContain('filename="download"');
    });

    it('never emits a CR or LF, which Node would reject at send time', () => {
        const header = contentDisposition('a\nb\rc.txt');
        expect(header).not.toMatch(/[\r\n]/);
    });
});

afterAll(() => {
    purgeTrackedFixtures();
});
