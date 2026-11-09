// WP-052 -- plain-text extraction for rich-text (Quill Delta) description
// fields. requirementDescription (requirementService) and
// TestCaseDescription (testRepoService) are both stored as
// JSON.stringify(<Quill Delta>) -- see frontend/src/Components/Tabs/
// TabContent.tsx's ReactQuill usage (`value={... ? JSON.parse(fieldValues[field]) : ''}`,
// `onChange={(e) => handleFieldChange(field, e, editor)}`). Confirmed
// against real data (docker exec into mongodb, srckube-requirements /
// srckube-testrepo): every existing description field looks like
// `{"ops":[{"insert":"test req2\ntest req2\ntest req2\n"}]}`.
//
// Every prompt this service builds from either field needs the PLAIN text,
// not the raw delta JSON string -- a model handed
// `{"ops":[{"insert":"..."}]}` would happily "read" the JSON syntax itself
// as part of the content, corrupting both duplicate-detection scoring and
// lint findings. This is also where a suggested plain-text rewrite gets
// wrapped BACK into the same delta shape before it is ever sent to
// requirementService's update API (toDeltaJson() below) -- so the stored
// value stays something ReactQuill's `JSON.parse(...)` can render, instead
// of crashing the requirement page the next time it's opened.
//
// Falls back to treating the raw string as already-plain when it isn't
// valid delta JSON (defensive -- legacy content or a non-Quill field might
// not be delta-shaped at all).
function extractPlainText(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const parsed = JSON.parse(value);
    if (parsed && Array.isArray(parsed.ops)) {
      return parsed.ops.map((op) => (op && typeof op.insert === 'string' ? op.insert : '')).join('');
    }
  } catch (err) {
    // Not JSON -- fall through, treat the raw value as already-plain text.
  }
  return value;
}

function toDeltaJson(plainText) {
  const text = String(plainText === undefined || plainText === null ? '' : plainText);
  const insert = text.endsWith('\n') ? text : `${text}\n`;
  return JSON.stringify({ ops: [{ insert }] });
}

module.exports = { extractPlainText, toDeltaJson };
