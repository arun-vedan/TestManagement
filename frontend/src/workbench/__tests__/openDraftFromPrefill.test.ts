import { openDraftFromPrefill } from '../openDraftFromPrefill';
import { isDraftEntityId } from '../store/workbenchStore';

// WP-F08 Task 2 -- the single mechanism useCloneEntity.ts and
// useStartFromTemplate.ts both fan into to open a prefilled draft. Proven
// here in isolation from either caller: a fresh draft id is minted, its
// prefill is recorded BEFORE the tab opens (so a draft-capable detail
// component's own mount-time effect always finds it already there), and
// the tab is opened with that id and the given title/module.
describe('openDraftFromPrefill', () => {
  it('mints a fresh draft entity id, records its prefill before opening the tab, and opens it with the given module/title', () => {
    const calls: string[] = [];
    const setDraftPrefill = jest.fn((id: string, _prefill: Record<string, unknown>) => calls.push(`setDraftPrefill:${id}`));
    const openTab = jest.fn((t: { module: number; entityId: string; title: string }) => calls.push(`openTab:${t.entityId}`));

    openDraftFromPrefill(1, 'Regression — login flow', { TestCaseSummary: 'x', datasetId: 'ds1' }, {
      setDraftPrefill,
      openTab,
    });

    expect(setDraftPrefill).toHaveBeenCalledTimes(1);
    expect(openTab).toHaveBeenCalledTimes(1);

    const [draftId, prefill] = setDraftPrefill.mock.calls[0];
    const [tabArgs] = openTab.mock.calls[0];

    // A real draft sentinel, not the template's/source's own id -- this is
    // what makes the opened tab "a real draft: unsaved, showing Create".
    expect(isDraftEntityId(draftId)).toBe(true);
    expect(prefill).toEqual({ TestCaseSummary: 'x', datasetId: 'ds1' });
    expect(tabArgs).toEqual({ module: 1, entityId: draftId, title: 'Regression — login flow' });

    // The single-line break this catches: swapping the call order
    // (openTab before setDraftPrefill) makes this fail -- a detail
    // component's mount-time effect could then run before the prefill is
    // recorded and silently render an unfilled draft.
    expect(calls).toEqual([`setDraftPrefill:${draftId}`, `openTab:${draftId}`]);
  });

  it('mints a different draft id on every call, so opening from the same template twice never collides', () => {
    const setDraftPrefill = jest.fn();
    const openTab = jest.fn();
    openDraftFromPrefill(1, 'A', {}, { setDraftPrefill, openTab });
    openDraftFromPrefill(1, 'A', {}, { setDraftPrefill, openTab });

    const [firstId] = setDraftPrefill.mock.calls[0];
    const [secondId] = setDraftPrefill.mock.calls[1];
    expect(firstId).not.toBe(secondId);
  });
});
