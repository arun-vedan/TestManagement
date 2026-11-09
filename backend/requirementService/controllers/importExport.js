const {
  ErrorResponse,
  asyncHandler,
  createLogger,
  audit
} = require('@srckube/service-core');
const Requirement = require('../models/requirement');
const { csvToRecords } = require('../utils/csv');

const logger = createLogger('requirementService:importExport');

// WP-045 — CSV import for requirements.
//
// Mirror of backend/testRepoService/controllers/importExport.js -- see
// that file's header comment for the full ALL-OR-NOTHING partial-failure
// decision and field allow-list/tenant+lifecycle-bypass rationale, which
// applies identically here (same Sprint 2.1 lifecycle default, same WP-021
// projectId stamping, same lack of a replica-set-backed multi-document
// transaction to fall back on).
const ALLOWED_FIELDS = ['requirementSummary', 'requirementDescription', 'parentId'];
const REQUIRED_FIELDS = ['requirementSummary', 'requirementDescription'];
const MAX_ROWS = 5000;

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
  if (ext === '.xlsx' || ext === '.xls') {
    throw new ErrorResponse(
      'Excel workbook (.xlsx/.xls) import is not supported in this build. Save/export the sheet as CSV and import that instead.',
      400
    );
  }
  return uploaded;
}

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

// @desc  Dry-run a CSV import for requirements. Never writes anything.
// @route POST /api/v1/requirement/import/preview
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

// @desc  Commit a CSV import for requirements. Re-validates server-side;
//        all-or-nothing (see header comment).
// @route POST /api/v1/requirement/import/commit
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

  // Sequential -- see backend/testRepoService/controllers/importExport.js's
  // commitImport for why (models/requirement.js's pre-save hook has the
  // identical max-id-then-increment race if run concurrently).
  try {
    for (const row of report.rows) {
      const doc = new Requirement({
        ...row.data,
        projectId: req.projectScope.projectId, // WP-021: never from the file
        status: 'draft', // Sprint 2.1 lifecycle default for new work
        createdBy: user.sub,
        updatedBy: user.sub
      });
      await doc.save();
      created.push(doc);
    }
  } catch (err) {
    const insertedIds = created.map((d) => d._id);
    if (insertedIds.length > 0) {
      await Requirement.deleteMany({ _id: { $in: insertedIds } }).catch((cleanupErr) => {
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
    entityType: 'requirement',
    entityId: `import-batch-${Date.now()}`,
    action: 'import',
    after: {
      fileName: uploaded.name,
      count: created.length,
      reqIds: created.map((d) => d.reqId)
    }
  });
  for (const doc of created) {
    await audit(req, {
      entityType: 'requirement',
      entityId: doc.reqId,
      action: 'create',
      after: { reqId: doc.reqId, requirementSummary: doc.requirementSummary, importedFrom: uploaded.name }
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
