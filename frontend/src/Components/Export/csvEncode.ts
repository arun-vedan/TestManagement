// Wave C-2 (Register A3) -- dependency-free RFC-4180-ish CSV *encoder*,
// the mirror image of csvHeaders.ts's decoder (Components/Import/) and, one
// level further back, backend/testRepoService/utils/csv.js's parseCSV()
// (WP-045). That file's own header comment states the reasoning this
// follows: hand-roll it rather than add a library (e.g. `csv-stringify`)
// for a well-understood, small job, and the WP-045 design direction
// explicitly steers the frontend away from a CSV dependency for exactly
// this class of work.
//
// A naive `.join(',')` silently corrupts any field containing a comma, a
// double quote, or a line break -- true of most free-text descriptions in
// this app -- so every field is escaped per RFC 4180 s.2.6: wrap in double
// quotes when the field contains a comma, a double quote, or a line break
// (\r or \n), and double any double quote already inside it. Fields
// needing none of that are left bare, which is what lets a plain id or
// short summary round-trip unchanged and stay readable in a spreadsheet.
export function encodeCsvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function encodeCsvRow(fields: unknown[]): string {
  return fields.map(encodeCsvField).join(',');
}

/**
 * headers + data rows -> a complete CSV document (CRLF line endings, incl.
 * a trailing CRLF after the last row -- RFC 4180 s.2.2, and what backend/
 * testRepoService/utils/csv.js's parseCSV() and every real spreadsheet
 * app's own "Save as CSV" both produce).
 */
export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [encodeCsvRow(headers), ...rows.map(encodeCsvRow)];
  return lines.join('\r\n') + '\r\n';
}
