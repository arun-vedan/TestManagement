const http = require('http');
const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// WP-031 -- black-box HTTP suite for notificationService's REST surface,
// through Kong (matching defectService/requirementService's api.test.js
// convention). The live rule-firing/DLQ behavior is covered separately in
// events.test.js -- this suite is the auth/shape/edge-case contract for
// GET /api/v1/notifications and PATCH /api/v1/notifications/:id/read.
//
// GR-1 sweep contract (verified this session): unauthenticated now 401s AT
// KONG (WP-023 moved rejection to the gateway) -- this suite asserts
// "rejected" (>= 400, not 404), not a specific code, so it does not need
// updating if that ever changes again.
//
// Open-handle fix: this suite's axios dependency (1.20.0, pulled in as a
// runtime dependency of the service itself -- see package.json -- unlike
// every sibling suite, which only gets axios transitively as a devDependency
// pinned much older, e.g. defectService's 1.7.7) keeps its underlying
// socket referenced (a TCPWRAP `detectOpenHandles` flags) past the response
// completing, which is enough to keep Jest's event loop non-empty. Rather
// than relying on the server (Kong) to close the connection on its own
// schedule, every request in this file goes through ONE explicit
// `http.Agent({keepAlive: true})` -- keepAlive:true so requests within a
// test still reuse a connection instead of paying a new TCP handshake each
// time -- that gets `.destroy()`ed in a top-level afterAll below, exactly
// once, after the last test in the file. That destroy() forcibly closes
// every socket the agent holds, which is what actually releases the
// TCPWRAP handle; simply not passing an agent (relying on Node's global
// default one) leaves that same handle owned by a shared agent no test
// context ever tears down. NOT `forceExit: true`: that would hide this (or
// a future, real) leak instead of closing it -- see this file's closing
// afterAll for the actual teardown.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';
const DEFAULT_PROJECT_ID = 1;
const PROJECT_SCOPE_HEADERS = { [PROJECT_ID_HEADER]: String(DEFAULT_PROJECT_ID) };

const httpAgent = new http.Agent({ keepAlive: true });

const anonClient = axios.create({ baseURL: BASE_URL, httpAgent, validateStatus: () => true });

describe('notificationService API (live)', () => {
  // Single teardown for the one shared agent every client in this file
  // (anonClient, the authenticated `client` below, and the raw axios.get()
  // in the X-Project-Id test) is built on. Runs once, after every test in
  // the file has finished, so it can't close a socket a later test still
  // needs.
  afterAll(() => {
    httpAgent.destroy();
  });

  describe('every route requires authentication', () => {
    const protectedRoutes = [
      ['get', '/api/v1/notifications'],
      ['patch', `/api/v1/notifications/${DUMMY_ID}/read`]
    ];

    it.each(protectedRoutes)('%s %s rejects a request with no token', async (method, path) => {
      const resp = await anonClient.request({ method, url: path });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });
  });

  describe('authenticated, project-scoped', () => {
    let client;

    beforeAll(async () => {
      const token = await getServiceToken();
      client = axios.create({
        baseURL: BASE_URL,
        httpAgent,
        headers: { Authorization: `Bearer ${token}`, ...PROJECT_SCOPE_HEADERS },
        validateStatus: () => true
      });
    }, 15000);

    it('GET /api/v1/notifications without X-Project-Id is rejected (requireProjectScope, WP-021)', async () => {
      const token = (await client.get('/api/v1/notifications')).config.headers.Authorization;
      const resp = await axios.get(`${BASE_URL}/api/v1/notifications`, {
        httpAgent,
        headers: { Authorization: token },
        validateStatus: () => true
      });
      expect(resp.status).toBe(403);
    });

    it('GET /api/v1/notifications returns the list envelope with a count and unreadCount', async () => {
      const resp = await client.get('/api/v1/notifications');
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(Array.isArray(resp.data.data)).toBe(true);
      expect(resp.data.count).toBe(resp.data.data.length);
      expect(typeof resp.data.unreadCount).toBe('number');
    });

    it('GET /api/v1/notifications?unreadOnly=true returns only unread notifications', async () => {
      const resp = await client.get('/api/v1/notifications', { params: { unreadOnly: 'true' } });
      expect(resp.status).toBe(200);
      expect(resp.data.data.every((n) => n.read === false)).toBe(true);
    });

    it('PATCH /api/v1/notifications/:id/read on a nonexistent id returns 404', async () => {
      const resp = await client.patch(`/api/v1/notifications/${DUMMY_ID}/read`);
      expect(resp.status).toBe(404);
      expect(resp.data.success).toBe(false);
    });
  });
});
