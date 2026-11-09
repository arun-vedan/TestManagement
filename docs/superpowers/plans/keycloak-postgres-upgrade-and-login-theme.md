# Plan — Keycloak + Postgres upgrade, and a login screen worth looking at

**Status**: proposed, not started. Written 2026-09-05.

**Everything below was verified against the running stack**, not assumed.

---

## Verified starting state

| | Running | Pinned? |
|---|---|---|
| Keycloak | **25.0.0** | **No tag** — `quay.io/keycloak/keycloak` |
| PostgreSQL | **16.3** | **No tag** — `postgres` |
| `keycloak-js` | `^25.0.0` | caret |
| Realm `srckube` login theme | **`kdk`** | — |

- `kdk` sets `parent=base` and overrides `template.ftl` (132 lines) and
  `login.ftl` (96 lines) **wholesale**, plus fragments and a bundled
  `quasar.js`. `kapp` inherits from `kdk` but is **not** the active login theme.
- Realm has `registrationAllowed: false`, `resetPasswordAllowed: false` — so
  there is no "sign up" or "forgot password" path to design for.
- `scripts/` has `mongo-backup.sh` / `mongo-restore.sh` (WP-064) and
  **nothing for Keycloak**. No realm export exists in the repo.

## Why these are one piece of work, not two

`kdk` overrides the base theme's FreeMarker templates wholesale. **That is
exactly what breaks across a Keycloak major**: the base theme's template
contract (variables, macros, includes) changes, and a wholesale override
either fails to render or silently loses behaviour the new base added.

So the login screen has to be re-tested and probably re-worked *as part of*
the upgrade regardless. Redesigning it first on 25, then upgrading, means
doing the same work twice. **Design against 26 once.**

## The risk that governs the sequence

**Every one of the 17 services, the frontend, and the entire E2E suite
authenticate through this Keycloak.** `e2e/auth/global-setup` performs a real
login against this very page to mint the storage state every spec depends on.

Two consequences:
1. A failed upgrade does not degrade the product — it stops it, **and takes
   the test suite with it**, removing the tool you would use to diagnose it.
2. A login theme change that renames or restructures the form fields breaks
   `global-setup`, and therefore all 23 specs, without touching a line of
   application code.

That is why backup comes before upgrade, and why the theme work carries an
explicit "do not rename the form contract" constraint.

---

## Step 1 — Pin the current versions (do this first, independently)

`image: postgres` and `image: quay.io/keycloak/keycloak` resolve to `:latest`
at pull time. The only reason the stack is on 25.0.0/16.3 is that these
containers were created 13 days ago. Any `docker compose pull`, or a fresh
machine, silently gets whatever is current that day — across majors.

Pin to `quay.io/keycloak/keycloak:25.0.0` and `postgres:16.3`.

- **Value**: stops silent drift immediately; makes the upgrade a deliberate,
  reviewable change rather than something that happens to you.
- **Risk**: none. It pins what is already running.
- This is the same discipline WP-016 enforced for npm dependencies, which the
  infra layer never adopted.

## Step 2 — Realm backup and restore, proven

Add `scripts/keycloak-export.sh` / `keycloak-import.sh` alongside the Mongo
pair, and **demonstrate a restore** — the bar WP-064 set for MongoDB and the
reason its data migrations were allowed to proceed.

Export the `srckube` realm (users, clients, roles, the theme binding) via
`kc.sh export` or the admin API. Commit the export as a fixture so the realm is
reproducible on another machine — which today it is not.

- **Value**: this is the actual prerequisite. Without it the upgrade is
  irreversible in practice.
- **Note**: the export contains client secrets. It must be handled under the
  existing GR-9 secrets rule — placeholder in the tracked file, real values in
  untracked `.env`, never committed raw.

## Step 3 — Postgres 16 → 17 (or 18), on its own

**A tag change alone will fail.** The data directory format changes across
majors; the new server refuses to start on an old cluster
("database files are incompatible with server"). The volume
`keycloack-themes-postgres` holds the realm.

Path: stop Keycloak → `pg_dump` the `keycloak` database → start the new
Postgres major on a **fresh volume** → restore → start Keycloak unchanged →
verify login and a full E2E run.

- **Do this alone**, with Keycloak still on 25. If something breaks, the cause
  is unambiguous.
- **Rollback**: keep the old volume untouched until the new one is proven. Do
  not delete it in the same change.
- Decide 17 vs 18 by what Keycloak 26 actually supports — check its documented
  supported-database matrix rather than taking the newest.

## Step 4 — Keycloak 25 → 26, with the config migration

A tag bump will not start with the current compose. Expected changes, **each
to be confirmed against the 26 release notes rather than trusted from here**:

| Current | Expected in 26 |
|---|---|
| `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` | `KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD` |
| `KC_PROXY: edge` | removed — replaced by `KC_PROXY_HEADERS` |
| `KC_HOSTNAME_URL` | folded into `KC_HOSTNAME` under hostname v2 |
| `KC_HOSTNAME_STRICT_HTTPS` | removed under hostname v2 |
| `KEYCLOAK_FRONTEND_URL` | legacy, removed |

Also bump `keycloak-js` from `^25` to match the server major, and pin it
exactly (WP-016).

**Verification**: clean container start, admin console reachable, a real login
through the app, all 17 services still authenticating (the Kong sweep), and
the full Playwright suite green — that last one is the real proof, because it
exercises `global-setup`'s live login.

## Step 5 — The login screen

### What is there now

A centred white card on flat grey: logo, "Sign in to your account", two
borderless grey inputs, a near-black LOGIN button. It works and it is
accessible enough, but:

- **The button is not the brand colour.** It is near-black; the product's brand
  anchor is `#244855`. The first screen a user sees does not match the product.
- **The inputs have no borders** and read as disabled — the same
  low-affordance problem the workbench had before the Wave-A colour pass.
- **No product framing**: nothing says what this tool is. A test-management
  platform's login is a reasonable place to say so.
- **A small card marooned in a large empty field** — no use of the space, no
  visual anchor.
- Default typography throughout, unrelated to the app's own type scale.

### What to change

Rework the `kdk` login theme against Keycloak 26's base:

- Adopt the product's design tokens — brand `#244855`, the neutral ramp, the
  13px/4px density scale from `src/Theme/tokens.ts` — so the login screen and
  the workbench look like one product.
- Give the inputs real borders and visible focus states; make the primary
  action unmistakably the brand colour.
- Use the space: a two-panel layout (brand/product framing beside the form) is
  the conventional pattern and fills the emptiness without decoration for its
  own sake.
- Handle the states that exist: invalid credentials, locked account, and the
  in-flight submit. Registration and password reset are **disabled in this
  realm** — do not design affordances for them.

### Constraints that are not negotiable

1. **Do not rename or restructure the form contract.** Keycloak's login form
   posts specific field names (`username`, `password`) and the submit control
   `global-setup` drives. Renaming them breaks every E2E spec via the shared
   login. Change appearance, not identifiers.
2. **Contrast is measured, not judged by eye** — the same rule the Wave-A
   colour pass established after a control shipped at 1.70:1. jsdom cannot see
   colour, and neither can a screenshot at a glance.
3. **Keep it a theme.** No new build step, no framework. The existing
   `quasar.js` bundle is worth questioning while in there — a login form does
   not need a UI framework — but removing it is a separate decision.

### Verification

Before/after screenshots at desktop **and** a narrow viewport, a real login
through the themed page, and the full Playwright suite green. A before-shot is
already captured for comparison.

---

## Sequence, and why

1. **Pin versions** — zero risk, stops drift, do it now.
2. **Realm backup + proven restore** — the prerequisite. Nothing else starts
   until a restore has actually been demonstrated.
3. **Postgres major** — alone, so a failure is unambiguous.
4. **Keycloak 25 → 26 + `keycloak-js`** — alone, for the same reason.
5. **Login theme** — last, designed once against 26 rather than twice.

Steps 3 and 4 each need a maintenance window: the whole product is unavailable
while its identity provider restarts, and the test suite cannot run either.

## Open questions for the owner

- **Postgres 17 or 18?** Decide from Keycloak 26's supported-database matrix.
- **The hardcoded credentials.** `POSTGRES_PASSWORD: password` and
  `KEYCLOAK_ADMIN_PASSWORD: Pass;word1` are in a **tracked** compose file, and
  the plan already records a live compromised client secret in git history with
  rotation approved but blocked. This upgrade touches every one of those
  values — it is the natural moment to rotate them all. That decision is
  yours, and the history scrub remains a destructive operation needing
  explicit go-ahead.
- **How much product framing** belongs on the login screen — a logo and a
  tagline, or something closer to a marketing panel.
