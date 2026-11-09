#!/usr/bin/env node
'use strict';

/**
 * Require-resolution smoke check (WP-002).
 *
 * `node --check` only verifies syntax — it does NOT catch a require() of a
 * file that doesn't exist. That's exactly what let a broken defectService
 * (requiring deleted local `../utils/errorResponse`, `../middleware/async`,
 * etc.) reach the working tree undetected during WP-001.
 *
 * This script statically walks every .js file under backend/, extracts each
 * require('...')/require("...") call with a literal string argument, and
 * checks two categories of specifier without ever *executing* any service
 * code (no app.listen(), no Mongo connection, nothing that could hang or
 * need a live stack in CI):
 *
 *  1. Relative specifiers (`./foo`, `../utils/bar`) — resolved with Node's
 *     real module resolver (Module.createRequire) rooted at the requiring
 *     file's own directory. This is exactly the bug class that reached the
 *     working tree undetected in WP-001: a controller requiring a deleted
 *     local `../utils/errorResponse`.
 *  2. Workspace-internal specifiers (`@srckube/service-core`,
 *     `@srckube/test-utils`) — resolved directly against the package's real
 *     directory under backend/shared/<name> (honoring that package.json's
 *     "main" field), NOT through the requiring service's node_modules. This
 *     matters because these are `file:` dependencies (see e.g.
 *     defectService/package.json: "@srckube/service-core": "file:../shared/service-core"),
 *     and several services on this dev machine don't have `npm install` run
 *     locally (no node_modules present at all) even though they run fine in
 *     their Docker image. Resolving against the real package directory lets
 *     the check catch a genuine breakage (e.g. service-core's index.js
 *     renamed or an export dropped) without depending on install state.
 *
 * Deliberately NOT checked: third-party bare specifiers (`express`,
 * `mongoose`, ...). Whether those resolve depends entirely on whether
 * `npm install` has been run for that particular service — a concern
 * already covered by each service's Dockerfile (`npm install` at image
 * build time) and by `npm ci`/`npm install` in the CI test jobs, not by a
 * static analysis of source. Checking them here would require pre-installing
 * every one of backend's 13 services before the check could run at all,
 * which defeats the point of a cheap, no-container smoke check, and would
 * produce noisy false positives on any dev machine that hasn't `npm
 * install`-ed every service (verified: folderService, moduleService, and
 * statusService have no local node_modules on this machine today, yet all
 * three run correctly in their containers).
 *
 * Other limitations (by design, not oversight):
 *  - Only string-literal require() specifiers are checked. Dynamic requires
 *    (`require(someVar)`, `require(\`./${x}\`)`) are skipped — none exist in
 *    this codebase today (verified by inspection), but if one is added later
 *    it silently won't be checked here.
 *  - Does not catch runtime errors inside a module (only "does this path/
 *    package resolve"), and does not catch ESM import statements (this
 *    codebase is CommonJS throughout).
 *
 * Usage: node scripts/check-requires.js
 * Exit code: 0 if every require resolves, 1 otherwise (with a report).
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO_ROOT = path.resolve(__dirname, '..');
const BACKEND_ROOT = path.join(REPO_ROOT, 'backend');
const SHARED_ROOT = path.join(BACKEND_ROOT, 'shared');
const WORKSPACE_SCOPE = '@srckube/';

// Used only to invoke Node's absolute-path resolution algorithm (package.json
// "main" / index.js fallback) against backend/shared/<name> directories. The
// file itself need not exist — Module.createRequire just needs a path to
// anchor resolution.
const workspaceResolver = Module.createRequire(path.join(BACKEND_ROOT, '__check-requires-anchor__.js'));

// Directories we never want to descend into: vendored deps, VCS metadata,
// and automationFramework — a separate embedded JS project (its own
// package.json/build), already excluded from the existing backend-syntax-check
// CI job for the same reason.
const EXCLUDE_DIR_NAMES = new Set(['node_modules', 'automationFramework', '.git']);

function walk(dir, files) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return files;
  }
  for (const entry of entries) {
    if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

// Matches require('x') / require("x"), tolerant of internal escaped quotes.
const REQUIRE_RE = /\brequire\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g;

function extractRequireSpecifiers(content) {
  const specs = [];
  let match;
  REQUIRE_RE.lastIndex = 0;
  while ((match = REQUIRE_RE.exec(content)) !== null) {
    specs.push(match[2]);
  }
  return specs;
}

// Returns true if `spec` is in-scope for this check (relative path or
// workspace-internal package), false if it's a third-party bare specifier
// we deliberately skip (see header comment).
function isInScope(spec) {
  return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith(WORKSPACE_SCOPE);
}

// Resolves one in-scope specifier. Throws on failure (caller catches).
function resolveInScope(file, spec) {
  if (spec.startsWith(WORKSPACE_SCOPE)) {
    const pkgName = spec.slice(WORKSPACE_SCOPE.length);
    const pkgDir = path.join(SHARED_ROOT, pkgName);
    return workspaceResolver.resolve(pkgDir);
  }
  return Module.createRequire(file).resolve(spec);
}

function main() {
  const files = walk(BACKEND_ROOT, []);
  let specifierCount = 0;
  let skippedCount = 0;
  const errors = [];

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (err) {
      continue;
    }
    const specs = extractRequireSpecifiers(content);
    if (specs.length === 0) continue;

    for (const spec of specs) {
      if (!isInScope(spec)) {
        skippedCount++;
        continue;
      }
      specifierCount++;
      try {
        resolveInScope(file, spec);
      } catch (err) {
        errors.push({
          file: path.relative(REPO_ROOT, file),
          spec,
          message: String(err && err.message ? err.message : err).split('\n')[0]
        });
      }
    }
  }

  console.log(
    `Checked ${specifierCount} relative/workspace require() specifier(s) across ${files.length} ` +
      `.js file(s) under backend/ (${skippedCount} third-party bare specifiers skipped by design).`
  );

  if (errors.length > 0) {
    console.error(`\n${errors.length} unresolved require() specifier(s):\n`);
    for (const e of errors) {
      console.error(`  ${e.file}: require('${e.spec}') -> ${e.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('All require() specifiers resolve cleanly.');
}

main();
