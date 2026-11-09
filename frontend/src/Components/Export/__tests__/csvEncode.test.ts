// Wave C-2 (Register A3) -- the CSV encoder is the part of this WP where a
// bug is invisible until someone opens the file: a naive `.join(',')`
// would silently corrupt any field containing a comma, quote, or newline.
// Every case here asserts the EXACT output string, not just "doesn't
// throw", per this WP's own test brief.
import { encodeCsvField, encodeCsvRow, buildCsv } from '../csvEncode';

describe('encodeCsvField', () => {
  it('leaves a plain field bare', () => {
    expect(encodeCsvField('TC-1')).toBe('TC-1');
  });

  it('returns an empty string for an empty value', () => {
    expect(encodeCsvField('')).toBe('');
  });

  it('returns an empty string for null/undefined', () => {
    expect(encodeCsvField(null)).toBe('');
    expect(encodeCsvField(undefined)).toBe('');
  });

  it('quotes a field containing a comma', () => {
    expect(encodeCsvField('Login, then logout')).toBe('"Login, then logout"');
  });

  it('quotes a field containing a double quote and doubles it', () => {
    expect(encodeCsvField('Click the "Submit" button')).toBe('"Click the ""Submit"" button"');
  });

  it('quotes a field containing an embedded newline', () => {
    expect(encodeCsvField('Line one\nLine two')).toBe('"Line one\nLine two"');
  });

  it('quotes a field containing an embedded carriage return', () => {
    expect(encodeCsvField('Line one\r\nLine two')).toBe('"Line one\r\nLine two"');
  });

  it('quotes and doubles quotes together with a comma present', () => {
    expect(encodeCsvField('a, "b", c')).toBe('"a, ""b"", c"');
  });

  it('passes a unicode value through unchanged when it needs no quoting', () => {
    expect(encodeCsvField('café ☃ 日本語')).toBe('café ☃ 日本語');
  });

  it('numbers and booleans stringify plainly', () => {
    expect(encodeCsvField(42)).toBe('42');
    expect(encodeCsvField(0)).toBe('0');
  });
});

describe('encodeCsvRow', () => {
  it('joins encoded fields with commas', () => {
    expect(encodeCsvRow(['TC-1', 'Login, then logout', 'ok'])).toBe('TC-1,"Login, then logout",ok');
  });
});

describe('buildCsv', () => {
  it('produces the exact header + row + trailing CRLF shape', () => {
    const csv = buildCsv(
      ['TestCaseSummary', 'TestCaseDescription', 'parentId'],
      [['Login works', 'Simple, no commas', '0']]
    );
    expect(csv).toBe('TestCaseSummary,TestCaseDescription,parentId\r\nLogin works,"Simple, no commas",0\r\n');
  });

  it('produces multiple data rows in order, each CRLF-terminated', () => {
    const csv = buildCsv(
      ['id', 'value'],
      [
        ['1', 'a'],
        ['2', 'b'],
      ]
    );
    expect(csv).toBe('id,value\r\n1,a\r\n2,b\r\n');
  });
});
