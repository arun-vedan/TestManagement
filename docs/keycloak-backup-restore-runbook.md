# Keycloak Realm Backup / Restore Runbook (WP-065, Step 2 of the Keycloak/Postgres upgrade plan)

Scripts: `scripts/keycloak-export.sh`, `scripts/keycloak-import.sh`.
Plan: `docs/superpowers/plans/keycloak-postgres-upgrade-and-login-theme.md` (Step 2).
Status: **export + restore both work and have been tested end-to-end using the actual scripts** (transcript below). This is the prerequisite the plan requires before the Postgres and Keycloak major-version upgrades (Steps 3-4) may start.

## What this protects

The **`srckube`** realm in the `keycloak` container (`keycloak-themes/docker-compose.yml`), Keycloak 25.0.0, backed by Postgres 16.3 in the `postgres` container (volume `keycloack-themes-postgres`).

**Captured by an export** (verified by inspecting an actual export file, not assumed):

- **Users, including password credentials.** Each user's `credentials[].secretData`/`credentialData` is embedded (e.g. an argon2 hash + salt). This only happens because the export uses the `--users realm_file` strategy — `kc.sh export`'s **default** strategy is `skip`, which silently omits every user. If anyone ever edits this script and drops `--users realm_file`, the export will look complete but restoring it will produce a realm with zero logins.
- **Clients, including confidential clients' plaintext secrets.** Verified: the `node-microservice` client's `secret` field is present in cleartext in the export.
- **Realm roles, client roles, and every user's role mappings** (`realmRoles`/`clientRoles` per user — verified present per user in the export).
- **The `loginTheme` binding** — verified as `"kdk"` in the export, matching the live realm.
- **Groups.**
- **The realm's own signing/encryption key material**, under `components` → `org.keycloak.keys.KeyProvider` (includes a raw AES secret). This means the export is at least as sensitive as the database itself, not merely "config."

**NOT captured, deliberately:**

- **The `master` realm, including its own admin user, is never exported.** The script always passes an explicit `--realm srckube`; `kc.sh export` scopes to exactly that realm and never touches `master`. This was a deliberate choice, not an oversight: exporting `master` would put a Keycloak superadmin's password hash into a backup file this same script has to protect, for no benefit to restoring `srckube`. **Consequence for a restore**: this export cannot bootstrap a from-scratch Keycloak instance's admin login by itself — it assumes `master`/the console admin credentials already exist independently (they do: `KEYCLOAK_ADMIN`/`KEYCLOAK_ADMIN_PASSWORD` in `keycloak-themes/docker-compose.yml`, which the owner has explicitly decided stay as-is for now, not rotated as part of this work). If a `master`-realm backup is ever needed, that is a separate, explicit decision with its own blast-radius discussion — this script does not attempt it.
- **Live session state and audit/event data.** A realm export is a config+identity snapshot, not a full point-in-time database dump. If a full `keycloak` Postgres database snapshot is ever wanted in addition (e.g. immediately before the Postgres major-version upgrade in Step 3), that is a plain `pg_dump` against the `postgres` container — out of scope for this script, which is realm-level, not database-level.

## How the export actually works (and a real gotcha)

`kc.sh export` is run via `docker exec keycloak /opt/keycloak/bin/kc.sh export --realm srckube --users realm_file --dir <tmp>`, then the resulting `srckube-realm.json` is `docker cp`'d to the host. This is **not** an Admin-REST-API export — it's a second, transient Quarkus process inside the same container, reading Postgres directly via the container's existing `KC_DB_*` env vars. That's why it captures password hashes and key material that the Admin REST API's `GET /users` never returns.

**Gotcha, verified directly**: this transient process successfully exports (`KC-SERVICES0035: Export finished successfully` in the log), and then — because the *live* Keycloak server in the same container already holds ports 8080/9000 — fails to bind its own HTTP/management listener and **exits with status 1**, logging `Address already in use`. This happens strictly after the export has already completed and does not affect the live server (different PID). Both scripts therefore **check the log for the explicit success marker, not the exit code**. Exactly the same pattern applies to `kc.sh import` (`KC-SERVICES0032: Import finished successfully`).

## How to back up

```
./scripts/keycloak-export.sh
```

- Exports realm `srckube` (override with `KEYCLOAK_EXPORT_REALM`) from container `keycloak` (override with `KEYCLOAK_EXPORT_CONTAINER`) into `backups/keycloak/<UTC timestamp>/srckube-realm.json`, plus `MANIFEST.txt` and `.export.log`.
- Verifies contents with `jq` (user/client/role counts, `loginTheme`) rather than just claiming success; degrades to a plain warning (not a failure) if `jq` is unavailable.
- Non-zero exit, actionable stderr, if the container isn't running, `kc.sh` is missing, or the log never shows the success marker.

## How to restore

```
./scripts/keycloak-import.sh --dir backups/keycloak/<timestamp> --realm srckube --confirm srckube --restart-after
```

Unlike `scripts/mongo-restore.sh`, **this restores into the real realm**, not a renamed throwaway copy — there is no equivalent of "restore into `restoretest_srckube`" for a Keycloak realm that would actually prove anything about *this* realm's recoverability, which is the entire point of this step. The safety net is therefore **typed confirmation, not renaming**:

- `--realm <name>` must match the realm embedded in the export file's name (`<realm>-realm.json`).
- `--confirm <name>` must **exactly repeat** `--realm`'s value — a deliberate second, typed confirmation before a live realm is overwritten. Verified to refuse a mismatch (`--realm srckube --confirm nope` exits 1 with no import attempted).
- `kc.sh import` defaults to `--override true` (Keycloak's own default: delete-and-recreate the target realm from the file). `--no-override` is available but is **not the tested path** — say so if you use it.

### The critical, verified caveat: the running server does not see an import until it restarts

`kc.sh import`, like export, is a separate process writing straight to Postgres — it does **not** go through the live Keycloak server, and the live server's in-memory realm cache is **not** invalidated by that out-of-process write. This was directly observed while proving this restore (transcript below): immediately after a successful import, the Admin REST API on the **live, already-running** server still reported the pre-restore state (a just-restored role was missing) using a **freshly issued** admin token — not a caching issue on the token, a caching issue on the realm model itself. Restarting the `keycloak` container fixed it immediately: the server reloads the realm from Postgres from scratch on boot.

**Consequence**: `keycloak-import.sh` does not consider an import "done" in any user-visible sense without a restart. By default it imports and stops, printing an explicit warning. Pass `--restart-after` to have it restart the container itself and poll `http://localhost:8080/realms/<realm>/.well-known/openid-configuration` **from the host** (not via `docker exec` — the Keycloak image has no `curl` inside it, which the first draft of this script got wrong; see "mistakes made while building this" below) until the realm answers.

**This is a real, if brief, outage.** All 17 backend services and the frontend authenticate through this Keycloak — restarting it is a genuine maintenance action, not a no-op, and should be treated that way (it took roughly 8-10 seconds to become ready again in testing).

## Tested restore — full real transcript (2026-09-05), using the actual scripts

Baseline, confirmed via Admin REST API before starting: realm `srckube` has 3 realm roles (`default-roles-srckube`, `offline_access`, `uma_authorization`), 8 clients, 8 users (incl. the `node-microservice` service-account user), `loginTheme=kdk`.

**1. Create a throwaway, reversible object** (a realm role — the strongest safe proof available without deleting anything real; see plan constraints):

```
POST /admin/realms/srckube/roles  {"name":"wp065-script-proof-role", ...}
-> 201
GET /admin/realms/srckube/roles -> [..., "wp065-script-proof-role", ...]
```

**2. Export** (`./scripts/keycloak-export.sh`):

```
==> Container 'keycloak' is running and has kc.sh.
==> Export target: /Users/arunganesha/srckubetest/backups/keycloak/20260905T014455Z
==> Running kc.sh export for realm 'srckube' ...
==> kc.sh reported: Export finished successfully (exit code 1 -- see script header ...)
==> Copied srckube-realm.json to .../backups/keycloak/20260905T014455Z
==> Verified contents: 8 user(s) (7 with password credentials), 8 client(s), 4 realm role(s), loginTheme="kdk".
==> Export complete: ...
```

The role count (4, not the baseline 3) independently confirms the export captured the just-created throwaway role. `jq '[.roles.realm[].name]'` on the file confirms `wp065-script-proof-role` is present by name.

**3. Delete the throwaway role** (simulating the loss the restore must undo):

```
DELETE /admin/realms/srckube/roles/wp065-script-proof-role -> 204
GET /admin/realms/srckube/roles -> ["default-roles-srckube","offline_access","uma_authorization"]   (back to 3, role gone)
```

**4. Restore** (`./scripts/keycloak-import.sh --dir backups/keycloak/20260905T014455Z --realm srckube --confirm srckube --restart-after`):

```
==> About to OVERWRITE realm 'srckube' in container 'keycloak' from: .../srckube-realm.json
    override=true, restart-after=yes
==> Running kc.sh import ...
==> kc.sh reported: Import finished successfully (exit code 1 -- ...)
==> Restarting 'keycloak' so the live server picks up the restored data ...
==> Waiting for realm 'srckube' to answer OIDC discovery (checked from the host -- curl is not installed inside the Keycloak image itself) ...
==> Realm 'srckube' is answering. Restore is live-verified.
==> Import complete for realm 'srckube'.
```

**5. Proof it actually came back** — queried the **live, running** server via a **freshly issued** admin token (not reused from before the restart):

```
GET /admin/realms/srckube/roles -> ["default-roles-srckube","offline_access","wp065-script-proof-role","uma_authorization"]
```

The throwaway role is back. This is the real proof: not "the export file contains it" (step 2) but "the live server now serves it after going through delete → export-based restore → restart."

**6. Full stack proof — the real point of this whole step**: with the frontend dev server running against this exact post-restore Keycloak, ran the complete Playwright suite:

```
$ npx playwright test --project=chromium   (from frontend/)
Running 23 tests using 1 worker
  ✓ 1..23  (all pass, including auth.spec.ts:23 "a real Keycloak login lands on the project-scoped dashboard shell")
23 passed (1.3m)
```

This is the test that matters most: `e2e/auth/global-setup.ts` performs a **real login** against the restored realm to mint the storage state every other spec depends on. All 23 specs green after the export→delete→restore→restart cycle proves the realm is genuinely intact, not merely that a JSON file round-tripped.

**7. Teardown** — deleted the throwaway role again (it had been restored, so removing it once more returns the realm to its exact original state):

```
DELETE /admin/realms/srckube/roles/wp065-script-proof-role -> 204
GET .../roles -> ["default-roles-srckube","offline_access","uma_authorization"]   (matches baseline exactly)
```

Final verification against baseline — all matched exactly: 3 realm roles, 8 clients (`account`, `account-console`, `admin-cli`, `broker`, `mern-app`, `node-microservice`, `realm-management`, `security-admin-console`), all 8 users present (incl. the `node-microservice` service-account user, confirmed via the dedicated `/clients/{id}/service-account-user` endpoint — it doesn't appear in the plain `/users` search, which is normal Keycloak behavior unrelated to the restore), `loginTheme=kdk`, and `node-microservice`'s client secret unchanged.

## Mistakes made while building this (left in, on purpose)

The first version of `keycloak-import.sh`'s `--restart-after` health check ran `curl` **inside** the Keycloak container via `docker exec` — that image has no `curl` installed, so every check silently failed (curl: command not found → captured as exit code, treated as HTTP 000) and the script reported failure after 60s **even though the restore had already succeeded** (confirmed independently via the host-side Admin API at the time). Fixed by polling from the host instead, which is what actually works and is what ships. Documented here because "the script said it failed" and "the restore failed" turned out to be two different claims, and conflating them would have been a false alarm exactly of the kind these runbooks exist to prevent.

## Secrets (GR-9)

The export contains client secrets, user password hashes, and realm key material (see above) — **more sensitive than a typical config export**. The output directory (`backups/keycloak/`, default; override with `KEYCLOAK_BACKUP_OUT_DIR`) is gitignored via the repo's existing root `/backups/` entry — the same rule that already protects `scripts/mongo-backup.sh`'s dumps under `backups/mongo/`. **Nothing was committed.** No sanitised fixture was created either — the plan permitted one but did not require it, and stripping secrets from a Keycloak realm export well enough to make it safely public (client secrets, password hashes, AND the realm's own signing key material) while keeping it useful as a realistic fixture is a nontrivial, separate piece of work; producing a half-sanitised version would create a false sense of safety. If a checked-in fixture is wanted later, that's a follow-up, not part of this step.

## RPO / RTO — stated honestly

- **What exists today**: an on-demand export script that produces a complete, restorable realm snapshot in a few seconds, and a restore mechanism proven to work end-to-end including container-restart visibility and a full live-login E2E pass.
- **Is it scheduled? No.** Nothing invokes `keycloak-export.sh` automatically — same gap, same honesty, as `docs/backup-restore-runbook.md`'s Mongo equivalent. If a schedule is wanted, add a cron line the same way that runbook documents for Mongo, e.g.:
  ```
  0 2 * * *  cd /path/to/srckubetest && ./scripts/keycloak-export.sh >> /var/log/srckube-keycloak-backup.log 2>&1
  ```
- **RTO**: the restore mechanism itself (import + restart + host-side health check) took well under a minute in testing. The real cost of a restore is the brief Keycloak outage during the restart, which every one of the 17 backend services and the frontend will feel simultaneously (all authenticate through this Keycloak) — plan the maintenance window accordingly, exactly as the upgrade plan's Steps 3-4 already call for.

## Where exports live / retention

`backups/keycloak/<UTC timestamp>/` at the repo root, gitignored. No retention/rotation is implemented; an operator or future WP should add pruning if disk usage becomes a concern (each export is currently well under 100 KB for this realm's size).

---

## Postgres major-version upgrade (WP-065, Step 3): 16.3 → 18, done 2026-09-05

**Path taken**: dump → fresh volume → restore, exactly as Step 3 of the plan requires — a tag change alone does not work; PostgreSQL refuses to start a new major against an old cluster's data directory.

**Commands, in order:**

```
# 1. Pre-flight: realm export as a second, independent safety net
./scripts/keycloak-export.sh
# -> backups/keycloak/20260905T072612Z/ (3 realm roles, 8 clients, 8 users
#    [7 with password credentials], loginTheme=kdk)

# 2. Stop Keycloak FIRST so nothing writes mid-dump, then dump
cd keycloak-themes && docker compose stop keycloak
docker exec postgres pg_dump -U keycloak -d keycloak -Fc -f /tmp/keycloak_final.dump
docker cp postgres:/tmp/keycloak_final.dump backups/postgres/20260905T072746Z/keycloak.dump
docker exec postgres rm -f /tmp/keycloak_final.dump

# Verified the dump before touching anything else:
docker run --rm -v <dumpfile>:/dump.pgdump postgres:18 pg_restore --list /dump.pgdump
# -> 464 TOC entries, 94 tables with data, "Dumped from database version: 16.3"

# 3. Stop Postgres
docker compose stop postgres

# 4. Edit keycloak-themes/docker-compose.yml: postgres:16.3 -> postgres:18,
#    point at a NEW volume (keycloack-themes-postgres-pg18), old volume
#    (keycloack-themes-postgres) left declared but unused -- untouched.

# 5. Bring up Postgres 18 on the fresh volume, let it initialise
docker compose up -d postgres

# 6. Restore
docker cp backups/postgres/20260905T072746Z/keycloak.dump postgres:/tmp/keycloak_restore.dump
docker exec postgres pg_restore -U keycloak -d keycloak --no-owner --role=keycloak -v /tmp/keycloak_restore.dump
# -> exit 0, zero errors/warnings in the full log

# 7. Start Keycloak (image and version untouched -- still 25.0.0)
docker compose up -d keycloak
```

**A real breaking change hit mid-upgrade, not in the plan's own risk list**: the official `postgres:18` image changed its volume convention. It now expects a *single* mount at `/var/lib/postgresql` (not `/var/lib/postgresql/data` as every prior major used) and manages a versioned subdirectory itself, pg_ctlcluster-style (see `docker-library/postgres#1259`). Mounting at the old `.../data` path made the container refuse to start even against a brand-new, empty volume, with:

```
Error: in 18+, these Docker images are configured to store database data in a
       format which is compatible with "pg_ctlcluster" ...
       Counter to that, there appears to be PostgreSQL data in:
         /var/lib/postgresql/data (unused mount/volume)
```

No data existed yet at that point (the volume was seconds old and empty), so this was a compose fix, not a recovery. `keycloak-themes/docker-compose.yml`'s postgres volume mount was changed from `keycloack-themes-postgres-pg18:/var/lib/postgresql/data` to `keycloack-themes-postgres-pg18:/var/lib/postgresql` and the container started cleanly (`initdb` succeeded, `data_checksums=on`, locale `en_US.utf8` — the checksums default is new to 18's initdb behavior; the 16.3 cluster's checksum setting was never queried directly since it had already been dumped and stopped before this was noticed, but it's a storage-layer property that does not affect a logical dump/restore's correctness). **Any future Postgres major upgrade on this compose file should check the target image's volume-mount convention before assuming the existing mount path still applies.**

**Verification performed, in order (all passed):**
1. Realm intact via Admin API, matching the pre-upgrade baseline exactly: 3 realm roles, 8 clients, 7 users (`/users` endpoint — the 8th, `node-microservice`'s service-account user, is deliberately absent from that listing, same as always), `loginTheme=kdk`. `node-microservice`'s client secret confirmed byte-identical (compared against `.env.test`).
2. A real login: created a throwaway user via the Admin API, obtained a token via the OIDC password grant through the public `mern-app` client (`directAccessGrantsEnabled=true`) — the same token endpoint the hosted login page drives — then deleted the throwaway user, restoring the realm to exactly its prior state.
3. Kong route sweep with a **freshly minted** service token (`backend/shared/test-utils/getServiceToken.js`): all 16 routes 401 unauthenticated, 200 authenticated (`testplan`/`testexecution`/`fields` need `X-Project-Id`, same as the already-documented `testrepo`/`requirement`/`defects` — a pre-existing app-layer scoping detail, unrelated to this upgrade).
4. Full Playwright suite from `frontend/`: `npx playwright test --project=chromium` — **23/23 passed**, including `auth.spec.ts`'s real Keycloak login via `global-setup`.

**Keycloak boot log**: clean, no Liquibase/migration/schema errors — grepped explicitly for `liquibase|migrat|schema|databasechangelog|ERROR|FATAL`, zero hits. Only pre-existing, unrelated deprecation warnings (`KC_PROXY: edge` deprecated, hostname-strict-* unavailable under hostname v1) that predate this change.

**Old volume**: `keycloack-themes-postgres` (16.3 data, ~67.6 MB) is left completely untouched — not deleted, not pruned, not mounted by anything. Confirmed present and readable (`docker volume ls`, and a read-only inspect of its contents) after the upgrade completed.

### Rollback procedure (if ever needed)

1. `cd keycloak-themes && docker compose stop keycloak postgres`
2. Edit `docker-compose.yml`: postgres image back to `postgres:16.3`, volume mount back to `keycloack-themes-postgres:/var/lib/postgresql/data`.
3. `docker compose up -d postgres` (starts against the untouched old volume — no restore needed, it was never touched), then `docker compose up -d keycloak`.
4. Verify: Admin API realm counts, a real login, Kong sweep, Playwright suite — same four checks as above.

`postgres:16.3` is pulled and cached locally (`docker images`) specifically so this path doesn't depend on the ambiguous `postgres:latest` tag. The dump taken during this upgrade (`backups/postgres/20260905T072746Z/keycloak.dump`) is also available as a second path back onto a fresh 16.3 volume if the old volume were ever lost, though the primary rollback is simply reattaching the old volume, unmodified.

## Environment left as found

Verified after all testing: realm `srckube` has exactly the same 3 realm roles, 8 clients (with `node-microservice`'s secret unchanged), 8 users, and `loginTheme=kdk` as before this work began. The `keycloak` container was restarted twice during testing (an inherent, documented part of proving the restore's visibility, not a side effect) but is the same container, same image (`quay.io/keycloak/keycloak:25.0.0`, pinned in Step 1), same volumes, same config — nothing about the stack's definition changed. No throwaway realm objects remain. The full 23-spec Playwright suite passes against the post-test realm.
