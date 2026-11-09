// WP-063 feasibility probe #1 — does Playwright's own bundled/cached
// Chromium actually launch and render *anything* in this environment?
// Run: node e2e/feasibility/probe-datauri.mjs   (from frontend/)
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('data:text/html,<html><body><h1 id="x">hello playwright</h1></body></html>');
const text = await page.textContent('#x');
console.log('PAGE_TEXT:', text);
await browser.close();
console.log('FEASIBILITY: OK');
