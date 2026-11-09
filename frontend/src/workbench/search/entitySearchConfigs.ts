import { ModuleId } from '../modules';
import { getWCTCList, getWCReqList, getWCDefectList, getWCPlanList, getWCRunList } from '../../api/apiCalls';

// Wave B-2 (workbench search) — module-config registry EntitySearchPanel
// reads from, mirroring entityListConfigs.ts's own "this module supports
// X, that one doesn't" shape.
//
// HONEST COVERAGE: five backend wildcard-search routes exist, each
// verified by reading the controller directly (not assumed from a
// helper's name) --
//   testRepoService            -> GET /api/v1/testrepo/wildcardsearch       (module 1)
//   requirementService         -> GET /api/v1/requirement/wildcardsearch    (module 2)
//   testPlanExecutionService   -> GET /api/v1/testplan/wildcardsearch       (module 3)
//   testPlanExecutionService   -> GET /api/v1/testexecution/wildcardsearch  (module 4)
//   defectService              -> GET /api/v1/defects/wildcardsearch        (module 5)
// each scoped by keycloak.protect() -> requireProjectScope() ->
// authorize('read'), each returning `{ success, data: <raw documents> }` --
// but NOT all searching the same shape of field(s):
//   modules 1, 2, 5  -> Mongoose `.find()`-ing an `$or` of a regex on the
//                       entity's id field and its summary field.
//   module 3         -> same `$or` shape, but TestPlan has no summary
//                       field, so its second field is `objective` instead.
//   module 4         -> no `$or` at all -- a single regex on TestExecutionId
//                       only. TestExecution has no summary/objective-style
//                       field, and its one other string, `assignedTo`, is a
//                       raw Keycloak subject UUID rather than a name
//                       (confirmed against live data), so it is
//                       deliberately not searched either.
//
// Module 6 (releases) has no entry: no wildcardsearch route exists in
// releaseService, same as entityListConfigs.ts leaves module 6 out.
// EntitySearchPanel reads that absence as "search is not available for
// this module yet" and says so, rather than faking search by filtering a
// fetched page (which would silently only search whatever page happened
// to be loaded) or inventing a backend route that does not exist.
//
// Frontend helpers already existed in api/apiCalls.tsx (getWCTCList/
// getWCReqList/getWCDefectList) -- their response shape was confirmed by
// reading them (they resolve `axiosPrivate.get(...).data.data`, i.e. the
// raw array of Mongoose documents above) AND by reading their one existing
// consumer, Components/Lists/issueSearch.tsx (DynamicAutocomplete), which
// already reads `.TestCaseId`/`.TestCaseSummary`, `.reqId`/
// `.requirementSummary`, `.defectId`/`.summary` off those same arrays.
// getWCPlanList and getWCRunList (WP-F01) were added the same way, and
// verified against live data before being wired in here.

export interface SearchResultItem {
    /** Business key -- e.g. "TC-104" / "REQ-8" / "DEF-3". Used as both the
     *  React key and the entityId passed to openTab/setSelection, exactly
     *  like EntityTree's leaf nodes (see useTreeChildren.ts's fetchLeaves). */
    id: string;
    /** Tab title. Deliberately just the id, matching every other openTab
     *  call site in this codebase (EntityTree.tsx, TestPlanDetail.tsx) --
     *  none of them title a tab with the entity's summary. */
    title: string;
    /** Shown alongside the id in the results list so a search actually
     *  helps a user tell two ids apart; never used as the tab title. */
    summary: string;
}

export interface EntitySearchConfig {
    entityLabelPlural: string;
    search: (searchText: string) => Promise<SearchResultItem[]>;
}

const testCaseSearchConfig: EntitySearchConfig = {
    entityLabelPlural: 'test cases',
    search: async (searchText) => {
        const rows = (await getWCTCList(searchText)) as Array<{ TestCaseId: string | number; TestCaseSummary?: string }>;
        return rows.map((row) => ({
            id: String(row.TestCaseId),
            title: String(row.TestCaseId),
            summary: row.TestCaseSummary ?? '',
        }));
    },
};

const requirementSearchConfig: EntitySearchConfig = {
    entityLabelPlural: 'requirements',
    search: async (searchText) => {
        const rows = (await getWCReqList(searchText)) as Array<{ reqId: string | number; requirementSummary?: string }>;
        return rows.map((row) => ({
            id: String(row.reqId),
            title: String(row.reqId),
            summary: row.requirementSummary ?? '',
        }));
    },
};

const defectSearchConfig: EntitySearchConfig = {
    entityLabelPlural: 'defects',
    search: async (searchText) => {
        const rows = (await getWCDefectList(searchText)) as Array<{ defectId: string | number; summary?: string }>;
        return rows.map((row) => ({
            id: String(row.defectId),
            title: String(row.defectId),
            summary: row.summary ?? '',
        }));
    },
};

const testPlanSearchConfig: EntitySearchConfig = {
    entityLabelPlural: 'test plans',
    search: async (searchText) => {
        const rows = (await getWCPlanList(searchText)) as Array<{ TestPlanId: string | number; objective?: string }>;
        return rows.map((row) => ({
            id: String(row.TestPlanId),
            title: String(row.TestPlanId),
            summary: row.objective ?? '',
        }));
    },
};

// A test run has no human-readable text of its own. TestExecution's only
// top-level strings are TestExecutionId, assignedTo, source and ciRunUrl,
// and assignedTo holds a raw Keycloak subject UUID rather than a name
// (confirmed against live data), so there is nothing to show beside the
// id. The summary is deliberately empty rather than filled with an
// identifier a reader cannot use. Giving a run a name of its own is
// WP-F09.
const testRunSearchConfig: EntitySearchConfig = {
    entityLabelPlural: 'test runs',
    search: async (searchText) => {
        const rows = (await getWCRunList(searchText)) as Array<{ TestExecutionId: string | number }>;
        return rows.map((row) => ({
            id: String(row.TestExecutionId),
            title: String(row.TestExecutionId),
            summary: '',
        }));
    },
};

// Backend coverage (modules 1-5, module 6 deliberately absent) is the
// "HONEST COVERAGE" block at the top of this file -- not repeated here to
// avoid the two going stale independently of each other.
export const moduleSearchConfigs: Record<ModuleId, EntitySearchConfig | undefined> = {
    1: testCaseSearchConfig,
    2: requirementSearchConfig,
    3: testPlanSearchConfig,
    4: testRunSearchConfig,
    5: defectSearchConfig,
    6: undefined,
};

export default moduleSearchConfigs;
