// WP-045 — dependency-free CSV parser (RFC 4180-ish).
//
// Identical to backend/testRepoService/utils/csv.js -- see that file's
// header comment for the full "why no new dependency" rationale (applies
// verbatim here). Kept as a separate copy rather than a shared module
// because the WP-045 scope is explicitly testRepoService +
// requirementService only, and backend/shared/service-core/ is off-limits
// for this WP -- there is no shared home to put a cross-service utility
// this small without touching code outside this WP's boundary.
//
// parseCSV(text) -> [{ line: number, fields: string[] }, ...]
function parseCSV(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseCSV expects a string');
  }
  if (text.length && text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1); // strip UTF-8 BOM (common from Excel "Save as CSV")
  }

  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push({ line: rowStartLine, fields: row });
    row = [];
    rowStartLine = line + 1;
  };

  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (c === '\n') {
        line += 1;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      endRow();
      line += 1;
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }

  if (field !== '' || row.length > 0) {
    endRow();
  }

  return rows;
}

function csvToRecords(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) {
    return { headers: [], records: [] };
  }
  const headers = rows[0].fields.map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = r.fields[idx] !== undefined ? r.fields[idx] : '';
    });
    return { line: r.line, values: obj };
  });
  return { headers, records };
}

function stringifyCSV(headers, rows) {
  const escapeField = (value) => {
    const s = value === undefined || value === null ? '' : String(value);
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeField(row[h])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { parseCSV, csvToRecords, stringifyCSV };
