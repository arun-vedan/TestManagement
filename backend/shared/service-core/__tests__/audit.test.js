// WP-024 unit tests for the audit() write-path helper.
//
// Mongoose's real Schema/Types machinery is used as-is (audit.js builds a
// real AuditEventSchema at module load time) -- only `createConnection` is
// mocked, so these tests exercise the actual schema definition while
// controlling what the "database" does, the same technique the existing
// projectScope.test.js uses for requestWithRetry.
jest.mock('mongoose', () => {
  const actualMongoose = jest.requireActual('mongoose');
  return {
    ...actualMongoose,
    createConnection: jest.fn()
  };
});

const mongoose = require('mongoose');
const { audit, getAuditEventModel, _resetAuditConnectionForTests } = require('../audit');

function makeFakeConnection(model) {
  return {
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    model: jest.fn(() => model)
  };
}

function makeReq({ sub = 'user-a', name, preferred_username, correlationId = 'corr-1', projectScope } = {}) {
  return {
    correlationId,
    projectScope,
    kauth: sub
      ? { grant: { access_token: { content: { sub, name, preferred_username } } } }
      : undefined
  };
}

describe('audit()', () => {
  const OLD_AUDIT_URI = process.env.AUDIT_MONGO_URI;

  beforeEach(() => {
    mongoose.createConnection.mockReset();
    // Clears audit.js's own module-scope connection/model cache so each
    // test starts as if the audit store had never been contacted, without
    // needing jest.resetModules() (which would also detach this file's
    // `mongoose` reference from the instance audit.js requires internally).
    _resetAuditConnectionForTests();
  });

  afterEach(() => {
    _resetAuditConnectionForTests();
    if (OLD_AUDIT_URI === undefined) {
      delete process.env.AUDIT_MONGO_URI;
    } else {
      process.env.AUDIT_MONGO_URI = OLD_AUDIT_URI;
    }
  });

  it('writes an audit event with actor/correlationId derived from the request, not the body', async () => {
    process.env.AUDIT_MONGO_URI = 'mongodb://fake-audit-host/srckube-comments';
    const create = jest.fn().mockResolvedValue({ _id: 'evt-1' });
    mongoose.createConnection.mockReturnValue(makeFakeConnection({ create }));

    const req = makeReq({
      sub: 'real-token-sub',
      preferred_username: 'realuser',
      correlationId: 'corr-abc',
      projectScope: { projectId: 1, project: { organizationId: 'org-1' } }
    });
    // A forged actor in the body-shaped payload must be ignored -- audit()
    // doesn't even accept an actor/actorId param, so this also proves the
    // call site can't smuggle one in.
    req.body = { actor: 'forged-actor', createdBy: 'forged-actor' };

    const result = await audit(req, {
      entityType: 'testcase',
      entityId: 'TC-1',
      action: 'create',
      after: { TestCaseId: 'TC-1' }
    });

    expect(result).toEqual({ _id: 'evt-1' });
    expect(create).toHaveBeenCalledTimes(1);
    const written = create.mock.calls[0][0];
    expect(written.actor).toBe('real-token-sub');
    expect(written.actor).not.toBe('forged-actor');
    expect(written.correlationId).toBe('corr-abc');
    expect(written.projectId).toBe(1);
    expect(written.organizationId).toBe('org-1');
    expect(written.entityType).toBe('testcase');
    expect(written.entityId).toBe('TC-1');
    expect(written.action).toBe('create');
    expect(written.actorName).toBe('realuser');
  });

  it('does not throw and resolves null when the audit write itself fails (business op must survive)', async () => {
    process.env.AUDIT_MONGO_URI = 'mongodb://fake-audit-host/srckube-comments';
    const create = jest.fn().mockRejectedValue(new Error('audit store is down'));
    mongoose.createConnection.mockReturnValue(makeFakeConnection({ create }));

    const req = makeReq({ sub: 'user-a' });

    await expect(
      audit(req, { entityType: 'defect', entityId: 'Bug-1', action: 'update' })
    ).resolves.toBeNull();
  });

  it('resolves null (does not throw) when AUDIT_MONGO_URI is not configured', async () => {
    delete process.env.AUDIT_MONGO_URI;
    const req = makeReq({ sub: 'user-a' });

    const result = await audit(req, { entityType: 'requirement', entityId: 'Req-1', action: 'delete' });

    expect(result).toBeNull();
    expect(mongoose.createConnection).not.toHaveBeenCalled();
  });

  it('resolves null (does not throw) when the request has no authenticated actor (req.kauth missing)', async () => {
    process.env.AUDIT_MONGO_URI = 'mongodb://fake-audit-host/srckube-comments';
    const create = jest.fn().mockResolvedValue({ _id: 'evt-2' });
    mongoose.createConnection.mockReturnValue(makeFakeConnection({ create }));

    const req = { correlationId: 'corr-1' }; // no req.kauth at all

    const result = await audit(req, { entityType: 'testplan', entityId: 'PLN-1', action: 'create' });

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('resolves null (does not throw) when required fields are missing', async () => {
    process.env.AUDIT_MONGO_URI = 'mongodb://fake-audit-host/srckube-comments';
    const create = jest.fn().mockResolvedValue({ _id: 'evt-3' });
    mongoose.createConnection.mockReturnValue(makeFakeConnection({ create }));

    const req = makeReq({ sub: 'user-a' });

    const result = await audit(req, { entityType: 'testcase' }); // missing entityId/action

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('falls back to a status-transition-shaped summary via before/after', async () => {
    process.env.AUDIT_MONGO_URI = 'mongodb://fake-audit-host/srckube-comments';
    const create = jest.fn().mockResolvedValue({ _id: 'evt-4' });
    mongoose.createConnection.mockReturnValue(makeFakeConnection({ create }));

    const req = makeReq({ sub: 'user-a' });

    await audit(req, {
      entityType: 'defect',
      entityId: 'Bug-1',
      action: 'status-change',
      before: { status: 'Open' },
      after: { status: 'Fixed' }
    });

    const written = create.mock.calls[0][0];
    expect(written.summary).toEqual({ before: { status: 'Open' }, after: { status: 'Fixed' } });
  });

  it('reuses a single cached connection/model across repeated calls', async () => {
    process.env.AUDIT_MONGO_URI = 'mongodb://fake-audit-host/srckube-comments';
    const create = jest.fn().mockResolvedValue({ _id: 'evt-5' });
    mongoose.createConnection.mockReturnValue(makeFakeConnection({ create }));

    const req = makeReq({ sub: 'user-a' });
    await audit(req, { entityType: 'testcase', entityId: 'TC-1', action: 'create' });
    await audit(req, { entityType: 'testcase', entityId: 'TC-1', action: 'update' });

    expect(mongoose.createConnection).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
  });

  describe('getAuditEventModel()', () => {
    it('returns null when AUDIT_MONGO_URI is unset', () => {
      delete process.env.AUDIT_MONGO_URI;
      expect(getAuditEventModel()).toBeNull();
    });

    it('returns the same model instance on repeated calls once configured', () => {
      process.env.AUDIT_MONGO_URI = 'mongodb://fake-audit-host/srckube-comments';
      const fakeModel = { create: jest.fn() };
      mongoose.createConnection.mockReturnValue(makeFakeConnection(fakeModel));

      const first = getAuditEventModel();
      const second = getAuditEventModel();

      expect(first).toBe(fakeModel);
      expect(second).toBe(fakeModel);
      expect(mongoose.createConnection).toHaveBeenCalledTimes(1);
    });
  });
});
