import { useMutation, useQueryClient, UseMutationResult } from '@tanstack/react-query';
import { ModuleId } from '../../workbench/modules';
import { getCurrentProjectId } from '../../currentProject';
import { qk } from '../queryKeys';
import { TreeNode } from '../queries/useTreeChildren';
import {
  updateFolderByParam,
  updateTestCaseByParam,
  updateRequirementByParam,
} from '../../api/apiCalls';

export interface MoveNodeVars {
  id: string;
  fromParentId: string | number;
  toParentId: string | number;
  droppable: boolean;
}

interface MoveNodeContext {
  prevFrom: TreeNode[] | undefined;
  prevTo: TreeNode[] | undefined;
  fromParentId: string | number;
  toParentId: string | number;
}

// WP-071 §11.5: dispatches to whichever *ByParam mover the moved node's own
// kind actually has. A folder moves via updateFolderByParam regardless of
// module. A leaf's mover is module-specific, and only modules 1 (test
// cases) and 2 (requirements) have one today (GR-1: updateTestCaseByParam,
// updateRequirementByParam). Modules 3/4/5 (test plans, test runs, defects)
// have no equivalent API yet -- WP-076/WP-077 add those movers when they
// migrate those modules, so this throws a clear error rather than inventing
// a call that does not exist.
async function moveViaApi(module: ModuleId, vars: MoveNodeVars): Promise<unknown> {
  const { id, toParentId, droppable } = vars;
  if (droppable) {
    return updateFolderByParam(id, { parentFolder: toParentId });
  }
  switch (module) {
    case 1:
      return updateTestCaseByParam(id, { parentId: toParentId });
    case 2:
      return updateRequirementByParam(id, { parentId: toParentId });
    default:
      throw new Error(
        `useMoveNode: no move API exists yet for module ${module} (test plans/test runs/defects) -- WP-076/WP-077 own adding it`,
      );
  }
}

export function useMoveNode(
  module: ModuleId,
): UseMutationResult<unknown, unknown, MoveNodeVars, MoveNodeContext> {
  const queryClient = useQueryClient();
  const projectId = getCurrentProjectId();

  return useMutation<unknown, unknown, MoveNodeVars, MoveNodeContext>({
    mutationFn: (vars) => moveViaApi(module, vars),
    onMutate: async ({ id, fromParentId, toParentId }) => {
      await queryClient.cancelQueries({ queryKey: qk.children(projectId, module, fromParentId) });
      await queryClient.cancelQueries({ queryKey: qk.children(projectId, module, toParentId) });

      const prevFrom = queryClient.getQueryData<TreeNode[]>(qk.children(projectId, module, fromParentId));
      const prevTo = queryClient.getQueryData<TreeNode[]>(qk.children(projectId, module, toParentId));

      const moving = prevFrom?.find((n) => n.id === id);

      queryClient.setQueryData<TreeNode[]>(
        qk.children(projectId, module, fromParentId),
        (prevFrom ?? []).filter((n) => n.id !== id),
      );

      if (moving) {
        queryClient.setQueryData<TreeNode[]>(
          qk.children(projectId, module, toParentId),
          [...(prevTo ?? []), { ...moving, parent: String(toParentId) }],
        );
      }

      return { prevFrom, prevTo, fromParentId, toParentId };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      queryClient.setQueryData(qk.children(projectId, module, ctx.fromParentId), ctx.prevFrom);
      queryClient.setQueryData(qk.children(projectId, module, ctx.toParentId), ctx.prevTo);
    },
    onSettled: (_data, _err, vars) => {
      queryClient.invalidateQueries({ queryKey: qk.children(projectId, module, vars.fromParentId) });
      queryClient.invalidateQueries({ queryKey: qk.children(projectId, module, vars.toParentId) });
    },
  });
}
