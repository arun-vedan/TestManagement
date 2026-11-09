import { ModuleId } from '../workbench/modules';

export const qk = {
  children: (projectId: number, module: ModuleId, parentId: string | number) =>
    ['project', projectId, module, 'children', parentId] as const,
  entity: (projectId: number, module: ModuleId, entityId: string) =>
    ['project', projectId, module, 'entity', entityId] as const,
  list: (projectId: number, module: ModuleId, viewId: string | null, filters: unknown) =>
    ['project', projectId, module, 'list', viewId, filters] as const,
  search: (projectId: number, module: ModuleId, searchText: string) =>
    ['project', projectId, module, 'search', searchText] as const,
  coverage: (projectId: number) =>
    ['project', projectId, 'coverage', 'untested'] as const,
};
