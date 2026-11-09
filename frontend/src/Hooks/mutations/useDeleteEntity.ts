import { useMutation, useQueryClient, UseMutationResult } from '@tanstack/react-query';
import { ModuleId } from '../../workbench/modules';
import { getCurrentProjectId } from '../../currentProject';
import { qk } from '../queryKeys';
import { tabKey } from '../../workbench/store/workbenchStore';
import { useWorkbench } from '../../workbench/WorkbenchStoreProvider';
import {
  getTcList,
  getReqList,
  getTestPlanList,
  getTestExecutionList,
  getDefectList,
  deleteTestCase,
  deleteRequirement,
  deleteTestPlan,
  deleteTestExecution,
  deleteDefect,
} from '../../api/apiCalls';

// Wave B-3 (delete an entity) -- PRODUCT_GAP_REGISTER.md A1/B1: every
// module has a properly-scoped per-entity DELETE endpoint
// (keycloak.protect() -> requireProjectScope() -> authorize('delete')),
// but the tree's row menu had no way to reach any of them, and bulk
// delete (api/bulkApi.ts) only ever covered modules 1/5 from the LIST
// view. Mirrors useMoveNode.ts's own module-dispatch shape exactly.
export interface DeleteEntityVars {
  id: string;
  /** The entity's CURRENT domain parent (EntityTreeNode's own metadata.parentId) -- the exact qk.children cache entry that must be invalidated for the deleted row to disappear from the tree without a manual refresh. */
  parentId: string | number;
}

interface RawRecord {
  _id?: string;
  [key: string]: unknown;
}

// Every module's DELETE .../:id controller is `findOneAndDelete({ _id:
// req.params.id, ... })` (verified by reading testrepo.js/requirement.js/
// testplan.js/testexecution.js/defects.js's own delete* handlers) -- the
// route takes the Mongo _id, NOT the business key the tree renders
// (TC-104, Req-8, PLN-3, Run-1, Bug-1). A live call with the business id
// 404s. So a business id must be resolved to its _id first -- the exact
// same get*List-by-business-key lookup useCloneEntity.ts already does to
// read the source entity, reused here rather than duplicated.
async function resolveMongoId(module: ModuleId, id: string): Promise<string> {
  let rows: RawRecord[];
  switch (module) {
    case 1:
      rows = await getTcList(`TestCaseId=${id}`);
      break;
    case 2:
      rows = await getReqList(`reqId=${id}`);
      break;
    case 3:
      rows = await getTestPlanList(`TestPlanId=${id}`);
      break;
    case 4:
      rows = await getTestExecutionList(`TestExecutionId=${id}`);
      break;
    case 5:
      rows = await getDefectList(`defectId=${id}`);
      break;
    default:
      throw new Error(`useDeleteEntity: no delete API exists for module ${module}`);
  }
  const mongoId = rows?.[0]?._id;
  if (!mongoId) {
    throw new Error(`Could not find ${id} to delete it -- it may already be gone.`);
  }
  return mongoId;
}

async function deleteViaApi(module: ModuleId, id: string): Promise<unknown> {
  const mongoId = await resolveMongoId(module, id);
  switch (module) {
    case 1:
      return deleteTestCase(mongoId);
    case 2:
      return deleteRequirement(mongoId);
    case 3:
      return deleteTestPlan(mongoId);
    case 4:
      return deleteTestExecution(mongoId);
    case 5:
      return deleteDefect(mongoId);
    default:
      throw new Error(`useDeleteEntity: no delete API exists for module ${module}`);
  }
}

export function useDeleteEntity(module: ModuleId): UseMutationResult<unknown, unknown, DeleteEntityVars> {
  const queryClient = useQueryClient();
  const projectId = getCurrentProjectId();
  const closeTab = useWorkbench((s) => s.closeTab);
  const setSelection = useWorkbench((s) => s.setSelection);
  // Read (not just written) so onSuccess below can tell whether the
  // entity being deleted is the one currently selected -- see the comment
  // on that clear for why this matters, independently of EntityTree.tsx's
  // own defensive `selectedIds` filter.
  const currentSelection = useWorkbench((s) => s.selection[module]);

  return useMutation({
    mutationFn: ({ id }: DeleteEntityVars) => deleteViaApi(module, id),
    onSuccess: (_data, { id, parentId }) => {
      // Close any open tab for the now-gone entity first -- a tab left
      // open on a deleted record would otherwise keep trying to fetch it.
      closeTab(tabKey(module, id));
      // Clear the store's own selection SYNCHRONOUSLY, in the same tick
      // as this success handler -- BEFORE the invalidated qk.children
      // query's refetch resolves and `data` itself loses this id (that
      // happens on a LATER render). Deleting this in the same render as
      // the data change (rather than a render earlier) hit a real
      // react-accessible-treeview race: its internal selectedIds Set only
      // resyncs from the controlled `selectedIds` prop via its own effect,
      // one render behind a prop change that lands on the SAME commit as
      // a `data` change -- so it can still try to look up the
      // just-removed id against the just-updated data and throw "Node
      // with id=<X> doesn't exist in the tree" (confirmed live via this
      // WP's required browser verification, not reproducible in the
      // mocked-API unit suites). Clearing selection here, ahead of the
      // data change instead of alongside it, keeps those two updates on
      // separate renders and avoids the race entirely.
      if (currentSelection === id) {
        setSelection(module, null);
      }
      // Same cache entry the tree itself reads (useTreeChildren) -- this
      // is what makes the deleted row disappear without a manual refresh.
      queryClient.invalidateQueries({ queryKey: qk.children(projectId, module, parentId) });
    },
  });
}
