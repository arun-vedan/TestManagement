// WP-063 — Playwright E2E config.
//
// Deliberately lives at frontend/playwright.config.ts with testDir pointed
// at e2e/specs (NOT any directory named `__tests__`, and entirely outside
// src/) so this suite is invisible to both:
//   - scripts/run-api-tests.sh, which discovers suites by `find -type d
//     -name "__tests__"` and would otherwise try to `npm test` (craco
//     test / Jest) a browser-driving suite and hang the whole repo-wide
//     run — exactly the class of breakage the WP-002 job comments warn
//     about ("CI=true is mandatory ... without it craco test launches
//     Jest's INTERACTIVE WATCH MODE, which never exits").
//   - craco test itself, whose default (react-scripts/CRA) Jest config
//     sets `roots: ['<rootDir>/src']` — anything under frontend/e2e is
//     already outside that root, so `npm test` inside frontend/ never
//     even looks at these files, independent of the naming precaution.
// Run with `npx playwright test` from frontend/, or `npm run test:e2e`.
import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { STORAGE_STATE_PATH } from './e2e/auth/global-setup';

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e/specs',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // one shared logged-in persona; avoid cross-test races on the same data
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  globalSetup: require.resolve('./e2e/auth/global-setup'),
  globalTeardown: require.resolve('./e2e/auth/global-teardown'),
  outputDir: path.join(__dirname, 'e2e-results'),

  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE_PATH,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Starts the real dev server (see docs/e2e-playwright-feasibility.md for
  // why the checked-in production build can't be used: it's baked for
  // https://srckube.com, unreachable here). reuseExistingServer picks up
  // an already-running `craco start` from earlier in this project's
  // history instead of double-starting one, per WP-063's brief.
  webServer: {
    command: 'npm start',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
