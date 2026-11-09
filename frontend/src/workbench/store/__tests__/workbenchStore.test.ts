import { createWorkbenchStore, tabKey, isDraftEntityId, makeDraftEntityId } from '../workbenchStore';

describe('workbench store — tabs', () => {
  it('opens a tab and makes it active', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
    expect(s.getState().tabs).toHaveLength(1);
    expect(s.getState().activeTabKey).toBe(tabKey(1, 'TC-104'));
  });

  it('dedupes: reopening an entity activates the existing tab', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
    s.getState().openTab({ module: 2, entityId: 'REQ-8', title: 'Auth' });
    s.getState().openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
    expect(s.getState().tabs).toHaveLength(2);
    expect(s.getState().activeTabKey).toBe(tabKey(1, 'TC-104'));
  });

  it('holds tabs from different modules simultaneously', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
    s.getState().openTab({ module: 2, entityId: 'REQ-8', title: 'Auth' });
    s.getState().openTab({ module: 3, entityId: 'PLN-3', title: 'Reg' });
    expect(s.getState().tabs.map(t => t.module)).toEqual([1, 2, 3]);
  });

  // Guards ScrollableTabs.tsx:31, which activated tabs[tabs.length-2]
  // regardless of which tab was closed.
  it('closing the active tab activates its right neighbour', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'A', title: 'A' });
    s.getState().openTab({ module: 1, entityId: 'B', title: 'B' });
    s.getState().openTab({ module: 1, entityId: 'C', title: 'C' });
    s.getState().activateTab(tabKey(1, 'B'));
    s.getState().closeTab(tabKey(1, 'B'));
    expect(s.getState().activeTabKey).toBe(tabKey(1, 'C'));
  });

  it('closing the last tab falls back to the left neighbour', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'A', title: 'A' });
    s.getState().openTab({ module: 1, entityId: 'B', title: 'B' });
    s.getState().closeTab(tabKey(1, 'B'));
    expect(s.getState().activeTabKey).toBe(tabKey(1, 'A'));
  });

  it('closing the only tab clears the active key', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'A', title: 'A' });
    s.getState().closeTab(tabKey(1, 'A'));
    expect(s.getState().activeTabKey).toBeNull();
  });

  it('closing a non-active tab leaves the active tab alone', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'A', title: 'A' });
    s.getState().openTab({ module: 1, entityId: 'B', title: 'B' });
    s.getState().closeTab(tabKey(1, 'A'));
    expect(s.getState().activeTabKey).toBe(tabKey(1, 'B'));
  });
});

// WP-079 Part A -- §5.2 always anticipated `entityId` being "business key
// (TC-104) or a draft sentinel"; this is the sentinel format and the
// helper that tells the two apart.
describe('workbench store — draft ids', () => {
  it('makeDraftEntityId produces a value isDraftEntityId recognises', () => {
    const id = makeDraftEntityId();
    expect(id.startsWith('new:')).toBe(true);
    expect(isDraftEntityId(id)).toBe(true);
  });

  it('two calls to makeDraftEntityId never collide', () => {
    const a = makeDraftEntityId();
    const b = makeDraftEntityId();
    expect(a).not.toBe(b);
  });

  it('isDraftEntityId is false for a real business key', () => {
    expect(isDraftEntityId('TC-104')).toBe(false);
  });
});

describe('workbench store — replaceTab', () => {
  it('replaces a draft tab with the real entity at the same index, activating it', () => {
    const s = createWorkbenchStore(1);
    const draftId = makeDraftEntityId();
    s.getState().openTab({ module: 1, entityId: 'A', title: 'A' });
    s.getState().openTab({ module: 1, entityId: draftId, title: 'New Test Case' });
    s.getState().openTab({ module: 1, entityId: 'B', title: 'B' });

    const draftKey = tabKey(1, draftId);
    s.getState().replaceTab(draftKey, { module: 1, entityId: 'TC-104', title: 'TC-104' });

    const tabs = s.getState().tabs;
    expect(tabs.map((t) => t.entityId)).toEqual(['A', 'TC-104', 'B']);
    expect(s.getState().activeTabKey).toBe(tabKey(1, 'TC-104'));
  });

  it('is a no-op when the old key is not an open tab', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'A', title: 'A' });
    s.getState().activateTab(tabKey(1, 'A'));

    s.getState().replaceTab(tabKey(1, 'not-open'), { module: 1, entityId: 'TC-104', title: 'TC-104' });

    expect(s.getState().tabs.map((t) => t.entityId)).toEqual(['A']);
    expect(s.getState().activeTabKey).toBe(tabKey(1, 'A'));
  });

  it('does not disturb other tabs (their dirty flags survive)', () => {
    const s = createWorkbenchStore(1);
    const draftId = makeDraftEntityId();
    s.getState().openTab({ module: 1, entityId: 'A', title: 'A' });
    s.getState().openTab({ module: 1, entityId: draftId, title: 'New Test Case' });
    s.getState().setTabDirty(tabKey(1, 'A'), true);

    s.getState().replaceTab(tabKey(1, draftId), { module: 1, entityId: 'TC-104', title: 'TC-104' });

    expect(s.getState().tabs.find((t) => t.entityId === 'A')?.dirty).toBe(true);
    expect(s.getState().tabs.find((t) => t.entityId === 'TC-104')?.dirty).toBe(false);
  });
});

describe('workbench store — expansion', () => {
  it('toggleExpanded adds then removes, per module', () => {
    const s = createWorkbenchStore(1);
    s.getState().toggleExpanded(1, '8');
    expect(s.getState().expanded[1]).toEqual(['8']);
    s.getState().toggleExpanded(1, '8');
    expect(s.getState().expanded[1]).toEqual([]);
  });
});

// A6 -- "Raise defect" (TestRunDetail) opens a module-5 draft tab and
// records both the text it should be pre-filled with and the link that
// should be created back to the test case once the draft is saved. The
// store is where that intent has to live: the draft tab's own component
// (DefectDetail) doesn't exist yet at the moment "Raise defect" is clicked.
describe('workbench store — defect draft intents', () => {
  it('setDefectDraftIntent records prefill + link, keyed by the draft entityId', () => {
    const s = createWorkbenchStore(1);
    const draftId = makeDraftEntityId();
    s.getState().setDefectDraftIntent(draftId, {
      prefill: { summary: 'Test case TC-1 failed in run Run-1' },
      link: { sourceModule: 1, sourceId: 'TC-1', sourceSummary: 'Login works', linkType: 'relates-to' },
    });
    expect(s.getState().defectDraftIntents[draftId]).toEqual({
      prefill: { summary: 'Test case TC-1 failed in run Run-1' },
      link: { sourceModule: 1, sourceId: 'TC-1', sourceSummary: 'Login works', linkType: 'relates-to' },
    });
  });

  it('consumeDefectDraftIntent returns the intent and removes it, so it cannot be acted on twice', () => {
    const s = createWorkbenchStore(1);
    const draftId = makeDraftEntityId();
    s.getState().setDefectDraftIntent(draftId, { prefill: { summary: 'x' } });

    const first = s.getState().consumeDefectDraftIntent(draftId);
    expect(first).toEqual({ prefill: { summary: 'x' } });

    const second = s.getState().consumeDefectDraftIntent(draftId);
    expect(second).toBeUndefined();
    expect(s.getState().defectDraftIntents[draftId]).toBeUndefined();
  });

  it('consumeDefectDraftIntent on an id with no recorded intent returns undefined and does not throw', () => {
    const s = createWorkbenchStore(1);
    expect(s.getState().consumeDefectDraftIntent('new:never-set')).toBeUndefined();
  });
});

// Wave B-4 (clone an entity) -- the generic prefill map every
// draft-capable module (1, 2, 3, 5) reads from, distinct from the A6-only
// defectDraftIntents above (a clone carries no `link`).
describe('workbench store — clone draft prefill', () => {
  it('setDraftPrefill records an arbitrary prefill object, keyed by the draft entityId', () => {
    const s = createWorkbenchStore(1);
    const draftId = makeDraftEntityId();
    s.getState().setDraftPrefill(draftId, { TestCaseSummary: 'Copy of Login works', priority: 'Low' });
    expect(s.getState().draftPrefill[draftId]).toEqual({ TestCaseSummary: 'Copy of Login works', priority: 'Low' });
  });

  it('an id with no recorded prefill is simply absent, not an error', () => {
    const s = createWorkbenchStore(1);
    expect(s.getState().draftPrefill['new:never-set']).toBeUndefined();
  });

  it('setDraftPrefill for one draft id does not disturb another', () => {
    const s = createWorkbenchStore(1);
    const draftA = makeDraftEntityId();
    const draftB = makeDraftEntityId();
    s.getState().setDraftPrefill(draftA, { summary: 'A' });
    s.getState().setDraftPrefill(draftB, { summary: 'B' });
    expect(s.getState().draftPrefill[draftA]).toEqual({ summary: 'A' });
    expect(s.getState().draftPrefill[draftB]).toEqual({ summary: 'B' });
  });
});
