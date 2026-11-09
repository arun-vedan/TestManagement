# WP-063 — Playwright browser feasibility (answered empirically, 2026-09-01)

Every prior frontend WP (WP-042, WP-044, WP-046) hit "no browser available"
and substituted jsdom. WP-046 was explicitly told not to install Playwright
for that reason. This WP's first job was to re-check that assumption, not
inherit it — Playwright manages its own browser binaries, which is a
materially different situation from "is there a system Chrome".

**Result: Playwright DOES run in this environment.** Headless Chromium
launches, navigates, and renders real pages, including the actual built
`frontend/build` output. This is a genuinely new capability for this
project — the first real-browser coverage of any frontend WP so far.

## What was checked, in order, with real output

### 1. Is there disk space / network access for `playwright install`?

```
$ df -h .
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   228Gi   172Gi    14Gi    93%    2.8M  149M    2%   /System/Volumes/Data

$ curl -sI --max-time 8 https://registry.npmjs.org/playwright
HTTP/2 200
```

14 GiB free, npm registry reachable. Not a blocker either way.

### 2. Are Chromium binaries already cached?

```
$ ls -la ~/Library/Caches/ms-playwright
drwxr-xr-x    8 arunganesha  staff   256 Apr  3 17:07 .
drwxr-xr-x    4 arunganesha  staff   128 Apr  3 17:06 .links
drwxr-xr-x    5 arunganesha  staff   160 Mar 13 03:32 chromium-1208
drwxr-xr-x    5 arunganesha  staff   160 Apr  3 17:07 chromium-1217
drwxr-xr-x    5 arunganesha  staff   160 Mar 13 03:32 chromium_headless_shell-1208
drwxr-xr-x    5 arunganesha  staff   160 Apr  3 17:07 chromium_headless_shell-1217
drwxr-xr-x    6 arunganesha  staff   192 Mar 13 03:32 ffmpeg-1011
```

Chromium revision 1217 was already present on this machine (from other,
unrelated local projects — `~/unified-test-tool`, `~/test-reporter`). That
revision corresponds to `playwright@1.59.1` (`browserVersion:
147.0.7727.15`, confirmed via that project's `playwright-core/browsers.json`).
`@playwright/test@1.59.1` was installed as a pinned devDependency of
`frontend/package.json` for exactly that reason — it uses the binary
that's already here, so **no download was even required** to prove
feasibility, though the network check above confirms a download would also
have worked if needed.

```
$ cd frontend && npx playwright install chromium
(exit 0, no output — already installed, nothing to do)
```

### 3. Does headless Chromium actually render a page?

`frontend/e2e/feasibility/probe-datauri.mjs`:

```
$ node e2e/feasibility/probe-datauri.mjs
PAGE_TEXT: hello playwright
FEASIBILITY: OK
```

### 4. Does it render the REAL built frontend, not just a synthetic page?

```
$ cd frontend/build && python3 -m http.server 4173 &
$ node ../e2e/feasibility/probe-built-frontend.mjs
STATUS: 200
TITLE: Src / Kube
BODY_HTML_LEN: 1298
FEASIBILITY_REAL: OK
```

Real page load, real title (`Src / Kube`), real DOM. Confirmed.

## The one thing that IS a genuine constraint (not a browser problem)

The checked-in `frontend/build/` directory is a **production** build (CRA
loads `.env.production` over `.env` when `NODE_ENV=production`, which
`craco build` sets):

```
$ grep -o "srckube\.com\|localhost:8000\|localhost:8080" frontend/build/main.bundle.js | sort | uniq -c
   8 srckube.com
```

It's baked with `REACT_APP_API_BASE_URL=https://srckube.com` and
`REACT_APP_KEYCLOAK_BASE_URL=https://srckube.com:3443` — i.e. it points at
a remote environment this machine cannot reach, not at the local compose
stack. `frontend/.env` (development mode) correctly points at
`http://localhost:8000` (Kong) and `http://localhost:8080` (Keycloak),
matching every service actually running here (`docker ps`: kong, keycloak,
and all 18 backend services healthy; no `frontend` container in
`backend/docker-compose.yml` — the frontend has never been containerized
in this stack).

**Decision: E2E must run against `craco start` (the dev server), not the
checked-in production build.** No dev server was already running on
:3000 (`lsof -i :3000` was empty) — the harness starts one itself
(`playwright.config.ts`'s `webServer` block, see below), which also means
a stale/incompatible server is never silently reused.

## Conclusion

Playwright is not merely theoretically possible here — it was proven,
with a real browser, against the real built app, before any journey spec
was written. The rest of this WP proceeds on the "if it works" branch:
real E2E specs, executed and watched, not speculative.
