const crypto = require('crypto');

// WP-140 — encrypted credential storage.
//
// WHY. Phase 3 stores third-party credentials (a Jira API token per project
// first; every later integration after it). Before this file there was no
// encryption-at-rest helper anywhere in the shared library, so the only
// available option was a plaintext token in Mongo -- readable by anyone with a
// `mongodump`, a backup file, or read access to the collection.
//
// WHAT A STORED VALUE LOOKS LIKE.
//
//     enc:v1:<keyId>:<iv>:<authTag>:<ciphertext>      (base64 parts)
//
// AES-256-GCM: authenticated, so a tampered value fails to decrypt instead of
// decrypting to garbage. The key id travels with the value so rotation can
// tell which key sealed it.
//
// CONTEXT BINDING. Every call takes a `context` string naming the record the
// secret belongs to (e.g. `jira:project:42`). It is fed to GCM as additional
// authenticated data, so a ciphertext copied from one tenant's record onto
// another's fails to decrypt there rather than silently handing tenant 43 the
// credential of tenant 42. It is required, not optional: an optional binding is
// one a caller forgets.
//
// CONFIGURATION (GR-9: env only, never in source).
//
//     CREDENTIAL_KEYS=k1:<base64 of 32 random bytes>[,k2:<...>]
//     CREDENTIAL_ACTIVE_KEY_ID=k1
//
// Generate a key with:
//     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// WHY THERE IS NO FALLBACK -- deliberately unlike sessionSecret.js. A random
// per-process session secret is harmless because sessions are per-process. A
// random per-process ENCRYPTION key would make every credential written before
// a restart permanently unreadable, discovered only when an integration breaks.
// So an unconfigured key throws at the moment a credential is sealed or opened.
// It does NOT throw at boot: most services never touch a credential and must
// not refuse to start over a variable they do not use.
//
// ROTATION -- see README.md "Credential encryption" for the procedure. In
// short: add a new key and make it active (old key stays in the ring), run the
// owning service's re-encryption over its stored values (`needsReencryption` +
// `reencryptSecret`), then remove the old key.

const PREFIX = 'enc';
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // the GCM-recommended nonce size
const KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

let cachedRing;

function configError(message) {
  return new Error(`Credential encryption is misconfigured: ${message} (WP-140; see service-core README.md).`);
}

// Parsed once per process. Messages name key ids, never key material.
function loadKeyRing() {
  if (cachedRing) return cachedRing;

  const raw = (process.env.CREDENTIAL_KEYS || '').trim();
  if (!raw) {
    throw configError('CREDENTIAL_KEYS is not set');
  }

  const keys = new Map();
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const sep = entry.indexOf(':');
    if (sep <= 0) {
      throw configError('each CREDENTIAL_KEYS entry must be id:base64');
    }
    const id = entry.slice(0, sep);
    if (!KEY_ID_PATTERN.test(id)) {
      throw configError(`key id '${id.slice(0, 32)}' must be 1-32 letters, digits, '-' or '_'`);
    }
    if (keys.has(id)) {
      throw configError(`key id '${id}' appears more than once in CREDENTIAL_KEYS`);
    }
    const key = Buffer.from(entry.slice(sep + 1), 'base64');
    if (key.length !== KEY_BYTES) {
      throw configError(`key '${id}' must decode to exactly ${KEY_BYTES} bytes (got ${key.length})`);
    }
    keys.set(id, key);
  }

  const activeId = (process.env.CREDENTIAL_ACTIVE_KEY_ID || '').trim();
  if (!activeId) {
    throw configError('CREDENTIAL_ACTIVE_KEY_ID is not set');
  }
  if (!keys.has(activeId)) {
    throw configError(`CREDENTIAL_ACTIVE_KEY_ID '${activeId.slice(0, 32)}' is not one of the ids in CREDENTIAL_KEYS`);
  }

  cachedRing = { keys, activeId };
  return cachedRing;
}

function isCredentialEncryptionConfigured() {
  try {
    loadKeyRing();
    return true;
  } catch (err) {
    return false;
  }
}

function requireContext(context) {
  if (typeof context !== 'string' || !context.trim()) {
    throw new Error('A non-empty context string is required to seal or open a credential (WP-140).');
  }
}

function aad(keyId, context) {
  return Buffer.from(`${VERSION}|${keyId}|${context}`, 'utf8');
}

function parse(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length !== 6 || parts[0] !== PREFIX || parts[1] !== VERSION) return null;
  const [, , keyId, iv, tag, body] = parts;
  if (!KEY_ID_PATTERN.test(keyId) || !iv || !tag || !body) return null;
  return { keyId, iv, tag, body };
}

function isEncryptedSecret(value) {
  return parse(value) !== null;
}

function keyIdOf(value) {
  const parsed = parse(value);
  return parsed ? parsed.keyId : null;
}

function encryptSecret(plaintext, context) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptSecret expects a non-empty string secret (WP-140).');
  }
  requireContext(context);
  const { keys, activeId } = loadKeyRing();

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keys.get(activeId), iv);
  cipher.setAAD(aad(activeId, context));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [PREFIX, VERSION, activeId, iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':');
}

function decryptSecret(value, context) {
  requireContext(context);
  const parsed = parse(value);
  if (!parsed) {
    throw new Error('Value is not an encrypted secret (WP-140); refusing to treat it as one.');
  }
  const { keys } = loadKeyRing();
  const key = keys.get(parsed.keyId);
  if (!key) {
    throw configError(
      `this credential was sealed with key '${parsed.keyId}', and key '${parsed.keyId}' is not in CREDENTIAL_KEYS ` +
        '-- was it removed before re-encryption finished?'
    );
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, 'base64'));
    decipher.setAAD(aad(parsed.keyId, context));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parsed.body, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    // One message for every failure mode (tampered, wrong context, corrupt):
    // which one it was is not something to tell a caller who may be probing.
    throw new Error('Credential could not be decrypted: it was tampered with, corrupted, or belongs to a different record.');
  }
}

// True when the value was sealed with a key other than the active one, i.e.
// rotation still has work to do for it.
function needsReencryption(value) {
  const parsed = parse(value);
  if (!parsed) return false;
  return parsed.keyId !== loadKeyRing().activeId;
}

// Re-seals a stored value under the active key. A value already under the
// active key is returned unchanged, so a rotation run is safe to repeat.
function reencryptSecret(value, context) {
  if (!needsReencryption(value)) {
    decryptSecret(value, context); // still verify it opens; never bless a broken value
    return value;
  }
  return encryptSecret(decryptSecret(value, context), context);
}

module.exports = {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
  needsReencryption,
  reencryptSecret,
  keyIdOf,
  isCredentialEncryptionConfigured
};
