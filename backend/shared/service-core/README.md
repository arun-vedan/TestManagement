# @srckube/service-core

Shared Express middleware, Keycloak config, and security wiring for srckube backend
services. Extracted in Sprint 1.1 to replace the 13-way boilerplate clone (TD-04) and
to close the class of bug where per-service Keycloak config drifted and silently broke
auth (TD-19/TD-20).

## Usage

In a service's `package.json`:

```json
"dependencies": {
  "@srckube/service-core": "file:../shared/service-core"
}
```

**Known limitation, deliberate for now**: this repo doesn't use npm workspaces. A
plain `file:` dependency makes npm create a **symlink** (not a copy) at
`node_modules/@srckube/service-core` pointing back at this real directory — which
means Node resolves `require()` calls made from inside this package against **this
directory's own** `node_modules`, not the consuming service's, since Node resolves
symlinks to their real path before walking up looking for `node_modules`. So this
package needs its own `npm install` run against its own `package.json`, independent
of whatever installs the consuming service's dependencies. Each service's
`dockerfile` handles this with a separate `npm install --prefix` step (see below). If
more than a handful of services are migrated, switching to real npm workspaces
(single root `package.json` with a `workspaces` field) would let one `npm install`
handle both — tracked as a follow-up, not done now to keep the Sprint 1.1 pilot's
blast radius small.

Each service's `dockerfile` must copy this directory into the image at the exact path
referenced by the `file:` dependency **and install its dependencies separately**:

```dockerfile
WORKDIR /usr/src/app
COPY shared/service-core /usr/src/shared/service-core
RUN npm install --prefix /usr/src/shared/service-core
COPY <service>/package*.json ./
RUN npm install
COPY <service>/. .
```

...and the corresponding `docker-compose.yml` block must build from the `backend/`
root (`context: .`) with `dockerfile: <service>/dockerfile`, not from the service's
own directory — otherwise `shared/service-core` isn't inside the build context at all.

## Credential encryption (WP-140)

`encryptSecret` / `decryptSecret` seal third-party credentials (a Jira API token,
for example) before they are written to Mongo, so a `mongodump`, a backup file or
read access to the collection does not yield a usable credential. AES-256-GCM;
see `credentials.js` for the design notes.

```js
const { encryptSecret, decryptSecret } = require('@srckube/service-core');

// Seal on write. The context names the record the secret belongs to.
settings.apiToken = encryptSecret(plainToken, `jira:project:${projectId}`);

// Open only at the moment of use. Never return it to a client.
const token = decryptSecret(settings.apiToken, `jira:project:${projectId}`);
```

**The context is required and must be derived from the owning record**, never
from request input. It is authenticated with the ciphertext, so a value copied
onto another tenant's record will not decrypt there.

### Configuration

```
CREDENTIAL_KEYS=k1:<base64 of 32 random bytes>
CREDENTIAL_ACTIVE_KEY_ID=k1
```

Generate a key with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
Set both in `backend/.env` (untracked) and pass them through
`backend/docker-compose.yml` to **only** the services that store credentials. A
service that never handles one does not need them, and is not affected when they
are missing.

There is deliberately **no fallback key**. When the variables are missing or
malformed, sealing or opening a credential throws an error naming the problem (never
the key material). A generated key would make every credential stored before a
restart permanently unreadable.

**Losing every key means losing every stored credential.** Users would have to
re-enter them. Back the key up separately from the database. A key stored next
to the dump it protects protects nothing.

### Rotating the key

Every stored value records which key sealed it (`enc:v1:<keyId>:...`), so old and
new keys can be in use at the same time while rotation runs.

1. **Add** a new key and make it active, keeping the old one in the ring:
   `CREDENTIAL_KEYS=k1:<old>,k2:<new>` and `CREDENTIAL_ACTIVE_KEY_ID=k2`.
   Redeploy the services that hold credentials. New writes now use `k2`, and
   existing `k1` values still open.
2. **Re-encrypt** every stored value. For each one, `needsReencryption(value)`
   tells you whether it is still under an old key, and
   `reencryptSecret(value, context)` re-seals it under the active key. Running
   this a second time is safe, because a value already under the active key is
   left unchanged.
3. **Verify** that no value is still under the old key. For example, count the
   stored values that start with `enc:v1:k1:` and confirm the count is zero.
4. **Remove** the old key: `CREDENTIAL_KEYS=k2:<new>`. Redeploy. If you skipped
   step 3, any value still under `k1` now fails with an error naming the missing
   key `k1`. Put `k1` back to recover; nothing is lost.

The whole procedure, run against a real Mongo document and checked with
`mongodump`, is `__tests__/credentials.live.test.js`.
