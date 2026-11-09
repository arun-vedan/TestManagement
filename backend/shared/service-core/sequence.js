// WP-020c — Atomic per-database sequence counters.
//
// THE BUG: every model needing a small monotonic integer id (or a
// human-readable "PLN-7"/"TC-102"/"Req-5"/"Bug-3"/"REL-2"/"Run-14"/"link-9"
// style id built from one) used a read-then-write pattern in a Mongoose
// pre-save hook:
//   const highest = await Model.findOne({}, {id:1}).sort({id:-1}).limit(1);
//   this.id = highest ? highest.id + 1 : 1;
// Two concurrent creates can both read the same max, both compute the same
// next id, and the second insert dies on the model's `unique: true` index
// with a Mongo E11000 duplicate-key error — which the API surfaces as a 400
// to the caller. Confirmed responsible for a ~50% full-suite flake (same
// signature both times: a create returning 400 where 201 was expected)
// before every multi-file backend suite was switched to --runInBand as a
// mitigation (commits d63956c, 1894be6) — that hides the race in tests but
// leaves it live in production, where two concurrent POSTs can still
// collide.
//
// THE FIX: the standard MongoDB atomic-counter pattern. Each service
// already owns a private database (there is no shared "counters" database
// to fight over — see backend/docker-compose.yml, one MONGO_URI per
// service), so each one gets its OWN `counters` collection, one document
// per sequence name, and every "next id" call is a single
//   findOneAndUpdate({_id: name}, {$inc: {seq: 1}}, {upsert:true, new:true})
// $inc is atomic at the document level in MongoDB — two concurrent callers
// racing this same call are serialized by the storage engine itself. There
// is no read-then-decide window for a second caller to land in, so there is
// no duplicate-key case to hit in the first place (not "retried until it
// works" — structurally cannot collide).
//
// WHY A COUNTER OVER BOUNDED RETRY-ON-E11000: a retry loop still lets
// contention show up as latency (every retry is a full round trip plus a
// re-read), and under a hot single sequence (e.g. many concurrent test-case
// creates in one project) the number of retries needed grows with
// concurrency, not a fixed bound. The counter's $inc is one round trip
// every time, independent of how many callers are racing it — no retry
// storm, no unbounded tail latency, and it is the pattern MongoDB's own
// docs recommend for exactly this "auto-increment" use case.
//
// WHY THE NATIVE DRIVER, NOT A COMPILED MONGOOSE MODEL: each service does
// its own separate `npm install` of mongoose (see the comment atop every
// service's Dockerfile — service-core needs its own install because
// require() resolution for shared/service-core's OWN node_modules is
// independent of the consuming service's). A Schema/Model compiled by
// service-core's copy of mongoose is therefore not guaranteed safe to
// attach to a Connection whose calling model was compiled by a DIFFERENT
// copy of mongoose in a different service. `connection.collection(name)`
// sidesteps that entirely: it is a thin wrapper every Mongoose Connection
// exposes straight over the underlying native MongoDB driver collection, so
// it behaves identically regardless of which mongoose instance authored the
// connection or the calling model's schema. Every caller passes
// `this.constructor.db` (the exact Connection its own model is already
// registered on — including the two-connection case in
// testPlanExecutionService, where TestPlan/TestExecution each have their
// own `planConnection`/`executionConnection`), so the counter always lives
// in that same service's own database, never a new one.
//
// Counters are namespaced by the `name` argument (e.g. 'testcase', 'PLN',
// 'defect'), not global, so two different sequences in the same service's
// database (there are none of these today, but the shape allows it) never
// collide with each other.

async function getNextSequence(connection, name) {
  if (!connection || typeof connection.collection !== 'function') {
    throw new Error('getNextSequence: a mongoose Connection is required');
  }
  if (!name) {
    throw new Error('getNextSequence: a sequence name is required');
  }

  const counters = connection.collection('counters');
  // mongodb driver 3.x (what every service's mongoose 5.x pulls in here)
  // uses `returnOriginal: false` to get the post-update document back, and
  // wraps the result in `{ value, ok, lastErrorObject }`.
  const result = await counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnOriginal: false }
  );
  const doc = result && result.value !== undefined ? result.value : result;
  if (!doc || typeof doc.seq !== 'number') {
    throw new Error(`getNextSequence: unexpected result shape for sequence "${name}": ${JSON.stringify(result)}`);
  }
  return doc.seq;
}

// One-time migration helper (GR-7 additive migration): seed a sequence's
// counter to `startAt` ONLY if no counter document exists yet for that
// name. Never overwrites an existing counter — idempotent, safe to run
// more than once, safe to run after getNextSequence() has already created
// the document (in which case this is a no-op and the existing value is
// returned unchanged). Used by each service's one-off backfill so the
// FIRST call to getNextSequence() after migration continues that service's
// existing human-visible sequence (e.g. PLN-7 -> PLN-8) instead of
// restarting at 1 and colliding with real, already-bookmarked data.
async function seedSequenceIfAbsent(connection, name, startAt) {
  if (!connection || typeof connection.collection !== 'function') {
    throw new Error('seedSequenceIfAbsent: a mongoose Connection is required');
  }
  if (!name) {
    throw new Error('seedSequenceIfAbsent: a sequence name is required');
  }
  if (typeof startAt !== 'number' || Number.isNaN(startAt)) {
    throw new Error('seedSequenceIfAbsent: startAt must be a number');
  }

  const counters = connection.collection('counters');
  const result = await counters.findOneAndUpdate(
    { _id: name },
    { $setOnInsert: { seq: startAt } },
    { upsert: true, returnOriginal: false }
  );
  const doc = result && result.value !== undefined ? result.value : result;
  return doc.seq;
}

module.exports = { getNextSequence, seedSequenceIfAbsent };
