// WP-140 acceptance, exercised against the real stack:
//   "a stored credential is unreadable in a mongodump; key rotation is
//    documented and exercised once."
//
// NOT part of `npm test` -- CI runs this package's unit tests with no
// containers. Run with `npm run test:live` with the compose stack up.
//
// Everything goes through `docker exec` into the `mongodb` container: this
// host also runs a native mongod on localhost:27017, and a test that wrote to
// that one would prove nothing about the product's database. The instance
// guard is the one fixtureCleanup.js and the data scripts use.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CONTAINER = process.env.TEST_MONGO_CONTAINER || 'mongodb';
const DB = 'srckube-wp140-proof';
const CONTEXT = 'jira:project:proof';
const PLAINTEXT = `ATATT3x-wp140-proof-${crypto.randomBytes(12).toString('hex')}`;

const KEY_1 = crypto.randomBytes(32).toString('base64');
const KEY_2 = crypto.randomBytes(32).toString('base64');

function readBackendEnv() {
  const file = path.resolve(__dirname, '../../../.env');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function mongoUri() {
  const env = readBackendEnv();
  const user = env.MONGO_BACKUP_USER || env.MONGO_USER;
  const password = env.MONGO_BACKUP_PASSWORD || env.MONGO_PASSWORD;
  if (!user || !password) {
    throw new Error('credentials.live.test needs MONGO_BACKUP_USER/PASSWORD (or MONGO_USER/PASSWORD) in backend/.env');
  }
  return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:27017/?authSource=admin`;
}

const GUARD = `
const MUST_HAVE = ['srckube-ai', 'srckube-release', 'srckube-reporting'];
const MUST_NOT_HAVE = ['codeshark', 'fauserdb', 'authdeputy'];
const present = db.adminCommand({ listDatabases: 1 }).databases.map(function (d) { return d.name; });
const missing = MUST_HAVE.filter(function (n) { return present.indexOf(n) === -1; });
const foreign = MUST_NOT_HAVE.filter(function (n) { return present.indexOf(n) !== -1; });
if (missing.length || foreign.length) {
  print('WRONG_INSTANCE missing=' + missing.join(',') + ' foreign=' + foreign.join(','));
  quit(1);
}
`;

function mongosh(script) {
  return execFileSync('docker', ['exec', '-i', CONTAINER, 'mongosh', mongoUri(), '--quiet', '--file', '/dev/stdin'], {
    input: GUARD + script,
    encoding: 'utf8',
    timeout: 60000
  });
}

function storeToken(value) {
  mongosh(`
db.getSiblingDB(${JSON.stringify(DB)}).integrations.replaceOne(
  { _id: 'proof' },
  { _id: 'proof', provider: 'jira', apiToken: ${JSON.stringify(value)} },
  { upsert: true }
);
print('OK');
`);
}

function readToken() {
  const out = mongosh(`print(db.getSiblingDB(${JSON.stringify(DB)}).integrations.findOne({ _id: 'proof' }).apiToken);`);
  return out.trim();
}

function dumpDatabase() {
  // --archive to stdout: the exact bytes a backup would contain.
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'mongodump', `--uri=${mongoUri()}`, `--db=${DB}`, '--archive', '--quiet'],
    { timeout: 60000, maxBuffer: 64 * 1024 * 1024 }
  );
}

function loadWithKeys(keys, active) {
  jest.resetModules();
  process.env.CREDENTIAL_KEYS = keys;
  process.env.CREDENTIAL_ACTIVE_KEY_ID = active;
  // eslint-disable-next-line global-require
  return require('../credentials');
}

describe('credentials against the live container Mongo (WP-140)', () => {
  const ORIGINAL = { ...process.env };

  afterAll(() => {
    process.env = ORIGINAL;
    try {
      mongosh(`db.getSiblingDB(${JSON.stringify(DB)}).dropDatabase(); print('DROPPED');`);
    } catch (err) {
      process.stderr.write(`[credentials.live] could not drop ${DB}: ${err.message}\n`);
    }
  });

  it('a stored credential is not readable in a mongodump', () => {
    const { encryptSecret } = loadWithKeys(`k1:${KEY_1}`, 'k1');
    storeToken(encryptSecret(PLAINTEXT, CONTEXT));

    const dump = dumpDatabase();

    // Non-vacuous: the dump really contains the document we stored...
    expect(dump.includes(Buffer.from('enc:v1:k1:'))).toBe(true);
    // ...and nothing in it gives the token away.
    expect(dump.includes(Buffer.from(PLAINTEXT))).toBe(false);
    expect(dump.includes(Buffer.from(Buffer.from(PLAINTEXT).toString('base64')))).toBe(false);
    expect(dump.includes(Buffer.from(Buffer.from(PLAINTEXT).toString('hex')))).toBe(false);
  });

  it('control: the same dump DOES expose a plaintext token, so the check above can fail', () => {
    storeToken(PLAINTEXT);
    expect(dumpDatabase().includes(Buffer.from(PLAINTEXT))).toBe(true);
    // Put the sealed value back for the rotation test.
    const { encryptSecret } = loadWithKeys(`k1:${KEY_1}`, 'k1');
    storeToken(encryptSecret(PLAINTEXT, CONTEXT));
  });

  it('rotates k1 -> k2 end to end, following the README procedure', () => {
    // 1. Add k2 as active, keep k1 in the ring.
    let creds = loadWithKeys(`k1:${KEY_1},k2:${KEY_2}`, 'k2');
    const stored = readToken();
    expect(creds.keyIdOf(stored)).toBe('k1');
    expect(creds.decryptSecret(stored, CONTEXT)).toBe(PLAINTEXT);

    // 2. Re-encrypt every stored value.
    if (creds.needsReencryption(stored)) {
      storeToken(creds.reencryptSecret(stored, CONTEXT));
    }

    // 3. Verify nothing is left under k1.
    const remaining = mongosh(
      `print(db.getSiblingDB(${JSON.stringify(DB)}).integrations.countDocuments({ apiToken: /^enc:v1:k1:/ }));`
    ).trim();
    expect(remaining).toBe('0');

    // 4. Retire k1. The stored credential still opens; the pre-rotation
    //    ciphertext (as an old backup would hold it) does not.
    creds = loadWithKeys(`k2:${KEY_2}`, 'k2');
    const rotated = readToken();
    expect(creds.keyIdOf(rotated)).toBe('k2');
    expect(creds.decryptSecret(rotated, CONTEXT)).toBe(PLAINTEXT);
    expect(() => creds.decryptSecret(stored, CONTEXT)).toThrow(/key 'k1' is not in CREDENTIAL_KEYS/);

    // And the post-rotation dump is still free of the token.
    const dump = dumpDatabase();
    expect(dump.includes(Buffer.from('enc:v1:k2:'))).toBe(true);
    expect(dump.includes(Buffer.from(PLAINTEXT))).toBe(false);
  });
});
