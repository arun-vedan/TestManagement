const path = require('path');

// WP-101 — the single place test code and maintenance scripts get Mongo
// credentials.
//
// The root password used to be written inline in 36 places across 10 TRACKED
// files: 27 times in backend/docker-compose.yml and once each in five test
// files, two backfill scripts, an e2e spec and a planning document. Every one
// was a committed secret, and rotating it (WP-100) meant finding and editing
// all 36 -- which is exactly the kind of task that gets done to 34 of them.
//
// Compose now reads backend/.env. This module is the equivalent for everything
// that connects from outside a container.
//
// WHY A HELPER RATHER THAN `process.env` AT EACH CALL SITE. Each of those
// files would otherwise need its own dotenv wiring with its own relative path
// to backend/.env, and the ones that are two directories deeper would get it
// subtly wrong -- silently, because a missing password produces an
// authentication error that reads like a broken database rather than a missing
// config. Loading is done once, here, and a missing value THROWS with the
// variable name in the message.
//
// NAME CHAIN: MONGO_ROOT_* is canonical. MONGO_BACKUP_* is the same credential
// under an older, misleading name -- despite it, that is the root user, not a
// backup-only one -- and stays in the chain so an existing .env and another
// session's committed helpers keep working. MONGO_* is the oldest form.

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env.test') });

function credentials() {
  const user = process.env.MONGO_ROOT_USER || process.env.MONGO_BACKUP_USER || process.env.MONGO_USER;
  const password =
    process.env.MONGO_ROOT_PASSWORD || process.env.MONGO_BACKUP_PASSWORD || process.env.MONGO_PASSWORD;

  if (!user || !password) {
    // Loud, and naming the canonical variables, because the failure this
    // prevents is a connection error that looks like an outage.
    throw new Error(
      'Mongo credentials are not set. Add MONGO_ROOT_USER and MONGO_ROOT_PASSWORD to ' +
        'backend/.env (see backend/.env.example). They are deliberately not hardcoded: ' +
        'this value used to sit in 36 tracked places, which made rotating it impractical.'
    );
  }
  return { user, password };
}

// "user:password", for a caller assembling its own URI.
function mongoAuth() {
  const { user, password } = credentials();
  return `${user}:${encodeURIComponent(password)}`;
}

// A full connection URI for one database.
//
// Defaults to localhost:27017 because that is where a test process running on
// the HOST reaches Mongo. Note the hazard fixtureCleanup.js documents at
// length: this host also runs a native mongod on 127.0.0.1:27017, and Docker
// publishes the container on *:27017, so `localhost` can reach either. Callers
// that must be certain which instance they are talking to should go through
// `docker exec` as fixtureCleanup does, rather than relying on this URI.
function mongoUri(database, host) {
  if (!database) {
    throw new Error('mongoUri(database) requires a database name');
  }
  const target = host || process.env.MONGO_HOST || 'localhost:27017';
  return `mongodb://${mongoAuth()}@${target}/${database}?authSource=admin`;
}

module.exports = { mongoAuth, mongoUri, credentials };
