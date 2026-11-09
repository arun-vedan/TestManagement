# LAUNCH_PLAN.md — multi-tenant self-serve SaaS + Jira

**Audience**: autonomous coding agents, same contract as
[`AGENT_EXECUTION_PLAN.md`](AGENT_EXECUTION_PLAN.md). Every WP below is self-contained:
context, scope, files, acceptance. **All ten Ground Rules in
`AGENT_EXECUTION_PLAN.md` §"Ground rules (every agent, every WP)" apply unchanged**,
especially GR-1 (verify before acting) and GR-10 (definition of done). Where a WP here
needs an exemption from a ground rule, it says so explicitly and names the rule.

**Scope decided by the owner, 2026-09-26:**

1. Multi-tenant with **self-signup** (not invite-only).
2. New domain and branding.
3. **Traefik** for ingress and TLS.
4. AI **off by default**, enabled per project on request for a bounded period.
5. Rotate every secret, purge git history, move to new remotes.
6. **Jira link integration** in launch scope.

**Phases.** Phase 1 is the launch gate; everything else can slip. Phase 5 is named so it
does not get lost, and is not in launch scope.

| Phase | Weeks | Theme |
|---|---|---|
| 0 | 1 | Foundations and cheap correctness |
| 1 | 2–6 | Tenancy — the launch gate |
| 2 | 6–9 | Self-serve onboarding |
| 3 | 9–12 | Jira, link-only v1 |
| 4 | 2–11 | Infrastructure and launch (threaded) |
| 5 | post | CLI + MCP + drift detection |

---

## Operational warnings — read before dispatching anything

These are recorded failures from this repo's own history, not hypotheticals.

- **The rate limiter will fake a test failure.** Running `scripts/run-api-tests.sh`
  two or three times within ten minutes exhausts `RATE_LIMIT_MAX` and returns 429,
  which presents as a wall of unrelated test failures (observed:
  testPlanExecutionService 8-failed/15-passed from 429s alone, then 23/23 green after a
  container restart with no code change). See `AGENT_EXECUTION_PLAN.md` line ~349.
- **Membership changes take up to 30 seconds to apply.**
  `PROJECT_SCOPE_CACHE_TTL_MS` defaults to 30 000 ms. This already produced one false
  "`authorize()` isn't wired" conclusion during WP-022. Every Phase 1 agent must be told
  up front, or each will rediscover it and one will file a defect that does not exist.
- **Restart Kong after rebuilding any backend container** (GR-5, TD-21).
- **`commentsService` and `uploadService` carry deliberate deviations.**
  `commentsService/middleware/advancedResults.js:3` sets `req.query['status'] = 1` to
  enforce soft-delete filtering — it is a real difference, not drift, and must not be
  consolidated away. `uploadService` deliberately does **not** call
  `applyStandardSecurity()` because that bundles `express-fileupload`, which would consume
  the multipart stream ahead of multer and break every upload route.
- **CI cannot run the black-box suites.** Every `tenantIsolation` / `api` suite needs the
  local compose stack up plus the Kong and Keycloak stacks. Agents must bring the stack up
  themselves and record the output (GR-10).

---

# Phase 0 — Foundations and cheap correctness (~1 week)

Blocks everything downstream. WP-102 through WP-105 are independent of each other and of
WP-100/101 — **dispatch those four in parallel immediately.**

## WP-100 — Rotate every secret, purge history, move to new remotes

> **THIS IS A HUMAN TASK, NOT AN AGENT TASK.** It requires credentials an agent does not
> have, and it needs an explicit **exemption from GR-2**, which forbids any history
> rewrite. An agent may prepare the verification script and the `.env.example`; only the
> owner creates remotes, rotates credentials and pushes.

**Depends on**: nothing. Blocks WP-101, WP-150, WP-151.

- Rotate: MongoDB root password, Keycloak admin password, `node-microservice` client
  secret, the realm RS256 keypair, and introduce a Redis password (there is none today —
  `Redis_URI=redis://redis:6379`).
- Fresh squashed initial commit on **both** repositories. `srckube-kong` is a separate
  git repository (submodule) and `kong.yml` carries the pinned realm public key in its
  own history — cleaning the main repo does nothing for it.
- Known secrets in current history, for the verification sweep: `JWT_SECRET`,
  `SMTP_PASSWORD` and `GEOCODER_API_KEY` in `backend/*/config/config.env` added in commit
  `c500846`; the MongoDB root password across 15 commits; 32 commits touching
  `KeyCloak_Secret`.
- Decide explicitly whether `EXECUTION_LOG.md` (9 500 lines, candid about every weakness)
  travels to the new remote.
- **Acceptance**: `git log -S` for each rotated secret returns zero hits on both new
  remotes, verified **before** the first push. Old remotes archived offline, not deleted,
  until launch.

## WP-101 — Config surface hardening

**Depends on**: WP-100 for the real values. The code changes can proceed in parallel
against placeholder env vars.

- Secrets out of `backend/docker-compose.yml` (the Mongo root password appears inline 25
  times) into `.env`, with `config.env.example` placeholders per GR-9.
- Drop host port mappings: Mongo `27017`, Redis `16379`, and all 18 service ports. Only
  the ingress should be reachable from the host.
- Kong admin to loopback; unpublish `8001`, `8444`, `8002` (Kong Manager).
- Session secret from env — `shared/service-core/keycloak.js:46` hardcodes
  `secret: 'test'`, inherited by all 18 services.
- Confirm `NODE_ENV=production` so `resolveRateLimitMax()` returns 100, not the local
  100 000.
- **Acceptance**: a port scan of the host shows only the ingress ports; every service
  still green on `/healthz` through Kong; full route sweep unchanged.

## WP-102 — Pass the filter to `countDocuments()`

**Depends on**: nothing. Independent — dispatch immediately.

- `shared/service-core/middleware/advancedResults.js:126` computes its total as
  `model.countDocuments()` with no filter — not even the tenant filter it added to the
  query at line 80. Pass the same filter object the `find()` uses.
- Apply the identical fix to `commentsService/middleware/advancedResults.js:41`.
  **Do not consolidate the two files.** Line 3 of the commentsService copy sets
  `req.query['status'] = 1` to enforce soft-delete filtering; it is a documented
  deliberate deviation (GR-1).
- **Acceptance**: the unit test asserts the *argument* `countDocuments` receives, not
  just its mocked return (`__tests__/advancedResults.test.js:16` currently only mocks the
  return). A project with 40 documents in a 20 000-document collection offers exactly two
  pages, not 800.

## WP-103 — Delete the stale default-project guards

**Depends on**: nothing. Independent — dispatch immediately.
**Mandatory before any demo.**

- Remove the `projectId !== UNSCOPED_SOURCE_DEFAULT_PROJECT_ID` early returns from
  `reportingService/services/passRateTrend.js:25`, `planProgress.js:22` and
  `workload.js:38`, then delete `UNSCOPED_SOURCE_DEFAULT_PROJECT_ID` from
  `reportingService/services/serviceUrls.js:22`.
- **The premise those guards cite is false** (GR-1 — verify this yourself before
  changing anything): they claim testPlanExecutionService has no per-project scoping.
  `TestExecution.projectId` (`models/TestExecution.js:154`) and `TestPlan.projectId`
  (`models/TestPlan.js:44`) are both `required` and indexed, and both route files mount
  `requireProjectScope()` on every route (16 and 10 occurrences respectively).
- Audit `linkIssueService/controllers/linkIssue.js:27`, which carries the same stale
  `DEFAULT_PROJECT_ID = '1'` shim on its coverage endpoints.
- **Acceptance**: one test per report asserting non-empty output for a project whose id
  is not 1. Verified live through Kong against a second project with real execution data.

## WP-104 — Make `wildcardsearch` safe and bounded

**Depends on**: nothing. Independent — dispatch immediately.

- Three controllers interpolate raw query input straight into `$regex` with no escaping,
  no `limit` and no text index: `testRepoService/controllers/testrepo.js:412`,
  `requirementService/controllers/requirement.js:173`,
  `defectService/controllers/defects.js:208`.
- Escape the input, cap the result set, add text indexes on the searched fields, and
  delete the `console.log(req.query.search)` at `testrepo.js:413`.
- With self-signup this stops being a scale concern and becomes a denial of service any
  registered stranger can trigger.
- **Acceptance**: a catastrophic-backtracking pattern returns a bounded result set inside
  the normal latency budget; `explain()` shows an index scan, not `COLLSCAN`.

## WP-105 — Retry 429 with `Retry-After`

**Depends on**: nothing. Independent — dispatch immediately. Prerequisite for Phase 3.

- `shared/service-core/httpClient.js:8-14` — `isRetryable()` returns false for every
  4xx. Correct for internal service-to-service calls; backwards for a third-party API,
  where 429 is the one 4xx that must be retried.
- Add 429 handling that honours `Retry-After`, leaving 400/401/403/404 failing fast.
- **Acceptance**: a stubbed 429 with `Retry-After: 2` is retried after ~2s; other 4xx
  still fail on the first attempt; existing `__tests__/httpClient.test.js` stays green.

---

# Phase 1 — Tenancy, the launch gate (~5 weeks, mostly parallel)

Self-signup is what makes this non-negotiable. Eight services check only that a token is
valid, and their models carry no `projectId` at all — so every tenant would share one
global folder tree, one defect-status vocabulary, one link graph and one attachment store.

**WP-110 must land and be orchestrator-verified before WP-111…118 are dispatched.** All
eight depend on the org-scoped project list; fanning them out alongside a moving
membership contract will produce eight divergent implementations.

## WP-110 — Organization becomes the tenant

**Depends on**: Phase 0. **Blocks WP-111…118, WP-119, WP-131.** Keystone.

- `userService/models/Organization.js` has only `name` and `createdBy` — **no
  `members[]`**, which is precisely why `shared/service-core/permissions.js:18` has no
  `org_admin` role and says so.
- Add organization membership and an org-level role; then scope
  `GET /api/v1/projects` to the caller's organization.
- **Why this is the keystone**: that endpoint is deliberately unfiltered today
  (`userService/controllers/projects.js:19-26`, and `routes/projects.js:24-28` documents
  the reason) because `requireProjectScope()` in 14 services caches its full response to
  answer membership checks. So it is simultaneously the tenant-enumeration hole and a
  load-bearing internal contract. Both must be satisfied by the same change — likely an
  internal, service-token-only unfiltered view plus a caller-scoped public one.
- Backfill existing data to one default organization, additive and idempotent, dry-run
  first (GR-7).
- **Acceptance**: a user in org A receives zero of org B's projects from the list
  endpoint; `requireProjectScope()` still resolves membership on every scoped service
  (full route sweep green); the backfill is idempotent on re-run.

## WP-111 … WP-118 — Project-scope the eight unscoped services

**Depends on**: WP-110, verified. **Eight independent packages — parallel dispatch.**

Priority order (highest value first, because Phase 3 and WP-119 depend on the first two):

| WP | Service | Note |
|---|---|---|
| WP-111 | `linkIssueService` | Traceability graph; blocks WP-119 and WP-141 |
| WP-112 | `uploadService` | Attachments; blocks WP-135. **Must not** call `applyStandardSecurity()` |
| WP-113 | `folderService` | |
| WP-114 | `moduleService` | |
| WP-115 | `commentsService` | Keep the local `advancedResults` deviation |
| WP-116 | `statusService` | Defect status vocabulary, currently global |
| WP-117 | `automationService` | |
| WP-118 | `objectRepo` | Blocks any future generated automation pack |

Each package is the same five steps:

- Add `projectId` to the model with an index (additive, GR-7).
- Write an idempotent backfill with a dry-run mode, taking a verified backup first.
- Mount `requireProjectScope()` then `authorize()` on every route, in that order, after
  `keycloak.protect()`.
- Filter every controller query on `req.projectScope.projectId` — never a client-supplied
  value.
- Add a `__tests__/tenantIsolation.test.js` suite. Six existing suites are the template
  (`defectService`, `fieldsService`, `releaseService`, `requirementService`,
  `testPlanExecutionService`, `testRepoService`).
- **Acceptance (release-blocking, per WP-021's precedent)**: the isolation suite proves a
  member of project A cannot read, list, update or delete project B's documents through
  **any** route. The suite cleans up after itself — the WP-021 suites did not and left 13
  orphaned fixtures behind.

## WP-119 — Audit the two things auditors actually ask about

**Depends on**: WP-110, WP-111.

- `audit()` exists in `shared/service-core/audit.js` and is called from 11 controllers
  across 6 services — **none of them userService**. Adding a project member is currently
  not an audit event.
- Add calls for member add, member remove, role change and project archive in
  `userService/controllers/projects.js`; and for link create and link delete in
  `linkIssueService/controllers/linkIssue.js`.
- Remove the `{ projectId: { $exists: false } }` clause from
  `commentsService/controllers/audit.js:50`. It was a reasoned accommodation for a service
  that was unscoped at the time and is now scoped; it currently returns other tenants'
  events to any project member, including viewers.
- **Acceptance**: granting admin produces a queryable event naming actor, target and role;
  the audit API returns only the caller's own project's events, proven with a second
  project.

## WP-120 — Index every tenant filter

**Depends on**: WP-111…118.

- Index every newly added `projectId`. Also index five pre-existing models that carry the
  field with no index: `commentsService/models/Comments.js`,
  `fieldsService/models/field.js`, `folderService/models/Folder.js`,
  `statusService/models/IssueStatus.js`, `userService/models/Project.js`.
- **Acceptance**: `explain()` on each service's list route shows an index scan.

---

# Phase 2 — Self-serve onboarding (~3 weeks)

For a self-serve product this **is** the launch, not polish afterwards. WP-130 and WP-133
decide whether anyone who signs up comes back.

## WP-130 — Email, the capability the codebase has none of

**Depends on**: owner-provided SMTP credentials and verified sending domain.
**Blocks WP-132, WP-136.**

- There is no mail transport anywhere. The `SMTP_*` variables in three `config.env` files
  are retired scaffolding from the deleted legacy auth system —
  `userService/config/config.env.example:6-10` says so.
- Configure SMTP in the Keycloak realm; enable email verification, password reset, the
  built-in Terms and Conditions required action, then enable registration.
- **Acceptance**: a real signup receives verification mail, cannot log in before
  verifying, must accept terms, and can complete a password reset. SPF, DKIM and DMARC all
  pass.

## WP-131 — Auto-provision an organization on first login

**Depends on**: WP-110, WP-130.

- The bootstrap already mostly works: `createProject` makes the creator sole admin and
  ignores client-supplied `members` (WP-022 closed that hole), and
  `frontend/src/Pages/projects.tsx:218` has a real empty state. What is missing is the
  organization — a verified user with no membership gets 403 from every scoped service.
- **Acceptance**: a brand-new verified account reaches a usable workspace with no manual
  steps and no 403s.

## WP-132 — Invite teammates by email

**Depends on**: WP-130, WP-131.

- Today an admin adds a colleague by pasting a raw Keycloak `sub` UUID into a free-text
  "User id" field — `frontend/src/Components/settings/ProjectMembersPanel.tsx:176`.
- Build an invite model (token, email, role, expiry), the invite mail,
  accept-on-first-login, and replace that text field with a picker over the existing
  `/api/v1/users/kcUsers` endpoint for people already in the org.
- **Acceptance**: an admin invites an address that has never signed up; the recipient
  registers, accepts, and lands in the project with the intended role. Expired and
  already-used tokens are rejected.

## WP-133 — Sample project seeder

**Depends on**: owner-provided content. **Highest conversion impact in this phase.**

- A fresh tenant has zero requirements, cases and links, so coverage, the traceability
  matrix, the release lens and the dashboard all render empty — the entire differentiator
  is blank on day one.
- Seed a realistic project: six to eight requirements, linked test cases, a shared step, a
  dataset, one executed run with mixed results, and a defect linked to both a case and a
  requirement so the matrix shows real segments.
- **Acceptance**: one click from the empty state produces a project where coverage,
  traceability and release-readiness all render non-trivially. Content reviewed by a human
  for plausibility — this is every evaluator's first impression.

## WP-134 — Tenant record with a plan field and usage counters

**Depends on**: WP-110, and owner-provided tier numbers.

- No plan or subscription model exists anywhere in the codebase. Add `plan` plus counters
  for the two chosen meters: automated tests under management, and retention window.
- **Acceptance**: every organization has a plan and live usage counters visible to its
  admin. No payment integration in scope.

## WP-135 — Abuse and cost controls

**Depends on**: WP-112, and owner-provided caps.

- `uploadService` has no file size limit and no MIME validation — self-signup turns that
  into free file hosting. Add per-file cap, per-tenant total, and a type allow-list.
- Rate limit the registration endpoint.
- Generalise the Redis `INCR`+`EXPIRE` counter in `aiService/lib/rateLimiter.js` into a
  per-tenant quota helper. It already fails open on a Redis blip, which is the right
  posture for a cost cap (contrast `requireProjectScope()`, which fails closed).
- **Acceptance**: an oversized upload and a disallowed type are rejected with actionable
  messages; a tenant at quota gets a clear 429; a Redis outage does not take the product
  down.

## WP-136 — Account lifecycle and the sole-admin problem

**Depends on**: WP-130, and an owner policy decision.

- There is no user-delete path, and projects are soft-delete only. Build account deletion
  covering both the Keycloak identity and the user's data.
- Implement the owner's chosen policy for a project whose only admin leaves. Note WP-022
  already added an ownerless-project recovery path — read it first (GR-1).
- **Acceptance**: a documented deletion request completes end to end; no project can be
  left with zero admins and no recovery path.

---

# Phase 3 — Jira, link-only v1 (~3 weeks)

Jira Cloud, API-token auth, linking to existing issues. Roughly 80% of the value at 30% of
the work: no Atlassian app, no OAuth flow, no webhook receiver. Issue creation is WP-145
and deliberately out of v1; status sync is out entirely.

## WP-137 — The signup form collects no password

**Depends on**: WP-130. **Found 2026-10-20 by completing a real signup end to end.**

Self-serve signup IS built and reachable — `keycloak-themes/themes/kdk/login/login.ftl`
lines 63-69 render "No account? **Register**" whenever `realm.registrationAllowed` is
true, which WP-130 turned on. It is a *flat* accent text button below the login form,
which is why it is easy to miss, and it did not exist before WP-130.

But the form it leads to collects **username, email, firstName, lastName and nothing
else**. Verified by submitting it: the POST returns 302 and creates an account that is
`enabled: true` with **zero credentials** and
`requiredActions: ['TERMS_AND_CONDITIONS', 'UPDATE_PASSWORD']`.

Keycloak is behaving coherently — with no password collected it forces one at first login
— but the consequence is that **the entire signup funnel now depends on email delivery**,
and email currently lands in spam (WP-130's unresolved SPF/DKIM clause). A new user signs
up, cannot log in, and waits for a verification message they will not see. The two
problems compound rather than being independent.

**Root cause — CORRECTED 2026-10-20 during implementation. The paragraph below replaces
an earlier hypothesis that was measured and found wrong.**

The original hypothesis was: "the `kdk` theme declares `parent=base` and ships no
`register.ftl`, so registration inherits the base theme's minimal template... this is a
template gap, not a flow misconfiguration." That is **wrong**, and it would have been a
dead end: base's `register.ftl` *does* render password fields. They are guarded by
`<#if passwordRequired??>`, and that variable was absent from the template context —
measured by rendering `${(passwordRequired!"ABSENT")?string}` into the live page.

The real cause is a **flow configuration** after all: the `registration-password-action`
authenticator has an option `always_set_password_on_register_form`, whose own help text
reads — *"When this option is false and 'Verify Email' is enabled for the realm, then the
password will not be set by the user on the registration form, but rather in the later
stage once user's email address is successfully verified. This is recommended for security
reasons. [...] This option is deprecated and might be removed in the future."* It
defaults to false and had no config object at all, and WP-130 turned `verifyEmail` on. So
the zero-credential account was **Keycloak doing exactly what it was configured to do**,
not a bug and not a template gap.

Two consequences for this WP:

- The missing `register.ftl` is real but explains only the *unstyled* page, not the
  missing password. Both still need fixing; they are independent faults.
- Collecting the password on the form means **overriding a setting Keycloak explicitly
  counter-recommends, via an option it has deprecated**. Worth doing — the deferred-password
  flow makes the whole funnel hostage to email delivery, which is this stack's weakest
  link — but the trade must be recorded: a credential can then exist on an address the
  registrant has not proven they own. `verifyEmail` stays on, so such an account still
  cannot authenticate. The durable fix for the underlying problem is email deliverability
  (SPF/DKIM, WP-130's open clause), not this flag; and if a future Keycloak drops the
  option, signup silently reverts to the `UPDATE_PASSWORD` detour — degraded, not broken.

- Add a `register.ftl` to the `kdk` theme that collects a password and confirmation, in the
  same Quasar components the login page uses. The signup page currently renders plain
  `<input class="">` against a login page built from `q-input`/`q-btn` — **the single most
  important page in a self-serve funnel is the least finished one.**
- Decide whether terms acceptance belongs **on** the form rather than as a post-registration
  required action. It is currently a realm default action, so it appears after signup, and
  there is no terms text written yet (WP-155).
- Keep `VERIFY_EMAIL`: a self-serve product must not take an unverified address. But note
  that until a sender domain exists, verification is the funnel's single point of failure.
- **Acceptance**: a new user completes signup in one form including a password, and can log
  in immediately after verifying their email — no `UPDATE_PASSWORD` detour. The signup page
  is visually consistent with the login page. An account is never created with zero
  credentials.

## WP-138 — Sign up and sign in with Google

**Depends on**: WP-137. **Proposed 2026-10-20.**

Google is the one signup path that **needs no verification email at all** —
`emailVerified` arrives from the identity provider. That matters more than the
usual convenience argument, because the funnel's current single point of failure
is mail delivery: there is no sender domain yet, so verification mail lands in
spam (WP-130's open SPF/DKIM clause). Google login takes a stranger to a
logged-in workspace today, without a working mail pipeline.

It also **reverses WP-137's trade-off rather than compounding it.** WP-137 gave
up "a credential only ever exists on a proven address" in order to escape the
email dependency. Google gives a proven address with *no* credential and *no*
mail — a cleaner answer to the same problem. Worth revisiting WP-137's
deprecated flag once this ships: Google users would sign up instantly, and
email+password users could go back to Keycloak's recommended deferred-password
flow by the time mail works.

### Most of the UI already exists — verify before rebuilding it

`keycloak-themes/themes/kdk/login/login.ftl:75-96` already renders
`social.providers` as Quasar `q-btn`s, including a comment recording the
Keycloak 25→26 trap where `social.providers` is *defined but empty* and the old
`??` test rendered "Or sign in with" above nothing. **Do not rewrite this.**

The gap: `template.ftl:81-82` invokes `<#nested "socialProviders">` on *every*
page, but `register.ftl` (added by WP-137) has no such branch — so the buttons
appear on sign-**in** only, which is backwards for the problem being solved.

### The configuration is the whole WP, and two settings interact

- **`trustEmail=true` on the Google provider is REQUIRED, not optional.** The
  realm has `verifyEmail: true`, so without it a brokered Google user is still
  handed VERIFY_EMAIL, sends mail into spam, and the feature delivers nothing.
  Verified against `OIDCIdentityProvider`: `isTrustEmail` feeds
  `setEmailVerified(UserModel, BrokeredIdentityContext)`.
- **`trustEmail` carries no account-linking risk**, contrary to the obvious
  worry. Verified by searching the compiled 26.7.3 `keycloak-services` jar:
  `isTrustEmail` is referenced by exactly two classes, `OIDCIdentityProvider`
  and `AbstractTokenExchangeProvider` — **none of the broker linking
  authenticators consult it.** Linking is governed solely by the
  `first broker login` flow.
- **The linking risk is real and lives in that flow.** Its default shape is
  `Handle Existing Account` → `Confirm link existing account` →
  `Account verification options` → *Verify existing account by Email* **or**
  *Verify Existing Account by Re-authentication*, both `ALTERNATIVE`.

### Why the email-linking branch must be disabled

Two independent reasons, which is what makes it the right call rather than a
workaround:

1. **It reintroduces the exact dependency this WP exists to escape.** Someone
   who already signed up with a password, then clicks Sign in with Google, is
   offered linking — and the email branch sends mail into spam. Stuck.
   Re-authentication (prove the existing account by its password) needs no mail.
2. **It closes the account pre-hijacking path WP-137 opened.** WP-137 allows a
   password credential on an *unverified* address. So: an attacker registers
   `alice@gmail.com` with a password (cannot log in — `verifyEmail` holds); real
   Alice later signs in with Google. On the **email** branch Alice receives a
   link at her own address, links, and lands in an account the attacker holds a
   password for — a takeover. On the **re-auth** branch she is asked for the
   attacker's password, cannot supply it, and no link happens.

**Residual risk, accepted and recorded**: that re-auth branch turns the attack
into a denial of service — a squatter can block the real owner of an address
from signing up with Google. Strictly better than a takeover, and it is a
consequence of WP-137's flag, not of this WP. It disappears if WP-137 is
reverted once mail works.

### Scope

- Add the `socialProviders` branch to `register.ftl`, matching `login.ftl`.
- Register the Google provider idempotently in
  `scripts/configure-keycloak-email.js` — the only durable record of realm
  config, since `keycloak-export.sh` writes to a gitignored directory because
  exports embed signing keys and password hashes. Credentials from
  `backend/.env` (GR-9), placeholders in `.env.example`, never committed.
  Skip cleanly, saying so, when they are absent.
- Set `trustEmail=true`, and disable *Verify existing account by Email* in the
  `first broker login` flow.
- Tests: the flow-hardening assertions need **no Google credentials** and must
  run unconditionally; the provider assertions skip loudly without them.

### What only the owner can do

A Google Cloud OAuth **Web application** client, with authorized redirect URI
`{keycloak}/realms/srckube/broker/google/endpoint` — `http://localhost:8080/...`
works for local development, so the flow can be built and proven before the
domain exists. Scopes stay `openid email profile`, which are non-sensitive and
need no Google verification review.

### Deliberately out of scope

Generic **OIDC/SAML against a customer's own directory** (Okta/Entra/AD) is the
integration that actually unblocks enterprise deals for a self-hosted tool;
Google consumer accounts unblock the *self-serve trial funnel and the first
users*. Same Keycloak broker machinery, so doing Google first is the cheap way
to learn the flow. Filed separately when there is a customer asking.

- **Acceptance**: with a Google client configured, a user with no prior account
  reaches a usable workspace via "Sign up with Google" — `emailVerified: true`,
  **no verification mail sent**, no `UPDATE_PASSWORD`, no `VERIFY_EMAIL`. The
  buttons appear on the signup page as well as the login page. A Google sign-in
  whose email matches an existing local account is **never** linked on the
  strength of the email alone.


## WP-140 — Encrypted credential storage in service-core

**Depends on**: Phase 0.

- There is no encryption-at-rest helper anywhere in the shared library. Jira tokens must
  not sit in plaintext Mongo. Env-provided key per GR-9, encrypt/decrypt helpers, and a
  documented rotation path. Reusable for every future integration.
- **Acceptance**: a stored credential is unreadable in a `mongodump`; key rotation is
  documented and exercised once.

## WP-141 — An external-issue link type

**Depends on**: WP-111 (hard). Without `projectId` on `linkIssue`, external links are
shared across every tenant.

- The link module vocabulary is a closed numeric set — 1 test case, 2 requirement,
  5 defect, 6 release (`reportingService/services/traceability.js:36`). A Jira issue is
  none of them. Add an external type carrying provider, issue key, and a cached
  summary/status.
- `linkIssueService/models/linkIssue.js` also has a unique index on
  `{sourceId, destinationId}` — confirm an external key does not collide with it.
- **Acceptance**: an external link round-trips, appears on the linked entity, and is
  invisible from another tenant.

## WP-142 — Jira connection settings and validation

**Depends on**: WP-140, and an owner-provided Jira Cloud instance.

- Per-project settings: base URL, account email, API token, target project keys. A
  validate-connection action that actually calls Jira and reports what it found rather
  than saving blind.
- **Acceptance**: a wrong token, a wrong base URL, and a project key the account cannot
  see each produce a distinct actionable error before anything is saved.

## WP-143 — Map users to Jira accounts

**Depends on**: WP-142.

- Jira Cloud identifies people by `accountId`, not email. Your `assignedTo` is a Keycloak
  `sub`. Store a per-user mapping. This is the most commonly underestimated part of any
  Jira integration, which is why it has its own package.
- **Acceptance**: a defect's assignee resolves to the right Jira person; an unmapped user
  degrades to unassigned with a visible warning, never an error.

## WP-144 — Link an existing Jira issue to a defect, requirement or test case

**Depends on**: WP-141, WP-142, WP-143, WP-105.

- Search or paste an issue key; link it; render key plus live summary, status and
  assignee. Cache display fields with a short TTL, reusing the materialised-cache and
  `stale` / `staleReason` conventions from `reportingService/controllers/reports.js`.
- Surface external links in the traceability matrix so the chain reaches into Jira.
- **Acceptance**: a linked issue renders current status; Jira unreachable shows the cached
  value labelled stale, never a broken row.

## WP-145 — Create a Jira issue from a defect (v1.5, optional)

**Depends on**: WP-144.

- Drive the form from `GET /rest/api/3/issue/createmeta`. Jira projects can mandate
  arbitrary custom fields on create, so a hardcoded `Bug` payload fails on most real
  instances. Status is a workflow transition, not a field — it cannot be set on create.
- **Acceptance**: creation succeeds against a Jira project with two mandatory custom
  fields, discovered rather than hand-configured.

---

# Phase 4 — Infrastructure and launch (~2 weeks, threaded through 2 and 3)

## WP-150 — Traefik, TLS, real domain

**Depends on**: WP-100, WP-101, and an owner-provided domain.

- Traefik in front with Let's Encrypt. Keycloak behind the proxy (`KC_HOSTNAME`,
  `KC_PROXY_HEADERS=xforwarded`) on 443 under a subdomain — **not** the `:3443` in
  `frontend/.env.production`, which corporate firewalls block and which will fail the
  first enterprise demo from inside a customer network.
- Kong's CORS `origins` is hardcoded to `http://localhost:3000`
  (`srckube-kong/kong.yml`, WP-063 block) and must become the real origin. This is the
  first thing that breaks otherwise — every `/api/v1/*` call fails preflight.
- **Acceptance**: a real browser completes login and a full API round trip over HTTPS on
  the new domain, no mixed content, no preflight failures.

## WP-151 — One-command setup

**Depends on**: WP-100. High leverage.

- Commit a sanitised realm export — no users, no client secret — and import it on first
  Keycloak boot, generating the client secret into `.env`. Today a fresh clone cannot
  boot: the only realm exports live under gitignored `/backups/`
  (`.gitignore:7`), and `README.md:44-92` describes two to three days of manual console
  work. `scripts/keycloak-import.sh` exists with nothing to import.
- **Acceptance**: a clean clone on a machine that has never run this stack reaches a
  working login with one command and no admin-console clicks.

## WP-152 — Offsite backups and a restore drill

**Depends on**: owner-provided bucket.

- `scripts/mongo-backup.sh` and `scripts/keycloak-export.sh` exist and
  `docs/backup-restore-runbook.md` / `docs/keycloak-backup-restore-runbook.md` are good.
  What is missing is a destination, a schedule, and a restore actually performed on the
  production host.
- **Acceptance**: a scheduled backup lands offsite and a restore into a throwaway target
  is performed and recorded **before** launch.

## WP-153 — Monitoring, error tracking, logs

**Depends on**: owner-provided accounts.

- All 18 services expose `/healthz` (a real Mongo/Redis ping, not a liveness stub, per
  `shared/service-core/health.js`) and `/metrics`. Nothing consumes either.
- Add uptime checks, an error tracker, and log aggregation. `docker compose logs` across
  18 containers stops working in week one.
- **Acceptance**: killing one service produces an alert within a minute; a frontend error
  reaches the tracker with a stack trace.

## WP-154 — Make CI mean something

**Depends on**: nothing.

- **Superseded by the move to GitHub (2026-11-09): `.gitlab-ci.yml` was removed and no
  CI runs at all today.** It had run a syntax check, a require check, the 19
  `service-core` unit suites and a frontend build; the 109 frontend suites (895 tests)
  never ran. A GitHub Actions equivalent is still to be written, and should cover the
  frontend suites the old pipeline skipped.
- Measured 2026-09-26: `service-core` 19/19 suites, 172 tests green in 5.7s. Frontend full
  run failed **12 tests across 7 suites** — every one passing in isolation, all five-second
  Jest timeouts under parallel load, with the failing set changing between runs.
- Raise the Jest timeout, add a `frontend-tests` job, keep it green.
- **Acceptance**: `CI=true npm test` green three consecutive times on a cold machine, and
  the job gates merges.

## WP-155 — Brand, legal, and a top-level error boundary

**Depends on**: owner-provided brand and legal copy.

- New name, logo (`frontend/src/logo.svg`), privacy policy, terms, data-location
  statement, support address.
- Only the workbench has error boundaries — `frontend/src/workbench/RegionErrorBoundary.tsx`
  wraps three regions. A throw in the dashboard, settings or projects pages white-screens
  the app. Add one at the root.
- **Acceptance**: a deliberate throw on each top-level route renders a recoverable error
  state, not a blank page.

## WP-156 — AI off by default, time-boxed on request

**Depends on**: nothing. Nearly free.

- `aiService/models/AiProjectSettings.js:28` has `enabled: { type: Boolean, default: true }`
  and `middleware/checkProjectEnabled.js` is already mounted on every AI route. Flip the
  default to `false` and add an `enabledUntil` date the middleware honours.
- **Acceptance**: AI routes return a clear feature-disabled response by default, work for a
  project inside its window, and stop automatically when it expires.

---

# Phase 5 — After launch: the CLI and MCP wedge (~5 weeks)

Not in launch scope. Listed so it is not lost, and because it is the cheapest
differentiation available: it is what makes the traceability story true for automated tests
rather than only for runs a human clicked through.

- **CLI v1** — discover the report file, bind results to real `TestCaseId`s via a
  `srckube.yml` map or a `@TC-nnnn` tag in the test name, POST to the existing
  `/api/v1/testexecution/ingest`. Today `adapters/junitAdapter.js:70-90` namespaces every
  JUnit result as `TAG:<classname>.<name>`, and `reportingService/services/coverage.js:270`
  drops any execution row whose `TestCaseId` is not in the project's real case set — so
  **every CI result is currently invisible to every report.**
- **MCP context server** over the resolvers that already exist: `?expand=steps`
  (`testRepoService/utils/expandSteps.js`, whose own header names AI as an intended
  consumer), `?substitute=<row>`, `GET /:id/parameters`, `GET /:id/versions`.
- **`TestCase.automation`** subdocument — `{framework, path, generatedFromVersion,
  generatedAt}` — stamped at generation time, plus a `report_generated` write-back.
- **Spec-drift detection** — `models/TestCaseVersion.js` is append-only and currently read
  by exactly one GET route. Comparing the stamped version against current tells a user
  their script was generated from v7 of a spec now at v9. Nothing else on the market can do
  this, because nothing else owns the spec, its history and the results.

Consider promoting this ahead of Phase 3 if early signups ask for CI integration before
Jira.

---

# Phase 6 — AI that a chat window cannot copy (~4 weeks, post-launch)

Not in launch scope. Added 2026-10-20 after the owner's observation that test case
generation "can be achieved even without our tool" — which is correct, and worth stating
precisely rather than softening.

**The diagnosis.** `aiService` has twelve routes (`/generate-testcases`,
`/lint-requirement`, `/check-duplicate-testcase`, `/audit-duplicates`,
`/summarize-report`, `/complete`, `/structured`, and the rest). Measured: the only data any
of them can reach is **requirements and test cases**, both as text. It never sees execution
history, defect linkage, or the coverage graph. So of the eight data sources this product
owns, its AI reads two — which is exactly why the output reduces to what a user could get
by pasting a requirement into a browser.

The moat is not the model or the prompt. **It is the data the AI currently cannot see**: which
case caught which defect, which requirement broke last release, what this team's own cases
look like. That is the same argument Phase 5 makes for spec-drift detection — nothing else
on the market owns the spec, its history and the results — applied to AI.

**Positioning.** Stop selling "AI test case generation". Generation is table stakes and
commoditising monthly. Sell **coverage analysis**: it knows what to test because it has seen
what broke. WP-161 is the demo that makes that claim true.

**On vector databases, so the question is settled before someone buys one.** Measured
2026-10-20: the `redis:alpine` image in `backend/docker-compose.yml` is Redis **8.10.1**
with the `search` (RediSearch) and `vectorset` modules **already loaded** — so there is
nothing to procure. There is also nothing to use yet. Similarity search here is always
project-scoped (Phase 1), so a query's candidate set is one project's cases: ~400 at the
20 000-case target, 142 in total today. Brute-force cosine over that is microseconds. HNSW
indexes earn their keep above roughly 100 000 vectors per filtered set. Reach for one when
a single project passes ~50 000 cases, which may be never.

Note also that this Redis is **not durable** — `appendonly no` and no volume mounted — so
anything stored there is lost on restart. Embeddings belong in Mongo next to `projectId`,
inside the tenancy model Phase 1 established, not in a shared unscoped cache.

**On local models, since the question follows directly.** Embeddings should run locally by
default (WP-163); generation should not. The asymmetry is the point: useful embedding models
are 23–275 MB and CPU-viable at 1–5 ms, their output is a vector nobody reads, and a weaker
one degrades *gracefully* into slightly worse ranking. Useful generation models are 7B+,
need a GPU to be usable, and a weaker one produces test cases a tester rejects — visible,
credibility-destroying degradation. Generation stays hosted but portable: `AI_PROVIDER`
with an OpenAI-compatible base URL already covers OpenAI, OpenRouter, OpenCode Go, Ollama
and vLLM, and GR-8's server-side output validation (`controllers/ai.js:427`, "never trust
the model's output shape") means a weaker model fails *cleanly* rather than writing
corrupted cases. One known coupling to re-check when swapping: `completeStructured` sends
`response_format: { type: 'json_object' }`, an OpenAI-ism some gateways ignore.

## WP-160 — Let the AI service see the coverage graph

**Depends on**: WP-119, WP-120. **Prerequisite for WP-161 and WP-164.**

- `aiService` currently calls `requirementService` and `testRepoService` only. Add scoped,
  read-only access to the three sources it is blind to: `linkIssueService` (the
  requirement↔case↔defect graph), `testPlanExecutionService` (execution history and
  `TestStatus`), and `defectService`.
- Forward the caller's own token and `X-Project-Id` on every hop, as
  `linkIssueService/controllers/linkIssue.js` already does for its coverage endpoints. The
  AI service must gain **no** authority the caller does not have — a context-gathering
  feature that reads across tenants is the worst possible place to widen scope.
- One `buildProjectContext(projectId, { requirementId? })` helper, so every later WP draws
  context the same way rather than each assembling its own fan-out.
- Cache per request, not globally: a single generate call must not issue the same coverage
  fan-out four times.
- **Acceptance**: the context helper returns a requirement, its linked cases, each case's
  last execution status, and defects linked to either — for a project the caller belongs
  to, and `403` for one they do not. Proven by a tenant-isolation suite in the WP-111
  pattern.

## WP-161 — Coverage gap analysis (the wedge)

**Depends on**: WP-160. **No new infrastructure. Build this one first.**

- Not generation. Given a requirement and the cases already linked to it, report what is
  **missing**: untested boundaries, unstated equivalence classes, clauses with no case at
  all, and negative cases absent where a positive one exists.
- Worked example from the seeded sample project (WP-133): REQ *"enforce daily transfer
  limits by account tier"* has cases at £999 and £10 000.01 and none at exactly £10 000,
  and nothing for the rolling-24-hour clause. That sentence is the product.
- Each finding cites the requirement clause it came from and the cases it checked, so a
  user can disagree with it. An unexplained finding is indistinguishable from a
  hallucination.
- Findings are advisory and persist nothing, per GR-8 — the same posture
  `/lint-requirement` already takes. Acting on one creates a real case through
  `testRepoService`'s normal API.
- **Acceptance**: on a requirement with a deliberately omitted boundary case, the gap is
  named, the clause is quoted, and the existing cases it checked are listed. On a
  thoroughly covered requirement it reports no gaps rather than inventing some — tested
  with a fixture built to be complete.

## WP-162 — Deduplicate at generation time

**Depends on**: nothing. **Cheapest differentiator in this phase.**

- Duplicate detection already exists (`/check-duplicate-testcase`, `/audit-duplicates`) but
  sits behind a separate button. Run it **inside** generation and suppress near-duplicates
  before the user sees them: *"generated 8, suppressed 3 as near-duplicates of TC-4471,
  TC-5120."*
- Keep the suppressed candidates in the response, marked, so a user can override. Silently
  dropping output a user asked for is worse than showing it.
- Note the current scorer is Jaccard token overlap (`aiService/lib/duplicateDetection.js`),
  which misses "sign in" versus "authenticate". That is acceptable here and is what WP-163
  improves; do not block this WP on it.
- **Acceptance**: generating against a requirement that already has cases returns no
  near-duplicate as a fresh suggestion, names what each was suppressed against, and still
  lets the user accept one deliberately.

## WP-163 — Ground generation in the project's own corpus

**Depends on**: WP-162. **Local-first: no owner decision needed to start.**

- Retrieve the project's most similar existing cases, shared steps and datasets, and put
  them in the prompt. Output then matches house phrasing and **reuses the existing
  "sign in and complete two-factor authentication" shared step** instead of re-describing
  login as step 1 of every case.
- Embeddings stored as a `Buffer` on the test case next to `projectId`; cosine computed
  in-process over the project's own vectors. No vector index — see this phase's header for
  the arithmetic.
- Re-embed on text change. **This is where these systems rot**: a stale vector degrades
  retrieval silently, with no error anywhere. Treat invalidation as the feature, not an
  afterthought.
- **DEFAULT TO A LOCAL MODEL**, behind a provider interface in the shape
  `aiService/providers/index.js` already uses for chat (`AI_PROVIDER` selecting between
  `mock` and `openai`). `@xenova/transformers` runs `all-MiniLM-L6-v2` (~23 MB, 384 dims)
  or `bge-small-en-v1.5` as ONNX **in the Node process** — no Python, no GPU, no new
  container, ~1–5 ms per short text. The whole corpus re-embeds in about a minute at the
  20 000-case target.
- Local is the right default here for four reasons that do not apply to generation: no
  per-call cost, so re-embedding on a model change stops mattering; no customer test-case
  text leaves the deployment, which matters for a self-hosted product whose cases describe
  the customer's internals; no infrastructure for WP-150 to inherit; and the quality gap
  between a small local embedder and a hosted one is modest for short-text retrieval
  within one project, and degrades *gracefully* — slightly worse ranking that nobody sees,
  rather than visibly worse prose that a tester rejects.
- **THE LOCK-IN IS THE STORED VECTORS, NOT THE PROVIDER.** Vectors from model A are
  mathematically meaningless against model B's: different dimensionality, different space.
  Switching models means re-embedding the corpus, and any comparison that mixes two models
  returns plausible-looking garbage rather than an error. Four rules, all of them
  acceptance criteria rather than advice:
  1. store `{ model, dim, vector }` per embedding, never a bare array, so a mismatch is
     detectable;
  2. **never compare across model ids** — every query filters on the active model. This is
     the rule that prevents the silent-garbage failure;
  3. store the vector as a `Buffer` with `dim` recorded, so moving from 384 to 1536
     dimensions is not a schema migration;
  4. make re-embedding a first-class, resumable operation from the start — not a script
     written in a panic. This is where these systems rot: a stale vector degrades
     retrieval silently, with no error anywhere.
- **Acceptance**: a generated case for a project whose suite uses a shared step references
  that shared step by id rather than restating it; a vector stored under one model is never
  compared against another, proven by a test that plants a foreign-model vector and asserts
  it is excluded rather than ranked; re-embedding is resumable and idempotent; and with
  embeddings unavailable the feature degrades to WP-162 behaviour with a visible notice,
  never an error.

## WP-164 — Risk-based test selection for a release

**Depends on**: WP-160, WP-141, WP-142. **The actual moat. Needs accumulated data to convince.**

- Answer the question a chat window structurally cannot: *"of your 20 000 cases, which 400
  matter for this release?"* Rank by requirements changed since the last release
  (`RequirementVersion` is append-only and already carries the history), cases with a
  history of catching defects, areas with open defects — including Jira ones now that
  WP-142 exists — and coverage gaps from WP-161.
- Output a saved selection a user can run, not a report they read. It must flow into
  `testplan`/`testexecution`, or it is a slide rather than a feature.
- Explain each inclusion in one line. "Because the model said so" is unusable for the
  release-gate conversation this is meant to support.
- **THE RANKING MUST NOT DEPEND ON THE LLM.** Scoring is arithmetic over data this product
  owns — requirement recency from `RequirementVersion`, defect-catch history from
  executions, open-defect proximity from the link graph. An LLM writes the one-line
  explanations and nothing else. This is deliberate: it is the one feature competitors
  cannot copy, so a model swap, a provider outage or a cheaper model must not be able to
  degrade it. If the LLM is unavailable the selection still ranks correctly and the
  explanations fall back to a templated sentence.
- Honest limitation to design for: on a new project there is no history, so this degrades
  to WP-161's gap analysis plus requirement recency. Say so in the UI rather than ranking
  arbitrarily and looking confident.
- **Acceptance**: on the seeded sample project a selection is produced, every entry
  carries a reason, and the case linked to the known open defect ranks above a case that
  has passed unchanged for the whole history.

## WP-165 — AI as a metered, paid capability

**Depends on**: WP-134, WP-156.

- The plumbing exists: WP-156 made AI off by default and time-boxed, and
  `service-core/quota.js` meters cost units per tenant with an explicit failure posture.
  What is missing is the tier wiring and the visibility.
- Expose usage to an org admin — consumed, remaining, when the window resets — reading
  through the quota helper's `peek()`. A cost cap nobody can see is a support ticket
  waiting to happen.
- Decide and record what AI costs against the plan's two chosen meters, and whether gap
  analysis (cheap, high value) is priced differently from generation (expensive, lower
  value). That asymmetry is a pricing opportunity, not an accident.
- **Acceptance**: an org admin sees current AI usage against their tier; a tenant at quota
  gets a clear 429 naming when it resets; a Redis outage does not disable AI, per the
  fail-open posture `quota.js` requires the caller to choose explicitly.

**Sequencing.** WP-162 then WP-161 first: together they are about ten days and change what
the feature *is* without touching infrastructure or needing anything from the owner. WP-160
is a prerequisite for WP-161 and should land with it. WP-163 waits on the embeddings
decision. WP-164 is the one worth waiting for — it improves the longer real execution data
accumulates, so delaying it past launch genuinely helps.

---

# What the owner must provide, and when

Weeks are relative to Phase 0 starting. **Nothing is needed to start WP-102 through
WP-105.**

| By week | Needed | Blocks |
|---|---|---|
| 0 | Two private git remotes (main + kong submodule) | WP-100 |
| 0 | Decision: does `EXECUTION_LOG.md` move? | WP-100 |
| 1 | **Decision: Organization is the tenant** | WP-110 → all of Phase 1 |
| 1 | **The brand name** (longest human lead time) | domain → email → WP-130 |
| 1 | Host provisioned; stand the stack up to measure real RAM | WP-150, WP-151 |
| 2 | Domain purchased | WP-150, and the email chain |
| 3 | SMTP provider + verified domain + SPF/DKIM/DMARC | **WP-130 → all of Phase 2** |
| 4 | Offsite backup bucket | WP-152 |
| 4 | Uptime + error tracking + log accounts | WP-153 |
| 5 | Terms and privacy copy | WP-130 (Keycloak Terms action), WP-155 |
| 5 | Free-tier numbers: tests under management, retention days, attachment caps | WP-134, WP-135 |
| 7 | Sample project content (~half a day of writing) | WP-133 |
| 8 | Free Jira Cloud instance | WP-142 → Phase 3 |
| 8 | Sole-admin departure policy | WP-136 |
| 8 | Support address + response promise | WP-155 |

**The two critical chains:**

```
name ──→ domain ──→ SMTP + verified domain ──→ WP-130 ──→ all of Phase 2
(wk 1)    (wk 2)          (wk 3)                (wk 6)

Organization-as-tenant ──→ WP-110 ──→ WP-111…118 (×8 parallel)
      (wk 1)                (wk 2)          (wks 3–6)
```

Everything else has slack. Procurement is not the bottleneck — the name and the tenant
decision are.
