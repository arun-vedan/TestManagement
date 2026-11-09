# Keyboard-only pass: "execute a test and record a result"

> **STATUS: AWAITING HUMAN PASS. NOT YET PERFORMED.**
>
> This script has **not been executed against the real running application
> in a real browser.** The environment this document was written in has no
> browser — every claim elsewhere in WP-046 about keyboard behavior is
> backed by `jsdom` + Testing Library's `userEvent`, which can drive real
> DOM focus/keyboard events and prove focus order and activation *within a
> single mounted component tree*, but cannot render, paint, lay out, or
> exercise real OS/browser focus-ring visibility, `<Tree>`'s live
> drag-and-drop machinery, or `@sinm/react-chrome-tabs`' real tab-open
> focus handling. Every step below is a **prediction** based on reading the
> source, cross-checked against what the automated suite *did* manage to
> assert (noted inline as "jsdom-verified" where applicable) — not a
> report of an observed pass. A tester must run through this personally
> against the deployed app, check each box honestly, and record failures
> as filed issues, not silently fix the checklist.

## Scope

The flow: sign in → open the Execution screen → find the test execution
you're working → pick a test case in it → enter edit mode → record a
Pass/Fail/Blocked/etc. result against each step → attach evidence if
needed → save. This exercises three of WP-046's four target-page
components in sequence (dashboard → execution screen; the defect form and
test repo list are reachable via the same nav but are separate walkthroughs
not scripted here).

**Equipment:** keyboard only. No mouse, trackpad, or touchscreen input at
any point. A screen reader (NVDA/JAWS/VoiceOver) pass is a *separate*,
not-yet-written script — this one is keyboard-operability only (WCAG
2.1.1), not full screen-reader UX.

## How to use this checklist

For each step: perform the action, compare what actually happened to
"Expected", and mark exactly one box. `PASS` = matched expectation.
`FAIL` = did not (write what actually happened in the Notes column).
`N/A` = step doesn't apply this run (e.g., no test cases exist yet in this
project — seed one first, don't mark steps N/A to avoid testing them).

| # | Action | Expected focus / result | Result | Notes |
|---|---|---|---|---|
| 1 | Load the app, sign in via Keycloak. | Focus lands somewhere sane after redirect back (not silently on `<body>` with no visible focus indicator anywhere). | ☐ PASS ☐ FAIL ☐ N/A | |
| 2 | Press `Tab` repeatedly from page load. | Focus moves through the app bar (logo/project switcher/nav) in a visible, logical order — every stop has a visible focus ring. | ☐ PASS ☐ FAIL ☐ N/A | |
| 3 | Tab to the "Test Execution" nav item, press `Enter`. | Navigates to the Execution screen (`/projects/:id/testexecution`). Focus lands somewhere reasonable on the new page (not lost to `<body>`). | ☐ PASS ☐ FAIL ☐ N/A | |
| 4 | Continue tabbing into the left-hand tree panel. | Reaches the tree toolbar first (New folder / New item, if you have write permission), then the first execution folder/row's **label**, which is a real focusable button (jsdom-verified: `folderStructure/__tests__/CustomNode.a11y.test.tsx`, `folderList/__tests__/CustomNode.a11y.test.tsx`). | ☐ PASS ☐ FAIL ☐ N/A | |
| 5 | With a droppable (folder) row focused, press `Enter`. | Folder expands, revealing its children. A visible focus ring stays on the toggle button. (jsdom-verified: toggle activates via `Enter`/`Space` independent of the label.) | ☐ PASS ☐ FAIL ☐ N/A | |
| 6 | Tab to a specific Test Execution (`TE-…`) row's label, press `Enter` or `Space`. | The row is selected (visually indicated, not just by color — WP-046 fixed `aria-pressed` to mirror this). A tab opens for it. (jsdom-verified: `Enter`/`Space` both call `onSelect` exactly once, no double-fire.) | ☐ PASS ☐ FAIL ☐ N/A | |
| 7 | **Not jsdom-verified anywhere** — check by hand: does focus move into the newly-opened tab / its content, or is it left behind on the tree? | A keyboard user should not have to hunt for where focus went after opening a tab. | ☐ PASS ☐ FAIL ☐ N/A | |
| 8 | Tab into the now-open Test Execution content's own tree (the test-case picker inside this execution). | Reaches its toolbar-less rows directly; first row's label is a real focusable button (jsdom-verified: `folderList/__tests__/CustomNode.a11y.test.tsx`). | ☐ PASS ☐ FAIL ☐ N/A | |
| 9 | Select a test case row via `Enter`/`Space`. | The detail panel (steps, fields, Play button) appears without a mouse click anywhere. | ☐ PASS ☐ FAIL ☐ N/A | |
| 10 | Tab to the Play (▶) button, press `Enter` or `Space`. | Enters edit mode: the Save button becomes enabled, each step's Status control becomes a real, interactive `<Select>` (jsdom-verified: `AddDeleteTableRows.a11y.test.tsx`). | ☐ PASS ☐ FAIL ☐ N/A | |
| 11 | Continue tabbing into the Steps table. | Focus lands on step 1's Status control, which announces "Status for step 1" (jsdom-verified accessible name — `TableRows.tsx`'s WP-046 fix). Tab again lands on step 2's ("Status for step 2"), in row order (jsdom-verified: `AddDeleteTableRows.a11y.test.tsx`'s Tab-order test). | ☐ PASS ☐ FAIL ☐ N/A | |
| 12 | With a Status control focused, press `Enter`, `Space`, or `Down Arrow` to open it. | **Not jsdom-verified** — MUI `<Select>`'s popup is a portal rendered outside the normal DOM tree; opening/closing it and moving focus into its listbox is real browser behavior jsdom does not meaningfully exercise. Confirm by hand that the dropdown opens, is fully keyboard-navigable (arrow keys move through options, `Enter` selects, `Escape` closes without changing the value), and focus returns to the control afterward. | ☐ PASS ☐ FAIL ☐ N/A | |
| 13 | Select "Pass" for step 1, "Fail" for step 2 (or whatever fits your data), all via keyboard. | Each step's status updates visibly; the running No Run/In Progress/Pass/Fail/Blocked counts above update as text (not color alone — confirmed by reading `TestExecutionContent.tsx`; not independently re-verified here). | ☐ PASS ☐ FAIL ☐ N/A | |
| 14 | Tab onward to the attachment upload control. | Reaches a real, focusable file-input trigger — **not** a bare `<input type="file">` hidden behind a mouse-only click handler (this was an actual bug WP-046 fixed; see `attachments.a11y.test.tsx`). Activating it via keyboard opens the OS file picker. | ☐ PASS ☐ FAIL ☐ N/A | |
| 15 | Cancel or complete the file picker (OS-level, outside this app's control), tab onward. | Focus returns to the app in a sane place, not lost. | ☐ PASS ☐ FAIL ☐ N/A | |
| 16 | Tab to the Save (💾) button, press `Enter` or `Space`. | Saves the recorded results; edit mode exits (Play re-enabled, Save disabled); any confirmation (snackbar) is visible and, ideally, announced to a screen reader (`role="alert"`/`aria-live`) even though this pass is keyboard-only, not SR-only. | ☐ PASS ☐ FAIL ☐ N/A | |
| 17 | Tab away from the Save button. | Focus continues in a logical order — doesn't jump back to the top of the page or vanish. | ☐ PASS ☐ FAIL ☐ N/A | |
| 18 | At every step above, confirm: was a visible focus indicator ALWAYS present on whatever had focus? | This is the single most common real-world keyboard-accessibility failure and the one class of bug `axe`-in-jsdom structurally cannot check (see `src/testUtils/a11y.ts`'s own coverage statement — color/visual rendering is inert in jsdom). | ☐ PASS ☐ FAIL ☐ N/A | |

## What's already covered without you (so you don't have to re-derive it)

The following are **jsdom-verified**, not hypotheses this script is asking
you to re-check from scratch — if you find them failing in the real
browser, that's a *regression* between what's covered and what's
deployed, worth flagging as such:

- Both tree row implementations (test repo/requirement/defect/plan tree,
  and the execution screen's test-case tree) are keyboard-selectable, with
  both `Enter` and `Space` working, and don't double-fire selection.
- The Steps table's Status `<Select>` carries a real, distinct accessible
  name per row and is reachable via `Tab` in row order.
- The file-upload control across every module that has one is keyboard
  operable, not mouse-only.
- Every chart on the dashboard (trend/bar/donut/stat tile) exposes a
  keyboard-operable "show as table" toggle as an alternative to reading the
  visual chart.

## What this script does NOT cover

- Screen reader announcement quality (a separate pass).
- Any of the other three target pages' own full keyboard walkthroughs
  (dashboard, test repo list, defect form) — each deserves its own script;
  this WP wrote only this one, as explicitly scoped.
- Zoom/reflow, touch-target sizing, or anything else that needs real
  layout.
- Whether this actually works on a specific screen reader + browser
  combination end to end.

---
*Written by the WP-046 finishing pass, 2026-08-31. If you (a human, with a
real browser) run this and update the Result column, please also update
this header to say so and by whom/when, and file separate tickets for any
FAIL rather than editing the "Expected" column to match what you saw.*
