import { ModuleId } from './modules';
import { DraftPrefill, EntityId, makeDraftEntityId } from './store/workbenchStore';

export interface DraftOpener {
  setDraftPrefill: (draftEntityId: EntityId, prefill: DraftPrefill) => void;
  openTab: (t: { module: ModuleId; entityId: EntityId; title: string }) => void;
}

// WP-F08 Task 2 -- the one mechanism a draft is ever started FROM a
// prefill, extracted out of useCloneEntity.ts's onSuccess so useCloneEntity
// (a live record) and useStartFromTemplate (a stored CaseTemplate) share
// it rather than each reimplementing the same three steps: mint a fresh
// draft id, record its prefill BEFORE opening the tab (so the
// draft-capable detail component's own mount-time effect always finds it
// already there -- same ordering DefectDraftIntent's A6 flow uses), then
// open the tab. The plan's central constraint is that these two paths
// must never diverge on the mechanism itself, only on where the prefill
// comes from.
export function openDraftFromPrefill(
  module: ModuleId,
  title: string,
  prefill: DraftPrefill,
  { setDraftPrefill, openTab }: DraftOpener,
): void {
  const draftId = makeDraftEntityId();
  setDraftPrefill(draftId, prefill);
  openTab({ module, entityId: draftId, title });
}
