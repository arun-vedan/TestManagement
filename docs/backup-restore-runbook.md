# MongoDB Backup / Restore Runbook (WP-064)

Scripts: `scripts/mongo-backup.sh`, `scripts/mongo-restore.sh`.
Status: **backup + restore both work and have been tested end-to-end** (transcript below). Scheduling is **documented but not installed** — see "Is it actually scheduled?" below. Read that section before assuming this meets the RPO/RTO targets unattended.

## What this protects

Every MongoDB database whose name starts with `srckube-`, running in the `mongodb` container (`backend/docker-compose.yml`) on the `src-kube-network` Docker network. As of this writing that is 15 databases: `srckube-attachments`, `srckube-automation`, `srckube-comments`, `srckube-defects`, `srckube-fields`, `srckube-folder`, `srckube-issuestatus`, `srckube-linkissue`, `srckube-module`, `srckube-objectrepo`, `srckube-requirements`, `srckube-testexecution`, `srckube-testplan`, `srckube-testrepo`, `srckube-user`. The backup script discovers this list dynamically at run time (by prefix), so a new service's database is picked up automatically — nothing here needs editing when one is added.

**Deliberately excluded**: Mongo's own `admin`/`config`/`local` databases, and — important, see the next section — any database that does not belong to this project.

## IMPORTANT: a host port collision on this dev machine

While building and testing this WP, `lsof -nP -iTCP:27017 -sTCP:LISTEN` on the dev host showed **two** processes listening on port 27017 at once:

```
mongod    2078 arunganesha    9u  IPv4  TCP 127.0.0.1:27017 (LISTEN)
mongod    2078 arunganesha   10u  IPv6  TCP [::1]:27017 (LISTEN)
com.docke 2548 arunganesha  152u  IPv6  TCP *:27017 (LISTEN)          <- Docker's published port for the `mongodb` container
```

The first is a **stray, non-Docker, native `mongod` process** unrelated to this project. It requires no authentication and serves a completely different set of databases — including project-unrelated ones (`codeshark`, `authdeputy`, `fauserdb`, `fields-service`, `folders-service`) plus a **stale, divergent copy** of some `srckube-*` names (verified: its `srckube-testplan.testplans` had 6 documents at the time the container's had 7 — an old snapshot, not the live data).

Because the stray process binds the more specific address (`127.0.0.1` / `::1`) and Docker's proxy binds the wildcard (`*:27017`), **a connection to `localhost:27017` or `127.0.0.1:27017` from the host silently lands on the wrong mongod** — no error, just wrong (stale/foreign) data. This was caught during this WP's own testing (`mongodump`/`mongosh` from host tools failed to authenticate against the real container; against the stray process they succeeded with the wrong data) and is exactly the kind of failure R-07 exists to prevent — an "untested" backup running against this port would look successful and back up the wrong thing.

**The application itself was never at risk** — every backend service connects to the Docker service name `mongodb` on the internal `src-kube-network`, which Docker's embedded DNS can only resolve to the real container. Only host-originated TCP connections (a human at a terminal, or a script) can be fooled.

**Consequence for these scripts**: both `mongo-backup.sh` and `mongo-restore.sh` **default to talking to the container directly via `docker exec mongodb ...`**, never host TCP, specifically to sidestep this. Host-TCP mode exists as an explicit, warned opt-in (`MONGO_BACKUP_ALLOW_HOST_TCP=1`) for hosts where port 27017 is known-clean — do not set it on a machine you haven't checked with `lsof -nP -iTCP:27017 -sTCP:LISTEN` first.

**Also important**: this stray process means the pre-configured MongoDB MCP connection available in this environment (`connectionId: "preconfigured"`) talks to the same stray, non-Docker mongod, not the real stack. It was not used for anything in this WP's verification for that reason — all verification below is `docker exec mongodb ...`, which is unambiguous.

## Credentials (GR-9)

`MONGO_BACKUP_USER` / `MONGO_BACKUP_PASSWORD` — the same root credentials the `mongodb` service in `backend/docker-compose.yml` was started with (`MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD`). Set them in `backend/.env` (untracked; copy `backend/.env.example` if you haven't). The scripts never contain a literal credential.

## How to back up

```
./scripts/mongo-backup.sh
```

- Dumps every `srckube-*` database it discovers, one `mongodump --db <name>` invocation each, into `backups/mongo/<UTC timestamp>/<dbname>/` (host filesystem, gitignored — `backups/` is a repo-root `.gitignore` entry, never committed).
- Writes `MANIFEST.txt` (timestamp, mode, database list, any failures) alongside the dump.
- Non-zero exit, actionable stderr message, on any failure (missing credentials, mongod unreachable, a failed per-db dump). No silent retries.
- Env overrides: `MONGO_BACKUP_HOST`/`PORT`/`AUTH_DB`/`CONTAINER`, `BACKUP_OUT_DIR`. See the script header for all of them.

## How to restore (into a THROWAWAY target — never live)

```
./scripts/mongo-restore.sh --dump-dir backups/mongo/<timestamp> --target-prefix restoretest_ [--drop] [--db <name> ...]
```

- `--target-prefix` is **required** and non-empty. Every restored database is renamed via `mongorestore --nsInclude/--nsFrom/--nsTo` to `<prefix><original-name>` — the original (live) namespace is never addressed by the restore command at all.
- Before touching anything, the script queries the live database list and **aborts the entire run** if any computed target name already exists. This is checked once, up front, for every database in the batch — nothing is restored if any one of them would collide.
- After each database is restored, the script independently re-counts total documents in both source and target and fails that database (non-zero exit) if they don't match — this exists because `mongorestore` was observed, during testing, to exit 0 while having silently restored zero documents when pointed at the wrong directory layout (see "Restore implementation gotcha" below); exit code alone is not trustworthy evidence.
- `--drop` (optional) only drops collections inside the renamed target namespace, to make repeated test runs idempotent — it can never reach a live database because the target name can never equal a live one (enforced above).
- The script prints a ready-to-run `mongosh ... db.dropDatabase()` line per restored database at the end, for teardown.

### Restore implementation gotcha (worth knowing before you improvise a manual restore under pressure)

`mongorestore --nsFrom/--nsTo` only works when its positional argument is a **parent** directory whose immediate child is a directory named exactly like the source database — pointing it directly at the database's own dump folder does nothing (it logs `don't know what to do with file ..., skipping` for every `.bson` and still **exits 0** with "0 document(s) restored successfully"). The script stages each database into an isolated, single-database parent directory before calling `mongorestore`, specifically to avoid this. If you ever restore by hand, replicate that structure (or pass `--nsInclude` on the parent dump-root itself, which was separately verified to correctly scope to one db without touching siblings — see the transcript below for evidence of both failure and correct-usage cases).

## Tested restore — full real transcript (2026-08-29)

Enumerated databases directly from the container (ground truth; not from the MCP connection — see the port-collision warning above):

```
$ docker exec mongodb mongosh --quiet -u srckuberoot -p '<redacted>' --authenticationDatabase admin \
    --eval 'db.adminCommand({listDatabases:1, nameOnly:true}).databases.map(d=>d.name).forEach(n=>print(n))'
admin
config
local
srckube-attachments
srckube-automation
srckube-comments
srckube-defects
srckube-fields
srckube-folder
srckube-issuestatus
srckube-linkissue
srckube-module
srckube-objectrepo
srckube-requirements
srckube-testexecution
srckube-testplan
srckube-testrepo
srckube-user
```

**1. Backup** (`./scripts/mongo-backup.sh`):

```
==> Mongo credentials resolved (MONGO_BACKUP_USER=srckuberoot).
==> Using 'docker exec mongodb' (default — see host-port-collision note above).
==> Dump target: /Users/arunganesha/srckubetest/backups/mongo/20260829T023943Z
==> Discovered 15 srckube-* database(s): srckube-attachments srckube-automation srckube-comments srckube-defects
    srckube-fields srckube-folder srckube-issuestatus srckube-linkissue srckube-module srckube-objectrepo
    srckube-requirements srckube-testexecution srckube-testplan srckube-testrepo srckube-user
==> Dumping srckube-attachments ...
   ... (one line per database) ...
==> Backup complete: 15 database(s) dumped to /Users/arunganesha/srckubetest/backups/mongo/20260829T023943Z
    Manifest: .../MANIFEST.txt
```
Exit code: `0`. Dump size: 2.4 MB (`du -sh`).

**2. Restore into throwaway target** (`./scripts/mongo-restore.sh --dump-dir backups/mongo/20260829T023943Z --target-prefix restoretest_ --drop`):

```
==> Mode: container
==> Databases to restore: srckube-attachments srckube-automation srckube-comments srckube-defects srckube-fields
    srckube-folder srckube-issuestatus srckube-linkissue srckube-module srckube-objectrepo srckube-requirements
    srckube-testexecution srckube-testplan srckube-testrepo srckube-user
==> Anti-clobber guard passed. Live databases checked: 18.
    srckube-attachments  ->  restoretest_srckube-attachments
    ... (one line per database) ...
==> Restoring srckube-attachments (source has 28 document(s)) -> restoretest_srckube-attachments ...
    OK: restoretest_srckube-attachments has 28 document(s), matching source.
==> Restoring srckube-automation (source has 0 document(s)) -> restoretest_srckube-automation ...
    OK: restoretest_srckube-automation has 0 document(s), matching source.
==> Restoring srckube-comments (source has 37 document(s)) -> restoretest_srckube-comments ...
    OK: restoretest_srckube-comments has 37 document(s), matching source.
==> Restoring srckube-defects (source has 3 document(s)) -> restoretest_srckube-defects ...
    OK: restoretest_srckube-defects has 3 document(s), matching source.
==> Restoring srckube-fields (source has 20 document(s)) -> restoretest_srckube-fields ...
    OK: restoretest_srckube-fields has 20 document(s), matching source.
==> Restoring srckube-folder (source has 4 document(s)) -> restoretest_srckube-folder ...
    OK: restoretest_srckube-folder has 4 document(s), matching source.
==> Restoring srckube-issuestatus (source has 8 document(s)) -> restoretest_srckube-issuestatus ...
    OK: restoretest_srckube-issuestatus has 8 document(s), matching source.
==> Restoring srckube-linkissue (source has 20 document(s)) -> restoretest_srckube-linkissue ...
    OK: restoretest_srckube-linkissue has 20 document(s), matching source.
==> Restoring srckube-module (source has 2 document(s)) -> restoretest_srckube-module ...
    OK: restoretest_srckube-module has 2 document(s), matching source.
==> Restoring srckube-objectrepo (source has 0 document(s)) -> restoretest_srckube-objectrepo ...
    OK: restoretest_srckube-objectrepo has 0 document(s), matching source.
==> Restoring srckube-requirements (source has 12 document(s)) -> restoretest_srckube-requirements ...
    OK: restoretest_srckube-requirements has 12 document(s), matching source.
==> Restoring srckube-testexecution (source has 14 document(s)) -> restoretest_srckube-testexecution ...
    OK: restoretest_srckube-testexecution has 14 document(s), matching source.
==> Restoring srckube-testplan (source has 7 document(s)) -> restoretest_srckube-testplan ...
    OK: restoretest_srckube-testplan has 7 document(s), matching source.
==> Restoring srckube-testrepo (source has 7 document(s)) -> restoretest_srckube-testrepo ...
    OK: restoretest_srckube-testrepo has 7 document(s), matching source.
==> Restoring srckube-user (source has 30 document(s)) -> restoretest_srckube-user ...
    OK: restoretest_srckube-user has 30 document(s), matching source.
==> Restore complete. Restored into throwaway database(s): (15 restoretest_* names listed)
```
Exit code: `0`. All 15 databases' total document counts matched (script's own built-in check).

**3. Per-collection count comparison** (independent of the script, run directly against the container — every collection in every database, not just per-db totals):

```
== srckube-attachments ==
  filesBucket.chunks: source=17 target=17  OK
  filesBucket.files: source=11 target=11  OK
== srckube-automation ==
  automations: source=0 target=0  OK
== srckube-comments ==
  comments: source=37 target=37  OK
== srckube-defects ==
  defects: source=3 target=3  OK
== srckube-fields ==
  fields: source=20 target=20  OK
== srckube-folder ==
  folders: source=4 target=4  OK
== srckube-issuestatus ==
  staus: source=8 target=8  OK
== srckube-linkissue ==
  linkissues: source=20 target=20  OK
== srckube-module ==
  modules: source=2 target=2  OK
== srckube-objectrepo ==
  objectrepos: source=0 target=0  OK
== srckube-requirements ==
  requirements: source=5 target=5  OK
  requirementversions: source=7 target=7  OK
== srckube-testexecution ==
  testexecutions: source=14 target=14  OK
== srckube-testplan ==
  testplans: source=7 target=7  OK
== srckube-testrepo ==
  testcaserepos: source=3 target=3  OK
  testcaseversions: source=4 target=4  OK
== srckube-user ==
  organizations: source=0 target=0  OK
  projects: source=0 target=0  OK
  users: source=30 target=30  OK
```
Every collection in every database matched exactly.

**4. Spot-checked real documents** (full-document `JSON.stringify` equality, source vs. restored target, by `_id`) — `true` for all of: `srckube-testplan.testplans` (a real `TestPlanId: "PLN-1"` document, full field match including nested `TestCases` array), `srckube-testexecution.testexecutions`, `srckube-issuestatus.staus`, `srckube-linkissue.linkissues`, `srckube-user.users`, `srckube-requirements.requirements`, `srckube-defects.defects`.

**5. Teardown** — every `restoretest_*` database dropped:

```
dropped restoretest_srckube-attachments: {"ok":1,"dropped":"restoretest_srckube-attachments"}
... (one line per database, all ok:1) ...
```

Final live database list, re-verified identical to the pre-test list (no `restoretest_*` leftovers, no change to any live `srckube-*` database):
```
admin, config, local, srckube-attachments, srckube-automation, srckube-comments, srckube-defects,
srckube-fields, srckube-folder, srckube-issuestatus, srckube-linkissue, srckube-module, srckube-objectrepo,
srckube-requirements, srckube-testexecution, srckube-testplan, srckube-testrepo, srckube-user
```

This is a genuinely verified restore, not a claim: dump → restore into a throwaway, renamed target → full per-collection count match → field-level document match on real data → clean teardown, with the live databases confirmed untouched throughout.

## RPO / RTO — what this setup actually delivers, honestly

Strategy §14 targets: **RPO 24h / RTO 4h**.

- **What exists today**: an **on-demand** backup script (`mongo-backup.sh`) that, when run, produces a complete, restorable dump in under a minute for the current ~2.4 MB of data. A restore into a throwaway target has been proven to work end-to-end (above), and a real restore into a fresh/replacement `mongodb` container (rather than a renamed sibling) is the same command with `--target-prefix` chosen to equal a *new, empty* target — the mechanism is identical.
- **Is it actually scheduled? No.** Nothing in this repo or on this machine invokes `mongo-backup.sh` automatically. **RPO 24h is not currently met by anything running** — it would only be met from the moment a human or CI system actually schedules it. This is a real gap, stated plainly rather than glossed over.
- **To make RPO 24h real**, add a daily cron entry (adjust user/path):
  ```
  0 2 * * *  cd /path/to/srckubetest && ./scripts/mongo-backup.sh >> /var/log/srckube-mongo-backup.log 2>&1
  ```
  This is a **documented recommendation**, not an installed schedule — nothing in this WP touched crontab, launchd, or any CI schedule config (out of scope for a `scripts/`+`docs/` WP, and doing so on a shared dev machine without being asked would be its own risk).
- **RTO 4h**: the restore mechanism itself, once a recent dump exists, takes well under an hour for the current data volume (the full 15-database test restore above took a few seconds). The 4h budget is realistic for a human following this runbook under pressure — locate the latest dump under `backups/mongo/`, run `mongo-restore.sh` with a target that replaces the affected data (e.g., restore into a fresh container/volume, verify, then cut traffic over), rather than being a claim about an automated failover (none exists, and none was requested by this WP).

In short: **the mechanism is real and tested; the schedule is not installed.** Treat RPO 24h as "achievable the day someone adds the cron line above," not as a currently-active guarantee.

## Where dumps live / retention

`backups/mongo/<UTC timestamp>/` at the repo root. Gitignored (`.gitignore`: `/backups/`) — dumps are real (and potentially customer-like) data and must never be committed; verified with `git status` after running the scripts (no `backups/` entries appear as trackable). No retention/rotation policy is implemented — each run adds a new timestamped directory; an operator or a future WP should add pruning if disk usage becomes a concern.
