// WP-045 — dependency-free CSV parser (RFC 4180-ish).
//
// Built in-house rather than adding a new npm dependency (e.g. csv-parse):
// this sandboxed dev environment cannot reliably reach the npm registry to
// `npm install` a new backend dependency, and the WP-045 design direction
// already steers away from new dependencies on the frontend for the same
// class of job ("if CSV parsing needs a library on the frontend, prefer
// doing it server-side instead") -- extending that same bias to the
// backend keeps the surface small, fully self-tested, and avoids a
// supply-chain addition for what is, in the end, a well-understood format.
//
// Handles: quoted fields, embedded commas/newlines inside quotes, escaped
// quotes (""), CRLF and LF line endings, and a leading UTF-8 BOM. Tracks
// the physical source line each record STARTS on (1-indexed, header row is
// line 1) so callers can report "bad row on line N" against what a user
// would see opening the file in a text editor or spreadsheet app.
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
      i += 1; // swallow; a following \n (or none, old Mac line endings) handles the row end
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

  // Trailing content with no final newline.
  if (field !== '' || row.length > 0) {
    endRow();
  }

  return rows;
}

// Builds an array of plain objects keyed by the header row, alongside the
// original source line number for each data row. Duplicate headers are not
// supported (last one wins if present) -- not a real-world case worth
// complicating the mapping UI for.
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

// Minimal RFC 4180 writer, used only by this WP's own verification tooling
// (the shipped export path is client-side in the frontend, per the WP-045
// design direction) -- kept here so the export/import shapes are provably
// symmetric against the exact same escaping rules.
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
