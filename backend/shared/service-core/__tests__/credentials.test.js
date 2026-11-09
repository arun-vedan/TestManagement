// WP-140 — encrypted credential storage.
//
// The helper exists so integration secrets (Jira API tokens first) never sit
// in Mongo as plaintext. The properties that matter, each asserted below:
//   - the stored value does not contain the plaintext, and round-trips;
//   - tampering is detected, not silently decrypted to garbage;
//   - a ciphertext is bound to the record it was sealed for (context), so it
//     cannot be copied onto another tenant's record and still work;
//   - rotation works: old ciphertexts stay readable while their key is in the
//     ring, re-encryption moves them to the active key, and once the old key
//     is removed nothing still depends on it;
//   - missing or malformed key configuration fails loudly, never falls back.

const crypto = require('crypto');

const KEY_A = crypto.randomBytes(32).toString('base64');
const KEY_B = crypto.randomBytes(32).toString('base64');
const CONTEXT = 'jira:project:42';

describe('credentials (WP-140)', () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    delete process.env.CREDENTIAL_KEYS;
    delete process.env.CREDENTIAL_ACTIVE_KEY_ID;
  });

  afterAll(() => {
    process.env = ORIGINAL;
  });

  function load() {
    // eslint-disable-next-line global-require
    return require('../credentials');
  }

  function useKeys(keys, active) {
    process.env.CREDENTIAL_KEYS = keys;
    process.env.CREDENTIAL_ACTIVE_KEY_ID = active;
  }

  describe('round trip', () => {
    it('encrypts to a value that does not contain the plaintext and decrypts back', () => {
      useKeys(`k1:${KEY_A}`, 'k1');
      const { encryptSecret, decryptSecret, isEncryptedSecret } = load();
      const plaintext = 'ATATT3xFfGF0-jira-api-token-value';

      const sealed = encryptSecret(plaintext, CONTEXT);

      expect(sealed).not.toContain(plaintext);
      expect(sealed).not.toContain(Buffer.from(plaintext).toString('base64'));
      expect(isEncryptedSecret(sealed)).toBe(true);
      expect(decryptSecret(sealed, CONTEXT)).toBe(plaintext);
    });

    it('produces a different ciphertext each time for the same input (random IV)', () => {
      useKeys(`k1:${KEY_A}`, 'k1');
      const { encryptSecret } = load();
      expect(encryptSecret('same', CONTEXT)).not.toBe(encryptSecret('same', CONTEXT));
    });

    it('round-trips unicode and long values', () => {
      useKeys(`k1:${KEY_A}`, 'k1');
      const { encryptSecret, decryptSecret } = load();
      const value = `tökén-✓-${'x'.repeat(5000)}`;
      expect(decryptSecret(encryptSecret(value, CONTEXT), CONTEXT)).toBe(value);
    });

    it('treats a plain string as not encrypted', () => {
      useKeys(`k1:${KEY_A}`, 'k1');
      const { isEncryptedSecret } = load();
      expect(isEncryptedSecret('plain-token')).toBe(false);
      expect(isEncryptedSecret(undefined)).toBe(false);
      expect(isEncryptedSecret(null)).toBe(false);
    });
  });

  describe('integrity and binding', () => {
    it('rejects a tampered ciphertext', () => {
      useKeys(`k1:${KEY_A}`, 'k1');
      const { encryptSecret, decryptSecret } = load();
      const sealed = encryptSecret('secret', CONTEXT);
      const parts = sealed.split(':');
      const body = Buffer.from(parts[parts.length - 1], 'base64');
      body[0] ^= 0xff;
      parts[parts.length - 1] = body.toString('base64');

      expect(() => decryptSecret(parts.join(':'), CONTEXT)).toThrow(/could not be decrypted/i);
    });

    it('refuses to decrypt under a different context than it was sealed for', () => {
      useKeys(`k1:${KEY_A}`, 'k1');
      const { encryptSecret, decryptSecret } = load();
      const sealed = encryptSecret('secret', 'jira:project:42');
      expect(() => decryptSecret(sealed, 'jira:project:43')).toThrow(/could not be decrypted/i);
    });

    it('requires a non-empty context on both encrypt and decrypt', () => {
      useKeys(`k1:${KEY_A}`, 'k1');
      const { encryptSecret, decryptSecret } = load();
      expect(() => encryptSecret('secret')).toThrow(/context/i);
      expect(() => encryptSecret('secret', '  ')).toThrow(/context/i);
      const sealed = encryptSecret('secret', CONTEXT);
      expect(() => decryptSecret(sealed)).toThrow(/context/i);
    });

    it('refuses to encrypt a non-string or empty secret', () => {
      useKeys(`k1:${KEY_A}`, 'k1');
      const { encryptSecret } = load();
      expect(() => encryptSecret('', CONTEXT)).toThrow(/non-empty string/i);
      expect(() => encryptSecret(undefined, CONTEXT)).toThrow(/non-empty string/i);
      expect(() => encryptSecret({ token: 'x' }, CONTEXT)).toThrow(/non-empty string/i);
    });

    it('refuses to decrypt something that is not an encrypted secret', () => {
      useKeys(`k1:${KEY_A}`, 'k1');
      const { decryptSecret } = load();
      expect(() => decryptSecret('plain-token', CONTEXT)).toThrow(/not an encrypted secret/i);
    });
  });

  describe('rotation', () => {
    it('keeps old ciphertexts readable while their key is in the ring, and re-encrypts them to the active key', () => {
      useKeys(`k1:${KEY_A}`, 'k1');
      const sealedUnderA = load().encryptSecret('rotate-me', CONTEXT);

      // Step 1 of rotation: add k2 and make it active, keep k1 in the ring.
      jest.resetModules();
      useKeys(`k1:${KEY_A},k2:${KEY_B}`, 'k2');
      const { decryptSecret, needsReencryption, reencryptSecret, keyIdOf } = load();

      expect(decryptSecret(sealedUnderA, CONTEXT)).toBe('rotate-me');
      expect(needsReencryption(sealedUnderA)).toBe(true);

      // Step 2: re-encrypt every stored value.
      const sealedUnderB = reencryptSecret(sealedUnderA, CONTEXT);
      expect(keyIdOf(sealedUnderB)).toBe('k2');
      expect(needsReencryption(sealedUnderB)).toBe(false);

      // Step 3: retire k1. The re-encrypted value no longer depends on it,
      // and the stale one fails with a message naming the missing key.
      jest.resetModules();
      useKeys(`k2:${KEY_B}`, 'k2');
      const after = load();
      expect(after.decryptSecret(sealedUnderB, CONTEXT)).toBe('rotate-me');
      expect(() => after.decryptSecret(sealedUnderA, CONTEXT)).toThrow(/key 'k1' is not in CREDENTIAL_KEYS/);
    });

    it('reencryptSecret leaves a value already under the active key unchanged', () => {
      useKeys(`k1:${KEY_A}`, 'k1');
      const { encryptSecret, reencryptSecret } = load();
      const sealed = encryptSecret('x', CONTEXT);
      expect(reencryptSecret(sealed, CONTEXT)).toBe(sealed);
    });
  });

  describe('configuration', () => {
    it('reports whether encryption is configured', () => {
      expect(load().isCredentialEncryptionConfigured()).toBe(false);
      jest.resetModules();
      useKeys(`k1:${KEY_A}`, 'k1');
      expect(load().isCredentialEncryptionConfigured()).toBe(true);
    });

    it('fails loudly on use when no keys are configured, rather than falling back', () => {
      const { encryptSecret } = load();
      expect(() => encryptSecret('secret', CONTEXT)).toThrow(/CREDENTIAL_KEYS/);
    });

    it('rejects a key that is not 32 bytes', () => {
      useKeys(`k1:${crypto.randomBytes(16).toString('base64')}`, 'k1');
      expect(() => load().encryptSecret('secret', CONTEXT)).toThrow(/32 bytes/);
    });

    it('rejects an active key id that is not in the ring', () => {
      useKeys(`k1:${KEY_A}`, 'k9');
      expect(() => load().encryptSecret('secret', CONTEXT)).toThrow(/CREDENTIAL_ACTIVE_KEY_ID 'k9'/);
    });

    it('rejects a malformed or duplicated key entry', () => {
      useKeys('no-colon-here', 'k1');
      expect(() => load().encryptSecret('secret', CONTEXT)).toThrow(/id:base64/);
      jest.resetModules();
      useKeys(`k1:${KEY_A},k1:${KEY_B}`, 'k1');
      expect(() => load().encryptSecret('secret', CONTEXT)).toThrow(/more than once/);
    });

    it('never puts key material in an error message', () => {
      useKeys(`k1:${KEY_A}`, 'k9');
      try {
        load().encryptSecret('secret', CONTEXT);
        throw new Error('expected a throw');
      } catch (err) {
        expect(err.message).not.toContain(KEY_A);
      }
    });
  });
});
