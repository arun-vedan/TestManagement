// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// WP-046 — jest-axe's toHaveNoViolations() matcher, extended globally
// (same pattern as jest-dom above) so any test file can call
// `expect(await axe(container)).toHaveNoViolations()` without its own
// per-file setup. jest-axe ships no types of its own; @types/jest-axe
// (devDependency, pinned) supplies both the runtime API types and the
// ambient `jest.Matchers<R>.toHaveNoViolations()` augmentation this relies
// on, picked up automatically since it lives under node_modules/@types.
import { toHaveNoViolations } from 'jest-axe';
expect.extend(toHaveNoViolations);

// WP-070 — jsdom's localStorage is shared across every `it()` in a test
// file (one jsdom environment per file, not per test). Stores that persist
// to localStorage (e.g. src/workbench/store/workbenchStore.ts, keyed per
// project) would otherwise leak state from one test case into the next.
// Clearing after each test keeps test cases isolated without touching the
// stores' real persistence behaviour.
afterEach(() => {
  window.localStorage.clear();
});

// WP-154 — Jest's default per-test timeout is 5 s, and that is what CI was
// failing on: the measured failure (2026-09-26) was 12 tests across 7 suites,
// every one passing in isolation, all of them five-second timeouts under
// parallel load, with the failing set changing between runs. That is the
// signature of a timeout that is too tight for a loaded machine, not of a
// broken test.
//
// Raised here rather than per-file so no suite has to remember it, and set
// generously: a correct test that takes 12 s on a contended CI runner should
// pass, while a genuinely hung test still fails rather than hanging the job.
//
// Note this does NOT reproduce locally -- the full suite ran green three
// consecutive times on this machine while WP-154 was being done, so this is
// insurance against the documented CI failure mode, not a fix for an
// observed local one. Each test's own explicit timeout argument still wins
// over this default.
jest.setTimeout(30000);
