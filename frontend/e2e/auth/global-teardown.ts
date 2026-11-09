// WP-063 — runs once after the whole Playwright suite. Deletes the
// throwaway Keycloak user (and its project-1 membership entry) that
// global-setup.ts created, so a full E2E run leaves no residue behind —
// unlike the ~dozen leftover 'wp022-persona-*' contributor entries found
// still sitting on project 1 from earlier, unrelated backend suite runs
// (that pattern predates this WP; not this WP's mess to clean, but not
// one to add to either).
import fs from 'fs';
import path from 'path';
import { deleteE2EPersona } from './persona';

const RUNTIME_STATE_PATH = path.join(__dirname, '..', '.auth', 'persona-runtime.json');

export default async function globalTeardown() {
  if (!fs.existsSync(RUNTIME_STATE_PATH)) return;
  try {
    const { userId } = JSON.parse(fs.readFileSync(RUNTIME_STATE_PATH, 'utf-8'));
    if (userId) await deleteE2EPersona(userId);
  } finally {
    fs.rmSync(RUNTIME_STATE_PATH, { force: true });
  }
}
