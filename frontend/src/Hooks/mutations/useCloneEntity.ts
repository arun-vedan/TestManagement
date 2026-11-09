import { useMutation, UseMutationResult } from '@tanstack/react-query';
import { ModuleId } from '../../workbench/modules';
import { getTcList, getReqList, getTestPlanList, getDefectList } from '../../api/apiCalls';
import { buildEntityPrefill, RawRecord } from '../../workbench/entityPrefill';
import { openDraftFromPrefill } from '../../workbench/openDraftFromPrefill';
import { DraftPrefill } from '../../workbench/store/workbenchStore';
import { useWorkbench } from '../../workbench/WorkbenchStoreProvider';

// Wave B-4 (clone an entity) -- PRODUCT_GAP_REGISTER.md B1: there is no
// clone endpoint (nor should there be one -- see the dispatch's "VERIFIED"
// section), so a clone is: read the source entity, then open a pre-filled
// draft the user confirms before it goes through the module's normal
// create path (TestCaseDetail/RequirementDetail/TestPlanDetail/
// DefectDetail's own `isDraft` branch, WP-079). This hook only does the
// "read the source, seed a fresh draft's prefill" half; saving that draft
// is unchanged, ordinary create.
//
// Only offered for DRAFT_CAPABLE_MODULES (workbench/modules.ts -- 1, 2, 3,
// 5): module 4 (test executions) has no create-from-scratch flow to clone
// into (an execution is created FROM a plan), and module 6 (releases) has
// no detail component at all yet. Callers (EntityTree.tsx) gate the
// affordance on that same set; buildEntityPrefill's `default` branch (in
// workbench/entityPrefill.ts) is a second, defensive guard against ever
// being called for anything outside it.
//
// WP-F08 Task 2 -- the "flatten a record into a prefill" half (per
// module) now lives in workbench/entityPrefill.ts's buildEntityPrefill,
// shared with SaveAsTemplateDialog/useStartFromTemplate so a template's
// capture and a clone's prefill can never disagree on what a module's
// prefill shape is. What stays here, specific to cloning: fetching the
// LIVE source row by id (a template already has its prefill stored, no
// fetch needed) and this hook's own "Copy of ..." title/summary
// relabeling (a template is a fresh starting point, never labelled as a
// copy of anything -- R4).
interface ClonePlan {
  /** Draft tab title -- "Copy of <source summary>" where the module has a summary-like field, else the source's own id. */
  title: string;
  prefill: DraftPrefill;
}

async function fetchSourceRow(module: ModuleId, id: string): Promise<RawRecord> {
  switch (module) {
    case 1: {
      const rows = await getTcList(`TestCaseId=${id}`);
      return (rows && rows[0]) || {};
    }
    case 2: {
      const rows = await getReqList(`reqId=${id}`);
      return (rows && rows[0]) || {};
    }
    case 3: {
      const rows = await getTestPlanList(`TestPlanId=${id}`);
      return (rows && rows[0]) || {};
    }
    case 5: {
      const rows = await getDefectList(`defectId=${id}`);
      return (rows && rows[0]) || {};
    }
    default:
      throw new Error(`useCloneEntity: module ${module} has no create flow to clone into`);
  }
}

async function buildClonePlan(module: ModuleId, id: string): Promise<ClonePlan> {
  const row = await fetchSourceRow(module, id);
  const { prefill, summaryField, summaryLabel } = buildEntityPrefill(module, row);
  // Module 3 (Test Plans) has no summary field to relabel -- its title is
  // always keyed off the source plan's own id, same as before this was
  // extracted.
  if (!summaryField) {
    return { title: `Copy of ${id}`, prefill };
  }
  const copySummary = `Copy of ${summaryLabel}`;
  return {
    title: summaryLabel ? copySummary : `Copy of ${id}`,
    prefill: { ...prefill, [summaryField]: copySummary },
  };
}

export function useCloneEntity(module: ModuleId): UseMutationResult<ClonePlan, unknown, string> {
  const openTab = useWorkbench((s) => s.openTab);
  const setDraftPrefill = useWorkbench((s) => s.setDraftPrefill);

  return useMutation({
    mutationFn: (id: string) => buildClonePlan(module, id),
    onSuccess: ({ title, prefill }) => openDraftFromPrefill(module, title, prefill, { openTab, setDraftPrefill }),
  });
}
