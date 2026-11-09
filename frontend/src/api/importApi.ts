import axiosPrivate from './axios';

// Wave C-1 (Register A3) -- CSV import for test cases (module 1 only; no
// other module has an import endpoint). The backend
// (backend/testRepoService/controllers/importExport.js, WP-045) was built
// with no UI ever wired to it -- this is the client for it, shaped against
// that controller read directly, not guessed:
//
//   - Both routes are multipart: a CSV file under the field name "file"
//     (requireCsvFile() accepts req.files.file OR req.files.upload; "file"
//     is used here) plus a "mapping" field. parseMapping() JSON.parse()s
//     that field server-side, so it must travel as a JSON *string* body
//     field (a FormData value can only be a string or a Blob -- there is no
//     nested-object form field), not a raw object.
//   - previewImport() always answers 200 -- it is a dry run; buildImportReport
//     never writes, and the per-row pass/fail lives in the response body,
//     not the HTTP status.
//   - commitImport() answers 201 with `{ imported, data }` when the whole
//     file is valid, or 422 with the SAME report shape (rows/summary/
//     ignoredColumns/willImport:0) when any row fails -- surfaced here as a
//     typed ImportPolicyError so a caller can read `.report` without
//     re-parsing an axios error shape itself, the same convention
//     api/bulkApi.ts's BulkPolicyError already established for the other
//     all-or-nothing endpoint pair in this app.
//
// ALLOWED_FIELDS/REQUIRED_FIELDS are mirrored (not imported -- the frontend
// cannot require() a backend controller file) from importExport.js's own
// top-of-file constants, so the mapping UI only ever offers targets the
// server will actually accept.
export const ALLOWED_FIELDS = ['TestCaseSummary', 'TestCaseDescription', 'parentId'] as const;
export const REQUIRED_FIELDS = ['TestCaseSummary', 'TestCaseDescription'] as const;

export type ImportTargetField = (typeof ALLOWED_FIELDS)[number];

/** csvHeader -> target field, or '' for "don't import this column". */
export type ImportMapping = Record<string, ImportTargetField | ''>;

export interface ImportRowReport {
  line: number;
  data: Record<string, unknown>;
  valid: boolean;
  errors: string[];
}

export interface ImportReportSummary {
  totalRows: number;
  validRows: number;
  invalidRows: number;
}

// Shared shape of previewImport's 200 body and commitImport's 422 body --
// buildImportReport() (backend) is the single source for both, so the two
// can never disagree about what is/isn't valid.
export interface ImportReport {
  success: boolean;
  policy: 'all-or-nothing';
  willImport: number;
  headers: string[];
  ignoredColumns: string[];
  summary: ImportReportSummary;
  rows: ImportRowReport[];
}

export interface ImportCommitSuccess {
  success: true;
  policy: 'all-or-nothing';
  imported: number;
  ignoredColumns: string[];
  data: unknown[];
}

// A 422 all-or-nothing rejection from commitImport -- mirrors
// api/bulkApi.ts's BulkPolicyError. Carries the full re-validated report
// (not just the message) so the UI can render the same per-row table it
// renders for a preview, rather than a generic failure banner.
export class ImportPolicyError extends Error {
  policy: 'all-or-nothing' = 'all-or-nothing';
  report: ImportReport;

  constructor(message: string, report: ImportReport) {
    super(message);
    this.name = 'ImportPolicyError';
    this.report = report;
  }
}

function buildFormData(file: File, mapping: ImportMapping): FormData {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('mapping', JSON.stringify(mapping));
  return formData;
}

export async function previewImport(file: File, mapping: ImportMapping): Promise<ImportReport> {
  const resp = await axiosPrivate.post('/api/v1/testrepo/import/preview', buildFormData(file, mapping));
  return resp.data;
}

export async function commitImport(file: File, mapping: ImportMapping): Promise<ImportCommitSuccess> {
  const resp = await axiosPrivate.post('/api/v1/testrepo/import/commit', buildFormData(file, mapping), {
    validateStatus: () => true,
  });
  if (resp.status === 422) {
    throw new ImportPolicyError(resp.data?.error || 'Import rejected: not every row was valid; nothing was imported', resp.data);
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(resp.data?.error || `Import failed (${resp.status})`);
  }
  return resp.data;
}
