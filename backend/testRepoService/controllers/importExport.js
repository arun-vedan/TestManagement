const {
  ErrorResponse,
  asyncHandler,
  createLogger,
  audit
} = require('@srckube/service-core');
const TestCase = require('../models/testrepo');
const { csvToRecords } = require('../utils/csv');

const logger = createLogger('testRepoService:importExport');

// WP-045 — CSV import for test cases.
//
// PARTIAL-VS-ALL-OR-NOTHING DECISION (stated explicitly, per the WP brief):
// ALL-OR-NOTHING. If any row in the file fails validation, the ENTIRE
// commit is rejected and NOTHING is written -- not even the rows that
// would have passed. Justification:
//   1. It is the safer, easier-to-reason-about option the WP brief itself
//      names as the "safer and easier to reason about" default, and this
//      service has no multi-document transaction available to fall back
//      on for a true rollback (the dev Mongo here is a standalone
//      instance, not a replica set -- Mongoose/MongoDB multi-document
//      transactions require one), so "reject unless 100% clean" is also
//      the only option that can make an atomicity guarantee without a
//      compensating-delete dance across partially-inserted documents.
//   2. It matches the workflow the dry-run preview is built to support:
//      preview shows every bad row with its real source line number, the
//      user fixes the file (or the mapping) and re-previews, and only
//      commits once the preview is 100% clean. A partial import would
//      leave the user reconciling which 197 of 200 rows actually landed
//      against a file that still shows 200 -- exactly the confusion this
//      WP's hard-part note warns against.
// commitImport() re-validates the ENTIRE file itself (never trusts a
// separate "preview was clean" flag from the client) and refuses to write
// anything unless every row passes.
//
// FIELD ALLOW-LIST / TENANT + LIFECYCLE BYPASS PREVENTION: only these
// target fields can be set via import. Anything else a column is mapped to
// (a caller could point a CSV column at "projectId", "status",
// "TestCaseId", "id", "version", "createdBy", "updatedBy", "_id" -- all of
// them plausible column names in an exported file) is silently DROPPED
// from the row's constructed document, never applied, and reported back in
// `ignoredColumns` for transparency. projectId is ALWAYS stamped from
// req.projectScope.projectId (verified tenant membership, WP-021) exactly
// like createTestCase does; status is ALWAYS 'draft' (Sprint 2.1 lifecycle
// default for brand-new work -- imported rows are new work, not
// pre-approved by virtue of being bulk-created); TestCaseId/id/version are
// always server-generated (models/testrepo.js's pre-save hook, Sprint 2.1
// versioning). A CSV column named "projectId" or "status" therefore cannot
// override the caller's project or pre-approve an imported row -- proven
// in EXECUTION_LOG.md's WP-045 report by importing a file with such a
// column and reading the created documents back.
const ALLOWED_FIELDS = ['TestCaseSummary', 'TestCaseDescription', 'parentId'];
const REQUIRED_FIELDS = ['TestCaseSummary', 'TestCaseDescription'];
const MAX_ROWS = 5000; // sanity ceiling, not exercised by the WP-045 200-row acceptance run

function parseMapping(rawMapping) {
  if (!rawMapping) {
    throw new ErrorResponse('Missing required "mapping" field (JSON object of csvHeader -> targetField)', 400);
  }
  let mapping;
  try {
    mapping = typeof rawMapping === 'string' ? JSON.parse(rawMapping) : rawMapping;
  } catch (e) {
    throw new ErrorResponse('mapping must be valid JSON', 400);
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new ErrorResponse('mapping must be a JSON object of { csvHeader: targetField }', 400);
  }
  return mapping;
}

function requireCsvFile(req) {
  const uploaded = req.files && (req.files.file || req.files.upload);
  if (!uploaded) {
    throw new ErrorResponse('Missing uploaded file (multipart field name "file")', 400);
  }
  const name = String(uploaded.name || '');
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  // Excel (.xlsx/.xls) is explicitly out of scope for this WP -- a binary
  // workbook parser is a new dependency this environment cannot reliably
  // `npm install` (no verified registry egress), and CSV is the universal,
  // already-supported interchange format every spreadsheet tool (including
  // Excel) can save to. See EXECUTION_LOG.md's WP-045 report for the full
  // reasoning. Rejected here with a clear, actionable message rather than
  // silently mis-parsing binary content as text.
  if (ext === '.xlsx' || ext === '.xls') {
    throw new ErrorResponse(
      'Excel workbook (.xlsx/.xls) import is not supported in this build. Save/export the sheet as CSV and import that instead.',
      400
    );
  }
  return uploaded;
}

// Builds the mapped, validated view of every data row in the file. Never
// writes anything -- shared by both previewImport and commitImport so the
// two can never disagree about what is/isn't valid.
function buildImportReport(fileBuffer, mapping) {
  const text = fileBuffer.toString('utf8');
  const { headers, records } = csvToRecords(text);

  if (headers.length === 0) {
    throw new ErrorResponse('CSV file has no header row', 400);
  }

  const mappingHeaders = Object.keys(mapping);
  const unknownHeaders = mappingHeaders.filter((h) => !headers.includes(h));
  if (unknownHeaders.length > 0) {
    throw new ErrorResponse(
      `mapping references column(s) not present in the file header row: ${unknownHeaders.join(', ')}`,
      400
    );
  }

  const ignoredColumns = new Set();
  const mappedTargets = new Set();
  for (const target of Object.values(mapping)) {
    if (!target || target === '__ignore__') continue;
    if (ALLOWED_FIELDS.includes(target)) {
      mappedTargets.add(target);
    } else {
      ignoredColumns.add(target);
    }
  }

  const missingRequired = REQUIRED_FIELDS.filter((f) => !mappedTargets.has(f));
  if (missingRequired.length > 0) {
    throw new ErrorResponse(
      `mapping is missing required target field(s): ${missingRequired.join(', ')}`,
      400
    );
  }

  if (records.length === 0) {
    throw new ErrorResponse('CSV file has a header row but no data rows', 400);
  }
  if (records.length > MAX_ROWS) {
    throw new ErrorResponse(`CSV file has ${records.length} data rows, exceeding the ${MAX_ROWS}-row import ceiling`, 400);
  }

  const rows = records.map(({ line, values }) => {
    const data = {};
    for (const [csvHeader, target] of Object.entries(mapping)) {
      if (!target || target === '__ignore__' || !ALLOWED_FIELDS.includes(target)) continue;
      data[target] = (values[csvHeader] || '').trim();
    }

    const errors = [];
    for (const f of REQUIRED_FIELDS) {
      if (!data[f]) {
        errors.push(`${f} is required`);
      }
    }
    if (data.parentId !== undefined && data.parentId !== '') {
      const n = Number(data.parentId);
      if (!Number.isFinite(n)) {
        errors.push('parentId must be a number');
      } else {
        data.parentId = n;
      }
    } else {
      delete data.parentId;
    }

    return { line, data, valid: errors.length === 0, errors };
  });

  const validRows = rows.filter((r) => r.valid).length;
  const invalidRows = rows.length - validRows;

  return {
    headers,
    ignoredColumns: Array.from(ignoredColumns),
    summary: {
      totalRows: rows.length,
      validRows,
      invalidRows
    },
    rows
  };
}

// @desc  Dry-run a CSV import: parse, apply the column mapping, validate
//        every row, and report per-row pass/fail with source line numbers.
//        Never writes anything.
// @route POST /api/v1/testrepo/import/preview
// @access Private (write)
exports.previewImport = asyncHandler(async (req, res) => {
  const uploaded = requireCsvFile(req);
  const mapping = parseMapping(req.body.mapping);
  const report = buildImportReport(uploaded.data, mapping);

  res.status(200).json({
    success: true,
    policy: 'all-or-nothing',
    willImport: report.summary.invalidRows === 0 ? report.summary.validRows : 0,
    ...report
  });
});

// @desc  Commit a CSV import. Re-validates the whole file server-side
//        (never trusts a client-reported "preview was clean"); if every
//        row is valid, creates them all as `status: 'draft'` test cases
//        scoped to the caller's project. If ANY row is invalid, writes
//        NOTHING and returns the same per-row report (422).
// @route POST /api/v1/testrepo/import/commit
// @access Private (write)
exports.commitImport = asyncHandler(async (req, res) => {
  const uploaded = requireCsvFile(req);
  const mapping = parseMapping(req.body.mapping);
  const report = buildImportReport(uploaded.data, mapping);

  if (report.summary.invalidRows > 0) {
    logger.info('import commit rejected: file has invalid rows, nothing written', {
      correlationId: req.correlationId,
      projectId: req.projectScope.projectId,
      invalidRows: report.summary.invalidRows,
      totalRows: report.summary.totalRows
    });
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: `${report.summary.invalidRows} of ${report.summary.totalRows} row(s) failed validation; nothing was imported`,
      willImport: 0,
      ...report
    });
  }

  const user = req.kauth.grant.access_token.content;
  const created = [];

  // Sequential, not Promise.all/insertMany: models/testrepo.js's pre-save
  // hook assigns `id`/`TestCaseId` by reading the current max id and adding
  // 1 (findOne().sort({id:-1})) -- the exact same pattern createTestCase
  // already relies on for a single create. Running 200 of these
  // concurrently would race on that read, so each row's save() is awaited
  // before starting the next, exactly reproducing what would happen if a
  // user created these one at a time through the normal endpoint.
  try {
    for (const row of report.rows) {
      const doc = new TestCase({
        ...row.data,
        projectId: req.projectScope.projectId, // WP-021: never from the file, always the verified caller scope
        status: 'draft', // Sprint 2.1 lifecycle: imported rows are new work, never pre-approved
        createdBy: user.sub,
        updatedBy: user.sub
      });
      await doc.save();
      created.push(doc);
    }
  } catch (err) {
    // Compensating rollback: this should be unreachable in practice (every
    // row already passed schema validation above), but if the DB itself
    // fails partway through the sequential loop, delete whatever this
    // import batch already inserted so the all-or-nothing guarantee holds
    // even in that failure mode -- never leave a partial batch behind that
    // the file's own preview did not promise.
    const insertedIds = created.map((d) => d._id);
    if (insertedIds.length > 0) {
      await TestCase.deleteMany({ _id: { $in: insertedIds } }).catch((cleanupErr) => {
        logger.error('import commit: DB error mid-batch AND compensating rollback failed', {
          correlationId: req.correlationId,
          error: err.message,
          cleanupError: cleanupErr.message,
          partiallyInsertedIds: insertedIds.map(String)
        });
      });
    }
    throw new ErrorResponse(`Import failed while writing row ${created.length + 1}: ${err.message}`, 500);
  }

  await audit(req, {
    entityType: 'testcase',
    entityId: `import-batch-${Date.now()}`,
    action: 'import',
    after: {
      fileName: uploaded.name,
      count: created.length,
      testCaseIds: created.map((d) => d.TestCaseId)
    }
  });
  for (const doc of created) {
    await audit(req, {
      entityType: 'testcase',
      entityId: doc.TestCaseId,
      action: 'create',
      after: { TestCaseId: doc.TestCaseId, TestCaseSummary: doc.TestCaseSummary, importedFrom: uploaded.name }
    });
  }

  logger.info('import commit succeeded', {
    correlationId: req.correlationId,
    projectId: req.projectScope.projectId,
    imported: created.length
  });

  res.status(201).json({
    success: true,
    policy: 'all-or-nothing',
    imported: created.length,
    ignoredColumns: report.ignoredColumns,
    data: created
  });
});

module.exports.ALLOWED_FIELDS = ALLOWED_FIELDS;
module.exports.REQUIRED_FIELDS = REQUIRED_FIELDS;
