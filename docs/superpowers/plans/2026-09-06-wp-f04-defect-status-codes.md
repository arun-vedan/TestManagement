# WP-F04 — Legacy defects showing a raw status code

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make Bug-1, Bug-2 and Bug-3 show their real status instead of a raw number, and stop the same class of record from breaking the status control again.

**Architecture:** a one-time, dry-run-first migration script rewriting three documents' `Status` from a numeric id to the canonical name, plus hardening the one status resolver that handles names only when its sibling already handles both.

**Spec:** `docs/superpowers/plans/2026-09-05-functional-gaps-program.md` — work package F04.

---

## The register's premise was wrong, and the data answers the open question

`PRODUCT_GAP_REGISTER.md`'s B6 says these are "numeric codes (1/2/8) that never mapped to an `istatus` name", and the program plan said F04 needed a written decision on what the codes meant.

**They map exactly.** `srckube-issuestatus.staus` — note the collection name is the typo `staus`, hardcoded as the third argument to `mongoose.model` in `statusService/models/IssueStatus.js` — holds all eight, and it is the same list `istatusservice` serves:

| id | istatus | | id | istatus |
|---|---|---|---|---|
| 1 | New | | 5 | Deffered |
| 2 | Open | | 6 | Retest |
| 3 | Fixed | | 7 | Re-open |
| 4 | Rejected | | 8 | Closed |

So no decision is needed. Verified against live data:

| Defect | Stored `Status` | JS type | Resolves to |
|---|---|---|---|
| Bug-1 | `"8"` | **string** | Closed |
| Bug-2 | `1` | **number** | New |
| Bug-3 | `2` | **number** | Open |

**The type inconsistency is load-bearing** — one is a string, two are numbers. Any query or comparison must handle both.

**Scale, verified:** 116 defect documents exist. **113** already store the *name* `"New"`. Exactly **3** — Bug-1/2/3, the only real defects in project 1; the rest are WP-021 tenant-isolation fixtures in other projects — store a numeric id. So this migration touches three documents and brings them in line with the overwhelming majority.

## Why the control is disabled, and why that is a second bug

`Components/governance/DefectStatus.tsx:71` resolves the current status **by name only**:

```js
(s) => s.istatus.toLowerCase() === (status || '').toLowerCase()
```

`'8'` matches no `istatus`, so nothing resolves, the chip renders the raw value and the control disables.

Its sibling already does this correctly. `Components/dashboardDrilldown/DefectFilterPanel.tsx:54-58` tries **id first, then name**, and its own comment calls this "the same real-data ambiguity". So the codebase contains the robust resolver and the fragile one side by side.

Migrating the data alone fixes today's three records and leaves the fragile resolver in place for the next legacy record — from a restore, another environment, or an import. Both halves are in scope, and they are separate tasks so either can be rejected on its own merits.

## Global Constraints

- **No new runtime dependency.**
- **This touches real user data.** Back up before writing, dry-run before applying, and make the script idempotent and re-runnable.
- **Fail loudly on anything unrecognised.** A numeric `Status` outside the eight known ids must abort the whole run, not be guessed at or skipped silently.
- **CRA/CRACO frontend: `npx jest` does not work.** Use `CI=true npx craco test <path> --watchAll=false`. Bar: **0 tests failing, failed-suite count still 35**. `npx eslint 'src/**/*.{ts,tsx}'` must exit 0 (one known pre-existing warning is not yours).
- **Append to `docs/superpowers/PRODUCT_GAP_REGISTER.md`** at the end — including correcting B6's false premise.

---

### Task 1: The migration

**Files:**
- Create: `backend/defectService/scripts/backfill-defect-status-names.js`
- Test: none automated — see Step 4 for why, and what replaces it.

**Interfaces:** none consumed or produced; a standalone one-time script.

**Pattern to copy:** `backend/requirementService/scripts/backfill-approved-status.js` — same `--dry-run` flag, same `require('dotenv').config({ path: './config/config.env' })` + `connectDB()` preamble, same "print what will change, then apply" shape, same `Model.collection` direct access to bypass Mongoose middleware. Read it first.

- [ ] **Step 1: Back up the collection**

The repo has `scripts/mongo-backup.sh` and a documented runbook at `docs/backup-restore-runbook.md`. Read the runbook and take a backup of the defects database before writing anything. Record the backup path in your report. **Do not skip this** — the gap register already carries an entry about seeded-data drift from a spec whose restore step failed.

- [ ] **Step 2: Write the script**

```javascript
// WP-F04 (2026-09-06): one-time migration. Three defects -- Bug-1, Bug-2,
// Bug-3, the only real ones in project 1 -- store `Status` as a numeric
// istatusservice id rather than the status NAME that the other 113 defect
// documents store. Components/governance/DefectStatus.tsx resolves the
// current status by name only, so those three render a raw number and
// their status control is disabled.
//
// THE MAP IS NOT INVENTED. It is srckube-issuestatus.staus verbatim, read
// on 2026-09-06 (the collection name is the typo `staus`, hardcoded as
// mongoose.model's third argument in statusService/models/IssueStatus.js).
// It is duplicated here rather than queried because that collection lives
// in a DIFFERENT database from defectService's own, and adding a second
// connection and env var to a one-time script is a worse trade than a map
// that is asserted against reality by the unknown-code guard below.
//
// TYPE MATTERS: Bug-1 stores the STRING '8' while Bug-2/3 store the
// NUMBERS 1 and 2, so every comparison here goes through String().
//
// Run with: node scripts/backfill-defect-status-names.js [--dry-run]

require('colors');
require('dotenv').config({ path: './config/config.env' });
const connectDB = require('../config/db');
const Defect = require('../models/defects');

const DRY_RUN = process.argv.includes('--dry-run');

const ID_TO_NAME = {
  '1': 'New',
  '2': 'Open',
  '3': 'Fixed',
  '4': 'Rejected',
  '5': 'Deffered',
  '6': 'Retest',
  '7': 'Re-open',
  '8': 'Closed'
};

// A Status is "legacy" if it is entirely digits -- covering both the
// string '8' and the numbers 1/2. A real status name never is.
const isLegacyCode = (value) => value !== null && value !== undefined && /^\d+$/.test(String(value));

(async () => {
  await connectDB();

  const all = await Defect.collection.find({}, { projection: { defectId: 1, Status: 1, projectId: 1 } }).toArray();
  const affected = all.filter((d) => isLegacyCode(d.Status));

  console.log(`Scanned ${all.length} defect(s); ${affected.length} store a numeric status code.`);

  const unknown = affected.filter((d) => !ID_TO_NAME[String(d.Status)]);
  if (unknown.length > 0) {
    console.error('\nABORTING -- these documents carry a numeric status this script has no mapping for:'.red);
    unknown.forEach((d) => console.error(`  - ${d.defectId} (project ${d.projectId}): Status=${JSON.stringify(d.Status)}`));
    console.error('\nNothing was written. Re-read srckube-issuestatus.staus and extend ID_TO_NAME before re-running.');
    process.exit(1);
  }

  affected.forEach((d) => {
    console.log(`  - ${d.defectId} (project ${d.projectId}): ${JSON.stringify(d.Status)} -> '${ID_TO_NAME[String(d.Status)]}'`);
  });

  if (affected.length === 0) {
    console.log('\nNothing to migrate -- already applied, or no legacy codes present.');
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log('\nDry run -- no changes written. Re-run without --dry-run to apply.');
    process.exit(0);
  }

  let changed = 0;
  for (const d of affected) {
    // collection.updateOne, not the model: this restores a correct value
    // onto an existing document and must not re-run Mongoose middleware
    // (the pre-save hook assigns ids from a sequence) or bump __v.
    // eslint-disable-next-line no-await-in-loop
    const res = await Defect.collection.updateOne({ _id: d._id }, { $set: { Status: ID_TO_NAME[String(d.Status)] } });
    changed += res.modifiedCount;
  }

  console.log(`\nMigrated ${changed} document(s).`);
  process.exit(0);
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

Check `defectService`'s real model filename and `connectDB` path and correct the two `require`s if they differ — read the directory rather than assuming.

- [ ] **Step 3: Dry run, and read the output**

**Run it INSIDE the container, never from the host.** This machine has two
MongoDB servers on 27017 — a native `mongod` on `127.0.0.1` and the `mongodb`
container published on `*`. A host process reaching `127.0.0.1:27017` hits the
**native** one, which carries a stale look-alike of `srckube-defects` whose
Bug-1/2/3 fixtures would pass the "exactly three" guard **by coincidence**,
migrating the wrong database and reporting success. `scripts/mongo-backup.sh`
already avoids this the same way.

```bash
docker exec defectservice node scripts/backfill-defect-status-names.js --dry-run
```

Expected: scans 116, reports exactly 3 affected, and lists precisely:
```
  - Bug-1 (project 1): "8" -> 'Closed'
  - Bug-2 (project 1): 1 -> 'New'
  - Bug-3 (project 1): 2 -> 'Open'
```

**If it reports any other count or any other document, stop and escalate.** That means the data is not what this plan verified and the migration must not run.

- [ ] **Step 4: Apply it, then prove it through the API**

There is no unit test here on purpose: a one-time script's correctness is a property of the data it ran against, and a test with a mocked collection would prove only that the map was copied correctly. The real verification is the API.

Run it for real, then confirm through the gateway that all three now read as names:

```bash
docker exec defectservice node scripts/backfill-defect-status-names.js
```

Then query the three defects through `/api/v1/defects` (the existing backend suites show the authed-client pattern — `getServiceToken()` plus `X-Project-Id: 1`) and assert each `Status` is now `Closed` / `New` / `Open`.

Then **run the script a second time** and confirm it reports "Nothing to migrate" — proving idempotence.

Record all three outputs in your report.

- [ ] **Step 5: Confirm the defect suite still passes**

Run: `cd backend/defectService && npx jest --runInBand`

Some suites assert on defect fixtures; if any assumed a numeric `Status`, that assumption was itself the bug. Fix such a test to expect the name, and say so in your report.

- [ ] **Step 6: Commit**

```bash
git add backend/defectService/scripts/backfill-defect-status-names.js
git commit -m "WP-F04a: migrate legacy numeric defect status codes to names"
```

---

### Task 2: Stop the status control breaking on a legacy code

**Files:**
- Modify: `frontend/src/Components/governance/DefectStatus.tsx` (the resolver at ~line 71)
- Test: `frontend/src/Components/governance/__tests__/DefectStatus.test.tsx` (create if absent; the directory has one test file from WP-F02)

**Interfaces:** no new exports.

Task 1 fixes the three records that exist. This stops the next one breaking the control — from a restore, another environment, or an import. `DefectFilterPanel.tsx:54-58` already resolves id-then-name; this brings the detail view's control in line with it.

- [ ] **Step 1: Write the failing test**

Mock `../../../api/defectStatusApi` — it transitively reaches `api/axios` and therefore `src/keycloak.js`, and an unmocked import puts this suite among the 35 that fail to run.

```tsx
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { getIssueStatuses } from '../../../api/defectStatusApi';
import { DefectStatus } from '../DefectStatus';

jest.mock('../../../api/defectStatusApi', () => ({
    getIssueStatuses: jest.fn(),
    updateDefectStatus: jest.fn(),
}));

const mockGet = getIssueStatuses as jest.Mock;

const STATUSES = [
    { id: 1, istatus: 'New', parentId: [0] },
    { id: 2, istatus: 'Open', parentId: [1] },
    { id: 8, istatus: 'Closed', parentId: [6] },
];

beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue(STATUSES);
});

// WP-F04 -- three real defects stored `Status` as an istatusservice id
// rather than a name. This resolver matched on name only, so those
// rendered a raw number with the control disabled.
// DefectFilterPanel.tsx:54-58 already resolved id-then-name; this brings
// the two in line so the class cannot recur from a restore or an import.
it('resolves a numeric status id to its name', async () => {
    render(<DefectStatus defectId="Bug-3" status={'2' as string} onStatusChanged={jest.fn()} onError={jest.fn()} />);
    expect(await screen.findByText('Open')).toBeInTheDocument();
    expect(screen.queryByText('2')).not.toBeInTheDocument();
});

it('resolves a numeric status stored as a JS number, not just a string', async () => {
    // Bug-2 and Bug-3 stored numbers; Bug-1 stored a string. Both shapes
    // exist in real data.
    render(<DefectStatus defectId="Bug-2" status={1 as unknown as string} onStatusChanged={jest.fn()} onError={jest.fn()} />);
    expect(await screen.findByText('New')).toBeInTheDocument();
});

it('still resolves a status stored as a name', async () => {
    render(<DefectStatus defectId="Bug-9" status="Closed" onStatusChanged={jest.fn()} onError={jest.fn()} />);
    expect(await screen.findByText('Closed')).toBeInTheDocument();
});

it('leaves the control usable for a legacy-code defect', async () => {
    // The reported symptom was not only the raw number -- the control was
    // disabled too, because nothing resolved.
    render(<DefectStatus defectId="Bug-3" status={'2' as string} onStatusChanged={jest.fn()} onError={jest.fn()} />);
    await screen.findByText('Open');
    await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled());
});
```

Read the component first for its real prop names, its export style (named vs default) and the role its trigger actually has, and correct the test to match — do not change the component to fit the test. If the trigger is not a `button`, assert on whatever it really is.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && CI=true npx craco test src/Components/governance/__tests__/DefectStatus.test.tsx --watchAll=false`

Expected: the numeric cases fail — the name-only resolver returns undefined, so the raw value renders and the control is disabled.

- [ ] **Step 3: Make the resolver handle both**

Change the lookup at ~line 71 to try id first, then name — mirroring `DefectFilterPanel.tsx:54-58` rather than inventing a second approach. Read that function and follow its shape. Comment it with why, citing this package and the sibling.

Both comparisons must go through `String(...)`, since real data holds `'8'` (string) and `1`/`2` (numbers).

- [ ] **Step 4: Run it and watch it pass, then the full suite and the linter**

Run: `cd frontend && CI=true npx craco test src/Components/governance --watchAll=false`
Run: `cd frontend && CI=true npx craco test --watchAll=false` — 0 failing, 35 non-running.
Run: `cd frontend && npx eslint 'src/**/*.{ts,tsx}'` — exit 0.

- [ ] **Step 5: Verify in a real browser**

Task 1 has already migrated the data, so Bug-3 now stores `'Open'` and the original symptom is gone from live data. That means a browser check confirms the *migration*, not the resolver. Do both honestly:

- Open Bug-3 in the workbench and confirm the chip reads a real status name and the control is enabled. This proves Task 1.
- State plainly in your report that the resolver hardening is proven by the jsdom tests rather than the browser, because no legacy record remains to exercise it. **Do not create one to demo it** — writing a bad `Status` back into real data to prove a fix is exactly the drift the register warns about.

- [ ] **Step 6: Update the register and commit**

Append a dated `### 2026-09-06 — after WP-F04` section that:
- **Corrects B6's premise.** It claimed the codes "never mapped to an `istatus` name". They map exactly; the mapping was in `srckube-issuestatus.staus` the whole time. Mark B6 **RESOLVED** and say what the codes were.
- Records the scale honestly: 3 of 116 documents, the only real defects in project 1.
- Records the second bug and its fix: `DefectStatus.tsx` resolved by name only while `DefectFilterPanel.tsx` already handled both.
- Under **Checked and FINE**: the mapping is not invented — it is `staus` verbatim, and the script aborts on any code outside it.

```bash
git add frontend/src/Components/governance docs/superpowers/PRODUCT_GAP_REGISTER.md
git commit -m "WP-F04b: resolve a defect status stored as an id, not just a name"
```

## Definition of done

- [ ] A backup was taken before any write, and its path is in the report.
- [ ] The dry run listed exactly Bug-1/2/3 and nothing else.
- [ ] All three read back through the API as `Closed` / `New` / `Open`.
- [ ] Re-running the script reports "Nothing to migrate".
- [ ] `cd backend/defectService && npx jest --runInBand` passes.
- [ ] Frontend: 0 tests failing, failed-suite count still 35; `eslint` exit 0.
- [ ] Bug-3 verified in a real browser: real status name, control enabled.
- [ ] `PRODUCT_GAP_REGISTER.md` corrects B6 rather than just closing it.

## Out of scope

- **The `staus` collection-name typo.** Real, cosmetic, and renaming a live collection is its own migration with its own risk. Record it, do not fix it.
- **`Deffered`'s spelling** — it is the stored value; "correcting" it would break every comparison against it.
- **Any other defect field.** `Priority` and `Severity` hold names already.
- **The 113 fixture defects in other projects.** They already store names.
