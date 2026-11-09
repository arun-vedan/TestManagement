// WP-063 feasibility probe #2 — does Playwright load the ACTUAL built
// frontend (not just a synthetic data: URL)? Serve frontend/build with a
// throwaway static server first:
//   (cd frontend/build && python3 -m http.server 4173 &)
// then: node e2e/feasibility/probe-built-frontend.mjs
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const resp = await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 15000 });
console.log('STATUS:', resp.status());
console.log('TITLE:', await page.title());
await page.waitForTimeout(1500);
console.log('BODY_HTML_LEN:', (await page.content()).length);
await browser.close();
console.log('FEASIBILITY_REAL: OK');
