import { useQuery, UseQueryResult } from '@tanstack/react-query';
import { ModuleId } from '../../workbench/modules';
import { getCurrentProjectId } from '../../currentProject';
import { moduleSearchConfigs, SearchResultItem } from '../../workbench/search/entitySearchConfigs';
import { qk } from '../queryKeys';

// Wave B-2 (workbench search) -- the react-query boundary EntitySearchPanel
// reads results through. `searchText` is expected to already be the
// DEBOUNCED value (see useDebouncedValue.ts) -- this hook itself does no
// debouncing, it just refetches whenever its query key (which includes
// searchText) changes, same as every other query in this app.
//
// `enabled` is false whenever there is no config for `module` (module 6
// today) OR the search text is empty -- in both cases NO request is ever
// issued: not "issued and ignored", genuinely never fetched. This is what
// lets EntitySearchPanel prove "no endpoint call for module 6" just by
// asserting the mocked api/apiCalls functions were never invoked (the
// panel test now proves it for module 6 specifically).
export function useEntitySearch(module: ModuleId, searchText: string): UseQueryResult<SearchResultItem[]> {
    const projectId = getCurrentProjectId();
    const config = moduleSearchConfigs[module];
    const trimmed = searchText.trim();

    return useQuery({
        queryKey: qk.search(projectId, module, trimmed),
        queryFn: () => {
            // Never reached when `config` is undefined, or `trimmed` is
            // empty -- `enabled` below is false in both cases. The guard
            // only keeps this typesafe.
            if (!config) {
                return Promise.reject(new Error(`No search config for module ${module}`));
            }
            return config.search(trimmed);
        },
        enabled: Boolean(config) && trimmed.length > 0,
    });
}

export default useEntitySearch;
