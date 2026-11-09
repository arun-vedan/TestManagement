// WP-063b — a real-browser reachability precondition for the data-driven
// journeys.
//
// HISTORY (kept because it explains why this file exists at all): WP-063
// found that Kong had NO `cors` plugin configured, so every authenticated
// call the SPA makes — all of which carry a non-safelisted `Authorization`
// header and are therefore preflighted — died at OPTIONS with a bare 401 and
// no `Access-Control-*` headers. That was invisible to every other test tier
// in this repo (jsdom does not enforce CORS; the backend Jest suites are
// server-to-server), and it stopped both data journeys dead. It has since
// been FIXED: a global `cors` plugin was added to srckube-kong/kong.yml, and
// `OPTIONS /api/v1/projects` with `Origin: http://localhost:3000` now returns
// 200 with the full Access-Control-* set while no-token and bad-token GETs
// still return 401. See docs/e2e-playwright-cors-blocker.md for the writeup,
// repro commands and the verification evidence.
//
// WP-063 used this check to `test.skip()` the journeys with a precise
// reason. That was the right call while the gap was open and unfixable from
// this WP's scope — but now that it is fixed, a skip would be the wrong
// failure mode: a Kong regression would turn the suite silently green-ish
// rather than red. So this now ASSERTS. If a real browser cannot reach the
// API, that is a genuine, reportable regression and the run must fail,
// carrying this diagnostic instead of an inscrutable "element not found"
// twenty lines later.
import { Page, expect } from '@playwright/test';

export async function assertApiReachable(page: Page): Promise<void> {
  // Done from inside the page (not from Node) on purpose: only a real
  // browser applies the CORS preflight this is checking for. The request
  // carries `X-Project-Id`, which is not a CORS-safelisted request header,
  // so it is preflighted exactly like the app's own calls.
  const result = await page.evaluate(async () => {
    try {
      const resp = await fetch('http://localhost:8000/api/v1/projects', {
        headers: { 'X-Project-Id': '1' },
      });
      return { reachable: true, status: resp.status };
    } catch (err: any) {
      return { reachable: false, status: 0, error: String(err?.message || err) };
    }
  });

  expect(
    result.reachable,
    'A real-browser cross-origin call to the API failed at the network level ' +
      `(${(result as any).error}). This is the Kong CORS preflight gap described in ` +
      'docs/e2e-playwright-cors-blocker.md, which was fixed by adding a global `cors` plugin to ' +
      'srckube-kong/kong.yml — if this fires again, that plugin has regressed. Verify with: ' +
      "curl -i -X OPTIONS http://localhost:8000/api/v1/projects -H 'Origin: http://localhost:3000' " +
      "-H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization,x-project-id'"
  ).toBe(true);

  // Unauthenticated, so 401 is the CORRECT answer here — this asserts the
  // response was produced by Kong's JWT gate rather than being a CORS
  // rejection, i.e. that fixing CORS did not also loosen authentication.
  expect(
    result.status,
    'Expected the preflight-then-GET to reach Kong and be rejected by the JWT plugin (401). ' +
      'A 200 here would mean unauthenticated access to a project-scoped endpoint.'
  ).toBe(401);
}
