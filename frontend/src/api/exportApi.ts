import { ModuleId } from '../workbench/modules';
import { EntityPage, FetchPageParams, fetchTestCasesPage, fetchDefectsPage, fetchRequirementsPage, fetchTestPlansPage, fetchTestExecutionsPage } from './entityGridApi';
import { buildCsv } from '../Components/Export/csvEncode';

// Wave C-2 (Register A3) -- CSV export, the other half of Wave C-1's CSV
// import (api/importApi.ts). No export endpoint exists anywhere in the
// backend (verified: every testRepoService/requirementService/etc route
// file was checked for one before writing this -- the ONLY CSV route
// anywhere is testRepoService's /import/preview and /import/commit,
// WP-045). Adding a backend export endpoint is explicitly out of this
// WP's scope (a separate backend WP, per the brief), so this builds the
// CSV client-side from data the existing paginated list APIs
// (api/entityGridApi.ts) already return -- no new dependency, following
// the same "hand-roll it, don't add a library for a well-understood
// format" precedent backend/testRepoService/utils/csv.js's WP-045 header
// comment set for parsing, applied here to encoding (see
// Components/Export/csvEncode.ts's own header comment).
//
// WHICH MODULES GET EXPORT: exactly the ones with a real paginated list
// fetcher in entityGridApi.ts -- 1 (test cases), 2 (requirements), 3 (test
// plans), 4 (test executions/"Test Runs"), 5 (defects). Module 6
// (releases) has no fetchReleasesPage there (entityListConfigs.tsx's own
// registry documents the same gap for its grid), so `exportConfigs` has no
// entry for it and getExportConfig(6) returns undefined -- CsvExportToolbar
// reads that as "don't render the action" rather than fabricating a call
// to an endpoint that doesn't exist.

// Mirrors backend/testRepoService/controllers/importExport.js's own
// MAX_ROWS (WP-045) -- same sanity ceiling, applied symmetrically to the
// export direction so a file this UI produces can always be re-imported
// without separately hitting the importer's own ceiling.
export const MAX_EXPORT_ROWS = 5000;

// Page size for the paging loop itself (independent of MAX_EXPORT_ROWS,
// which is the total-rows ceiling) -- large enough to keep the number of
// requests for a big module reasonable, small enough that a single page
// timing out doesn't waste much already-fetched work.
const EXPORT_PAGE_SIZE = 200;

export interface ExportColumn<T> {
  header: string;
  getValue: (row: T) => unknown;
}

export interface ExportConfig<T = any> {
  /** Used to build the downloaded filename, e.g. "testcases". */
  entityLabel: string;
  fetchPage: (params: FetchPageParams) => Promise<EntityPage<T>>;
  columns: ExportColumn<T>[];
  /** Shown in the UI when this module's export round-trips with an importer. */
  roundTripNote?: string;
}

// Module 1 (Test Cases) -- these header names are not stylistic choices:
// TestCaseSummary / TestCaseDescription / parentId are byte-for-byte
// api/importApi.ts's own ALLOWED_FIELDS, mirrored (per that file's header
// comment) from backend/testRepoService/controllers/importExport.js's
// WP-045 constants. Exporting under these exact names means a file
// produced here can be edited in a spreadsheet and fed straight back into
// "Import CSV" (CsvImportToolbar.tsx) without renaming a single column.
//
// TestCaseId is added as a leading, human-readable extra column. Verified
// (by reading importExport.js's buildImportReport() directly, not
// assumed) that an extra column the user never maps to anything is simply
// never read: buildImportReport() only ever iterates
// `Object.entries(mapping)` -- the client-built { csvHeader: targetField }
// object -- to construct each row's document, so a header with no entry
// in that object (which is exactly what an untouched dropdown in
// CsvImportDialog produces, since its `mapping` state starts at `{}` and
// only gains a key when the user explicitly picks a target for that
// header) contributes nothing and triggers no error. The one validation
// that inspects headers at all (`unknownHeaders`, importExport.js line
// ~87) checks the OPPOSITE direction -- that every key already IN the
// mapping still exists in the file -- and never rejects a file header for
// simply not appearing in the mapping. So TestCaseId survives round-trip
// in the file but is inert on re-import, exactly like this UI says.
const testCaseExportConfig: ExportConfig = {
  entityLabel: 'testcases',
  fetchPage: fetchTestCasesPage,
  columns: [
    { header: 'TestCaseId', getValue: (r: any) => r.TestCaseId },
    { header: 'TestCaseSummary', getValue: (r: any) => r.TestCaseSummary },
    { header: 'TestCaseDescription', getValue: (r: any) => r.TestCaseDescription },
    { header: 'parentId', getValue: (r: any) => r.parentId },
  ],
  roundTripNote:
    'Columns match the CSV importer exactly, so this file can be edited and re-imported via Import CSV. The extra TestCaseId column is for reference only -- the importer ignores any column not explicitly mapped.',
};

// Modules 2-5 have no import counterpart (Wave C-1 built import for test
// cases only -- see importApi.ts's header comment), so there is no
// exact-header-name contract to honor here. Columns mirror the same real,
// already-verified-live fields workbench/list/entityListConfigs.tsx's own
// grid configs use for these modules, rather than fabricating new ones.
const requirementExportConfig: ExportConfig = {
  entityLabel: 'requirements',
  fetchPage: fetchRequirementsPage,
  columns: [
    { header: 'reqId', getValue: (r: any) => r.reqId },
    { header: 'requirementSummary', getValue: (r: any) => r.requirementSummary },
    { header: 'status', getValue: (r: any) => r.status },
    { header: 'updatedAt', getValue: (r: any) => r.updatedAt },
  ],
};

const testPlanExportConfig: ExportConfig = {
  entityLabel: 'testplans',
  fetchPage: fetchTestPlansPage,
  columns: [
    { header: 'TestPlanId', getValue: (r: any) => r.TestPlanId },
    // entityListConfigs.tsx's own comment: the live row shape has no
    // name/summary field at all, only TestPlanId and a TestCases array --
    // a derived count is the only honest second column, same call made
    // there.
    { header: 'testCaseCount', getValue: (r: any) => (Array.isArray(r.TestCases) ? r.TestCases.length : 0) },
    { header: 'updatedAt', getValue: (r: any) => r.updatedAt },
  ],
};

const testExecutionExportConfig: ExportConfig = {
  entityLabel: 'testruns',
  fetchPage: fetchTestExecutionsPage,
  columns: [
    { header: 'TestExecutionId', getValue: (r: any) => r.TestExecutionId },
    { header: 'TestPlanId', getValue: (r: any) => r.TestPlanId },
    { header: 'assignedTo', getValue: (r: any) => r.assignedTo },
    { header: 'updatedAt', getValue: (r: any) => r.updatedAt },
  ],
};

const defectExportConfig: ExportConfig = {
  entityLabel: 'defects',
  fetchPage: fetchDefectsPage,
  columns: [
    { header: 'defectId', getValue: (r: any) => r.defectId },
    { header: 'summary', getValue: (r: any) => r.summary },
    { header: 'Severity', getValue: (r: any) => r.Severity },
    { header: 'Status', getValue: (r: any) => r.Status },
    { header: 'assignedTo', getValue: (r: any) => r.assignedTo },
    { header: 'updatedAt', getValue: (r: any) => r.updatedAt },
  ],
};

export const exportConfigs: Partial<Record<ModuleId, ExportConfig>> = {
  1: testCaseExportConfig,
  2: requirementExportConfig,
  3: testPlanExportConfig,
  4: testExecutionExportConfig,
  5: defectExportConfig,
  // 6: no entry -- see header comment.
};

export function getExportConfig(moduleId: ModuleId): ExportConfig | undefined {
  return exportConfigs[moduleId];
}

// A failure partway through paging must surface as an error, never as a
// download of whatever rows happened to be fetched before the failure --
// a partial CSV with no indication it's partial is worse than no file at
// all. Named distinctly from a plain Error so callers (CsvExportToolbar)
// can tell "the fetch itself failed" apart from any other failure mode
// without string-matching a message.
export class ExportPagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportPagingError';
  }
}

/**
 * Pages through an entityGridApi.ts fetcher from the start, accumulating
 * every row, up to MAX_EXPORT_ROWS (mirrors the importer's own MAX_ROWS
 * ceiling, api/importApi.ts / importExport.js). Stops early (never
 * fabricating a partial page) if a page comes back empty even though
 * `hasNextPage` claimed otherwise, to avoid ever looping forever against a
 * misbehaving backend.
 */
export async function fetchAllRowsForExport<T>(
  fetchPage: (params: FetchPageParams) => Promise<EntityPage<T>>
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  let page = 0;
  let hasNextPage = true;

  while (hasNextPage && rows.length < MAX_EXPORT_ROWS) {
    let result: EntityPage<T>;
    try {
      // eslint-disable-next-line no-await-in-loop -- pages must be fetched
      // sequentially: each one's request depends on knowing whether the
      // previous page said there was a next one at all.
      result = await fetchPage({ page, pageSize: EXPORT_PAGE_SIZE });
    } catch (err) {
      throw new ExportPagingError(
        `Export failed while fetching page ${page + 1} (${rows.length} row(s) already fetched, none of them downloaded): ${
          (err as Error)?.message || 'unknown error'
        }`
      );
    }
    if (!result.rows || result.rows.length === 0) {
      break;
    }
    rows.push(...result.rows);
    hasNextPage = result.hasNextPage;
    page += 1;
  }

  const truncated = hasNextPage && rows.length >= MAX_EXPORT_ROWS;
  return { rows: truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows, truncated };
}

export function rowsToCsv<T>(columns: ExportColumn<T>[], rows: T[]): string {
  const headers = columns.map((c) => c.header);
  const body = rows.map((row) => columns.map((c) => c.getValue(row)));
  return buildCsv(headers, body);
}

/** Triggers a real browser download of `content`, then revokes the object URL. */
export function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** e.g. "testcases-project1-2026-09-05.csv" -- module + project + date, as asked. */
export function buildExportFilename(entityLabel: string, projectId: number, now: Date = new Date()): string {
  const iso = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return `${entityLabel}-project${projectId}-${iso}.csv`;
}
