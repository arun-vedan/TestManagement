// WP-020c -- seed the atomic id counters from existing data.
// Reads APPLY from the MONGOSH_APPLY env var ("1" = write, anything else = dry run).
// Only ever RAISES a counter, never lowers it, so re-running is safe.
// Derives each max by scanning EVERY collection in the database, because
// collection names are not guessable from the service name
// (testcaserepos, not testrepos; staus, not statuses).
const APPLY = (process.env.MONGOSH_APPLY === '1');
const map = [
  ['srckube-testrepo', 'testcase'], ['srckube-testplan', 'testplan'],
  ['srckube-testexecution', 'testexecution'], ['srckube-requirements', 'requirement'],
  ['srckube-defects', 'defect'], ['srckube-user', 'project'],
  ['srckube-linkissue', 'linkissue'], ['srckube-folder', 'folder'],
  ['srckube-fields', 'field'], ['srckube-module', 'module'],
  ['srckube-issuestatus', 'issuestatus'], ['srckube-objectrepo', 'objectrepo'],
  ['srckube-comments', 'comment'], ['srckube-automation', 'automation'],
  ['srckube-release', 'release'], ['srckube-release', 'environment']
];
let changed = 0;
map.forEach(function (pair) {
  const d = pair[0], seq = pair[1];
  const D = db.getSiblingDB(d);
  let max = 0;
  D.getCollectionNames().forEach(function (c) {
    if (c === 'counters') return;
    const t = D[c].find({}, { id: 1 }).sort({ id: -1 }).limit(1).toArray();
    if (t.length && typeof t[0].id === 'number' && t[0].id > max) max = t[0].id;
  });
  const cur = D.counters.findOne({ _id: seq });
  const curSeq = cur ? cur.seq : -1;
  if (curSeq >= max) { print('  ' + seq + ': ok (' + curSeq + ' >= ' + max + ')'); return; }
  changed++;
  if (APPLY) {
    D.counters.updateOne({ _id: seq }, { $set: { seq: max } }, { upsert: true });
    print('  ' + seq + ': RAISED ' + (cur ? curSeq : '(absent)') + ' -> ' + max);
  } else {
    print('  ' + seq + ': WOULD RAISE ' + (cur ? curSeq : '(absent)') + ' -> ' + max);
  }
});
print(APPLY ? ('seed-id-counters: ' + changed + ' counter(s) raised.')
            : ('seed-id-counters: ' + changed + ' counter(s) would be raised. Re-run with --apply.'));
