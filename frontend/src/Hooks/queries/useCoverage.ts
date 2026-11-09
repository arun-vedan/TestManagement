import { useQuery, useQueryClient, UseQueryResult } from '@tanstack/react-query';
import { getUntestedRequirements, getOrphanTestCases } from '../../api/linkApi';
import { qk } from '../queryKeys';

// WP-075a -- src/Hooks/queries/useCoverage.ts did NOT exist: WP-075's own
// plan named this file in Task 2's file list but no step actually
// implemented it, and WP-071 shipped without it. This is the workbench
// (react-query) replacement for Context/CoverageContext.tsx's untested-
// requirements value, plus the sibling orphan-test-cases endpoint
// (api/linkApi.ts's getOrphanTestCases -- already existed, had no
// consumer here either) for the same reason RequirementDetail needs a
// coverage read that isn't tied to a <CoverageProvider>.
//
// WP-078 -- LinkIssue/linkissue.tsx, LinkIssue/LinkTypeBadge.tsx and
// LinkIssue/CoveragePanel.tsx (the last of which has never had a
// route/consumer of its own) are migrated onto this hook, and
// Components/Tabs/TabContent.tsx (the last consumer that read
// CoverageContext directly, e.g. TestExecutionContent-era pages) is
// deleted. Context/CoverageContext.tsx itself is NOT deleted, though:
// Components/folderStructure/CustomNode.tsx still imports it, and that
// whole chain (editor -> objectRepo -> folderStructure) is pre-existing
// dead code with no route, out of scope for this WP to touch (see
// EXECUTION_LOG.md's WP-078 report). CoverageContext.tsx stays in the tree
// purely so that already-orphaned chain keeps compiling.

export interface CoverageData {
  untestedReqIds: Set<string>;
  orphanTestCaseIds: Set<string>;
}

export interface UseCoverageResult {
  /**
   * reqIds with no requirement<->test-case link at all (any linkType,
   * either direction -- WP-F13 final fix round, Finding 2: this used to be
   * gated on `linkType: 'tests'` specifically, the same wrong rule
   * reportingService/services/coverage.js was fixed away from, and it made
   * this same set disagree with the reports page's traceability matrix).
   * Same set CoverageContext's untestedReqIds exposed.
   */
  untestedReqIds: Set<string>;
  /** TestCaseIds with no requirement<->test-case link at all, any linkType, either direction (api/linkApi.ts's orphan-testcases endpoint). */
  orphanTestCaseIds: Set<string>;
  /** True until the first successful fetch -- mirrors CoverageContext's `loading`. */
  loading: boolean;
  isError: boolean;
  /** Re-fetches both coverage sets. The replacement for CoverageContext's refreshUntested(): call after any linkType/duplicate-link change that could affect either set. */
  invalidate: () => Promise<void>;
}

export function useCoverage(projectId: number): UseCoverageResult {
  const queryClient = useQueryClient();

  const query: UseQueryResult<CoverageData> = useQuery({
    queryKey: qk.coverage(projectId),
    queryFn: async (): Promise<CoverageData> => {
      const [untested, orphans] = await Promise.all([
        getUntestedRequirements(),
        getOrphanTestCases(),
      ]);
      return {
        untestedReqIds: new Set(untested.map((r) => r.reqId)),
        orphanTestCaseIds: new Set(orphans.map((o) => o.TestCaseId)),
      };
    },
  });

  return {
    untestedReqIds: query.data?.untestedReqIds ?? new Set<string>(),
    orphanTestCaseIds: query.data?.orphanTestCaseIds ?? new Set<string>(),
    loading: query.isLoading,
    isError: query.isError,
    invalidate: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.coverage(projectId) });
    },
  };
}

export default useCoverage;
