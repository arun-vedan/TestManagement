import { useQuery, UseQueryResult } from '@tanstack/react-query';
import { ModuleId, FOLDER_MODULES } from '../../workbench/modules';
import { getCurrentProjectId } from '../../currentProject';
import { qk } from '../queryKeys';
import {
  getFolderList,
  getTcList,
  getReqList,
  getTestPlanList,
  getTestExecutionList,
  getDefectList,
} from '../../api/apiCalls';
import { getReleases } from '../../api/releaseApi';

// WP-071: per-folder tree query. Unlike Hooks/queries/useModuleTree.ts (WP-015,
// which fetches the *whole* module's folders + one flat item list in one
// shot for the four legacy pages' initial load), this fetches exactly one
// parent's direct children -- the folders under it plus its leaf entities --
// so an expanded node's cache entry is the tree, with nothing local to
// diverge from it. Deliberately a new, narrower type: do not import
// useModuleTree's TreeNode here, and do not reuse this one there.
export interface TreeNode {
  id: string;
  parent: string;
  droppable: boolean;
  text: string;
  status?: string;
}

interface FolderListItem {
  id: number | string;
  parentFolder: number | string;
  folderName: string;
}

const mapFolder = (folder: FolderListItem): TreeNode => ({
  id: String(folder.id),
  parent: String(folder.parentFolder),
  droppable: true,
  text: folder.folderName,
});

// Leaf fetchers, one per module (field names per GR-1 / WP-015's existing
// per-module hooks in Hooks/queries/use*Tree.ts).
//
// Modules 1/2/3 (test cases, requirements, test plans) carry a real
// `parentId` on the leaf row, so the API can filter server-side with
// `&parentId=${parentId}`.
//
// Modules 4/5 (test executions, defects) are flat -- their leaf rows have
// no folder membership at all, the same gap useTestExecutionTree.ts and
// useDefectsTree.ts paper over today by hardcoding `parent: 0` on every
// item regardless of which folder query produced them. There is also no
// mover for these two modules yet (see mutations/useMoveNode.ts), so
// nothing can place one of their leaves under a non-root folder in the
// first place. Rather than repeat that same list under every folder this
// hook is asked about, leaves are only returned when the root ('0') is the
// parent being requested; any other parent gets none. This is not a
// regression -- it is the same "leaves live at the root" behavior the old
// hooks encode, just not duplicated across every folder id.
async function fetchLeaves(module: ModuleId, parentId: string | number): Promise<TreeNode[]> {
  switch (module) {
    case 1: {
      const items = await getTcList(`select=TestCaseId,TestCaseSummary,parentId,id&parentId=${parentId}`);
      return (items as Array<{ TestCaseId: string | number; parentId: string | number }>).map((item) => ({
        id: String(item.TestCaseId),
        parent: String(item.parentId),
        droppable: false,
        text: String(item.TestCaseId),
      }));
    }
    case 2: {
      const items = await getReqList(`select=reqId,parentId,id&parentId=${parentId}`);
      return (items as Array<{ reqId: string | number; parentId: string | number }>).map((item) => ({
        id: String(item.reqId),
        parent: String(item.parentId),
        droppable: false,
        text: String(item.reqId),
      }));
    }
    case 3: {
      // No folders for plans (FOLDER_MODULES): every plan at the root, even
      // one whose stored parentId still names a since-hidden folder.
      if (String(parentId) !== '0') return [];
      const items = await getTestPlanList('select=TestPlanId,id');
      return (items as Array<{ TestPlanId: string | number }>).map((item) => ({
        id: String(item.TestPlanId),
        parent: String(parentId),
        droppable: false,
        text: String(item.TestPlanId),
      }));
    }
    case 4: {
      if (String(parentId) !== '0') return [];
      const items = await getTestExecutionList('select=TestExecutionId,id');
      return (items as Array<{ TestExecutionId: string | number }>).map((item) => ({
        id: String(item.TestExecutionId),
        parent: String(parentId),
        droppable: false,
        text: String(item.TestExecutionId),
      }));
    }
    case 5: {
      if (String(parentId) !== '0') return [];
      const items = await getDefectList('select=defectId');
      return (items as Array<{ defectId: string | number }>).map((item) => ({
        id: String(item.defectId),
        parent: String(parentId),
        droppable: false,
        text: String(item.defectId),
      }));
    }
    case 6: {
      // Releases carry no parentId, so -- like runs and defects -- they sit
      // at the root only. The node id is the Mongo _id, not REL-n: that is
      // what EntityDetail/ReleaseDetail dispatch on and what the list view's
      // ReleaseIdCell opens, so a release opened from either view is the
      // same tab. Without this case module 6 fell through to `default` and
      // the tree never showed a single release.
      if (String(parentId) !== '0') return [];
      const releases = await getReleases();
      return releases.map((release) => ({
        id: String(release._id),
        parent: String(parentId),
        droppable: false,
        text: release.releaseId || String(release._id),
      }));
    }
    default:
      return [];
  }
}

// WP-073 — extracted so <EntityTree> (src/workbench/tree/EntityTree.tsx) can
// fan out across every currently-EXPANDED folder via react-query's
// `useQueries` (a variable-length array of queries -- calling this file's
// own `useTreeChildren` hook itself, in a loop, would break the rules of
// hooks, since the number of expanded folders changes render to render).
// `useQueries` needs plain {queryKey, queryFn} options, not a hook, so this
// is the shared source of truth both `useTreeChildren` (below, for the
// always-mounted root query) and EntityTree's per-folder fan-out call
// through -- one fetch implementation, not two copies of it. Purely an
// extraction: `useTreeChildren`'s own behavior, and WP-071's tests for it,
// are unchanged.
export function treeChildrenQueryOptions(
  projectId: number,
  module: ModuleId,
  parentId: string | number,
): { queryKey: ReturnType<typeof qk.children>; queryFn: () => Promise<TreeNode[]> } {
  return {
    queryKey: qk.children(projectId, module, parentId),
    queryFn: async () => {
      const [folders, leaves] = await Promise.all([
        FOLDER_MODULES.has(module) ? getFolderList(parentId, module) : Promise.resolve([]),
        fetchLeaves(module, parentId),
      ]);
      const folderNodes = (folders as FolderListItem[]).map(mapFolder);
      // Folders first, then leaves -- matches the order the legacy
      // useModuleTree.ts merge produces and the order this WP's test
      // asserts.
      return [...folderNodes, ...leaves];
    },
  };
}

export function useTreeChildren(
  module: ModuleId,
  parentId: string | number,
): UseQueryResult<TreeNode[]> {
  const projectId = getCurrentProjectId();
  return useQuery(treeChildrenQueryOptions(projectId, module, parentId));
}
