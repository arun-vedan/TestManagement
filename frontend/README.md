# vedan — frontend

React 18 + TypeScript single-page app for the vedan test-management platform.
Authentication is Keycloak via `keycloak-js` (`src/keycloak.js`), so an
unauthenticated visit redirects to Keycloak's own hosted login page rather than
to a form in this app.

> This file previously held a CI provider's default project template, including a
> `git remote add origin` line for an unrelated project it had been copied from.
> None of it described this app.

## Running it

```bash
npm install
npm start          # http://localhost:3000, BROWSER=none to suppress the tab
```

The dev server is `craco start` (see `craco.config.js`), not plain
`react-scripts`: the app needs Monaco, WebAssembly and a dev-overlay filter
that suppresses MUI's benign `ResizeObserver loop` warning, which otherwise
raises a full-screen overlay that intercepts clicks.

It expects the backend stack to be up — Kong on `:8000`, Keycloak on `:8080`.
See the repository root for bringing those up.

## Configuration

`.env` and `.env.development` hold only public values: the API and Keycloak
base URLs. Create React App inlines every `REACT_APP_*` variable into the
browser bundle, so **nothing secret belongs in these files.**

## Tests

```bash
npm test                      # Jest + React Testing Library
npx playwright test           # end-to-end, needs the full stack running
```

The Playwright suite drives the real Keycloak login page with a real
throwaway user; it does not stub authentication. `e2e/auth/persona.ts`
creates that user, and both the project and organisation memberships it
needs — project membership alone is not enough, because the project list is
organisation-scoped.

A suite that cannot run says so loudly and skips, rather than passing
quietly: `ai-generation.spec.ts` skips while AI is disabled for the
deployment, and reports why.
