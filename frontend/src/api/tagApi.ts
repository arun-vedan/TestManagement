import { queryClient } from '../queryClient';
import { ModuleId } from '../workbench/modules';

// WP-F05b (Task 2) -- tag suggestions for the TagsSection editor.
//
// There is no "list all tags" endpoint, and per this WP's own dispatch this
// package does not add one -- a thin suggestion list is not worth a new
// route, and no suggestions at all is an acceptable first cut. Instead this
// reads whatever rows the workbench's own module list view (<EntityList>,
// workbench/list/EntityList.tsx) has already fetched into the app's single
// shared QueryClient (queryClient.ts, one instance for the whole app --
// verified by reading both files). That view's query key is
// `['entityList', module, paginationModel, sortModel, extraParams]`;
// `getQueriesData` with the two-element prefix below does a partial-key
// match (query-core's own `matchQuery`/`partialMatchKey`, `exact` unset),
// so it finds every cached page for this module regardless of which
// pagination/sort/saved-view state produced it -- without EntityList or
// TagsSection needing to know about each other beyond this shared cache.
//
// HONEST LIMITATION: this only ever sees tags on rows the list view has
// actually paged through, and only while they're still in cache (the
// client's default gcTime -- 5 minutes unmounted, queryClient.ts does not
// override it). It is not a project-wide "every tag ever used" index. If
// the list has never been opened this session, or its cache has expired,
// this resolves to [] -- TagsSection's input still works fine with no
// suggestions offered, which is the documented fallback for exactly this
// case.
export async function getProjectTags(module: ModuleId): Promise<string[]> {
  const cachedLists = queryClient.getQueriesData<{ rows?: Array<Record<string, unknown>> }>({
    queryKey: ['entityList', module],
  });

  const seen = new Set<string>();
  for (const [, data] of cachedLists) {
    for (const row of data?.rows ?? []) {
      const rowTags = row?.tags;
      if (!Array.isArray(rowTags)) continue;
      for (const tag of rowTags) {
        if (typeof tag === 'string' && tag) seen.add(tag);
      }
    }
  }
  return Array.from(seen).sort();
}

export default getProjectTags;
