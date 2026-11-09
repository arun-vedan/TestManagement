import { QueryClient } from '@tanstack/react-query';

// WP-015: single shared QueryClient for the whole app, instantiated once at
// module scope (not inside App()) so it survives route changes -- App.tsx
// mounts <BrowserRouter> *inside* the QueryClientProvider, and the four core
// pages (testrepo/requirements/defects/testexecution) are swapped in and out
// by <Routes> as the user navigates. A client created inside the component
// body would be fine too (React only calls the component function once
// across re-renders of the same mounted tree), but hoisting it here makes it
// explicit that navigating away and back must not lose the cache -- that's
// exactly the "serves cached data then revalidates" behavior WP-015 asks
// for on revisit.
//
// Defaults are deliberately conservative rather than react-query's
// aggressive-by-default stance:
//   - staleTime: 30s. Keeps a quick back-and-forth between the workbench's
//     modules/tabs from re-fetching on every single remount while still
//     revalidating on any longer revisit.
//
//   WP-071/WP-078 update: refetchOnWindowFocus/refetchOnReconnect used to
//   stay `false` because the four legacy pages (requirements.tsx/
//   testcases.tsx/defects.tsx/testExecution.tsx) each built a mutable local
//   copy of the tree (`useState` + `useEffect(() => setObjects(...))`,
//   mutated directly by drag/drop and local "new draft" tab rows,
//   bypassing the query cache) that a background refetch landing mid-drag
//   would silently clobber. WP-074 through WP-077 deleted all four pages
//   in favour of the workbench, whose tree (Hooks/queries/
//   useTreeChildren.ts, keyed by Hooks/queryKeys.ts's `qk.children`) reads
//   the query cache directly -- there is no local array left for a
//   background refetch to overwrite, so WP-078 (the teardown that removes
//   the last of those pages' supporting code) flips both flags back to
//   react-query's normal `true`. A window-focus/reconnect refetch now just
//   revalidates the same cache the tree already renders from.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 1,
    },
  },
});
