// Wave C-1 (Register A3) -- client-side header detection for the CSV
// import mapping step. The mapping UI needs the file's real column names
// BEFORE it can call POST /import/preview (the mapping body it sends is
// built FROM those headers), so something has to read them client-side.
//
// This is a direct, deliberately trimmed port of the same row-tokenising
// algorithm backend/testRepoService/utils/csv.js's parseCSV() uses (quoted
// fields, embedded commas/newlines-in-quotes, escaped "" quotes, CRLF/LF,
// a leading UTF-8 BOM) -- not a new dependency. The WP-045 design
// direction is explicit that CSV parsing work should stay server-side
// where possible; this only goes as far as extracting the header ROW so the
// user can build a mapping, and never attempts to parse data rows or
// validate anything itself -- that stays exactly buildImportReport()'s job,
// via the real preview/commit calls.
export function parseCsvHeaderRow(text: string): string[] {
  if (text.length && text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    fields.push(field);
    field = '';
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
      endField();
      return fields.map((h) => h.trim());
    }
    field += c;
    i += 1;
  }

  // No trailing newline (a header-only file, or a file with no final
  // line break) -- whatever was accumulated is still the header row.
  if (field !== '' || fields.length > 0) {
    endField();
  }
  return fields.map((h) => h.trim());
}

export function readCsvHeaders(file: File): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      resolve(parseCsvHeaderRow(text));
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read that file'));
    reader.readAsText(file);
  });
}
