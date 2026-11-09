import React, { useEffect, useMemo, useState } from 'react';
import { Box, Chip, IconButton, Stack, TextField, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { ModuleId } from '../modules';
import { getProjectTags } from '../../api/tagApi';

export interface TagsSectionProps {
  module: ModuleId;
  entityId: string;
  tags: string[];
  /** Fired with the full next tag list once an add/remove is confirmed -- the caller owns the actual save (see each detail module's own commit mutation). */
  onChange: (tags: string[]) => void;
  readOnly?: boolean;
}

// WP-F05b (Task 2) -- shared tag editor, mounted as a SECTION (not a tab --
// see this WP's dispatch: "tags belong beside the entity's other
// attributes, and a tab for one control would be worse") on all five
// detail modules.
//
// The backend (each schema's own `tags` setter, WP-F05a/Task 1) is the
// actual boundary -- every write path gets trimmed/lowercased/de-duplicated
// values and a 400 on whitespace, regardless of what this component does.
// This editor mirrors those same rules anyway, for the same reason
// permissions.ts's own header comment gives for ITS checks being
// decoration: so a user sees what will actually be stored *before* they
// commit, rather than typing "Regression", having the server silently
// rewrite it, and wondering why their next lookup by "Regression" (capital)
// doesn't match. Whitespace is refused outright rather than split or
// stripped, matching the model validator's message
// (backend/testRepoService/models/testrepo.js's `tags` field) almost
// verbatim -- the same rule stated the same way in both places, not two
// different lessons about the same restriction.
//
// A duplicate (case/whitespace-insensitively equal to a tag already on the
// entity) is silently ignored rather than erroring -- it mirrors the
// model setter's own de-duplication (`[...new Set(cleaned)]`), which is
// itself silent, so treating a duplicate here as a user-facing mistake
// would be inventing a stricter rule than the one it is echoing.
export function TagsSection({ module, entityId, tags, onChange, readOnly }: TagsSectionProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  // Best-effort only (see api/tagApi.ts's own header comment on why this
  // can legitimately come back empty) -- never a user-visible failure, the
  // input works the same either way, just with or without a suggestion
  // list under it.
  useEffect(() => {
    let alive = true;
    getProjectTags(module)
      .then((result) => {
        if (alive) setSuggestions(result);
      })
      .catch(() => {
        /* best-effort suggestions only -- no error path for this */
      });
    return () => {
      alive = false;
    };
  }, [module]);

  const availableSuggestions = useMemo(
    () => suggestions.filter((s) => !tags.includes(s)),
    [suggestions, tags],
  );
  const datalistId = `tags-suggestions-${module}-${entityId}`;

  const commitDraft = () => {
    const normalised = draft.trim().toLowerCase();
    if (normalised === '') return;
    if (/\s/.test(normalised)) {
      // Wording mirrors the model validator's own message
      // (backend/testRepoService/models/testrepo.js) so the rule reads the
      // same whether the user learns it here or from the 400 it prevents.
      setError('A tag cannot contain whitespace -- use one token per tag (e.g. "smoke-test", not "smoke test").');
      return;
    }
    setError(null);
    setDraft('');
    if (tags.includes(normalised)) return; // silent no-op -- see header comment
    onChange([...tags, normalised]);
  };

  const handleRemove = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  return (
    <Box>
      {/* component="div" -- MUI's default variantMapping renders BOTH
          subtitle1 and subtitle2 as an <h6>, same as DetailHeader's own
          `variant="h6"` id/summary line. This section sits OUTSIDE
          DetailTabs (always visible, per this WP's "section not a tab"
          instruction) rather than inside an unmounted-when-inactive
          TabPanel like Links/Attachments' own labelless content, so a
          second real h6 here would stack with DetailHeader's on every
          render -- caught by DefectDetail.test.tsx's
          `findByRole('heading', { level: 6 })` expecting exactly one. */}
      <Typography variant="subtitle2" component="div" gutterBottom>
        Tags
      </Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: readOnly ? 0 : 1, rowGap: 1 }}>
        {tags.length === 0 && (
          <Typography color="text.secondary" variant="body2">
            No tags yet.
          </Typography>
        )}
        {tags.map((tag) => (
          // Deliberately NOT Chip's own onDelete/deleteIcon: passing
          // onDelete makes the WHOLE Chip a clickable button (MUI wraps it
          // in ButtonBase, `component = onDelete ? ButtonBase : ...`), whose
          // accessible name is then computed from all its content --
          // "regression" -- swallowing a nested deleteIcon's own aria-label
          // ("Remove regression") into that same button rather than
          // exposing it as a separate one (an interactive element nested
          // inside another is invalid a11y regardless). A plain, non-
          // interactive Chip for the label plus a real, separately
          // addressable IconButton for removal avoids that nesting rather
          // than trying to route around it.
          <Box key={tag} sx={{ display: 'inline-flex', alignItems: 'center' }}>
            <Chip label={tag} size="small" />
            {!readOnly && (
              <IconButton
                size="small"
                aria-label={`Remove ${tag}`}
                onClick={() => handleRemove(tag)}
                sx={{ ml: 0.25, p: 0.25 }}
              >
                <CloseIcon fontSize="inherit" />
              </IconButton>
            )}
          </Box>
        ))}
      </Stack>
      {!readOnly && (
        <>
          <TextField
            size="small"
            value={draft}
            placeholder="Add a tag…"
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitDraft();
              }
            }}
            inputProps={{ 'aria-label': 'Add a tag', list: availableSuggestions.length > 0 ? datalistId : undefined }}
          />
          {availableSuggestions.length > 0 && (
            <datalist id={datalistId}>
              {availableSuggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
          {error && (
            <Typography color="error" variant="caption" role="alert" sx={{ display: 'block', mt: 0.5 }}>
              {error}
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}

export default TagsSection;
