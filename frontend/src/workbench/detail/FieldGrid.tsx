import React, { useEffect, useState } from 'react';
import { Box, FormLabel, Grid, List, ListItem, ListItemText, MenuItem, Select, SelectChangeEvent, TextField } from '@mui/material';
import ReactQuill from 'react-quill';
import { DefectStatus } from '../../Components/governance/DefectStatus';
import DynamicAutocomplete from '../../Components/Lists/dropDownList';
// Deliberately no `import 'react-quill/dist/quill.snow.css'` here (unlike
// TabContent.tsx) -- that CSS file lives under node_modules, which this
// repo's jest transformIgnorePatterns (package.json) does not carve an
// exception for, so requiring it blows up any test that imports this
// module even indirectly. DefectContent.tsx (the other place ReactQuill is
// used) already omits this same import for the same reason.

// WP-074 -- extracted from Components/Tabs/TabContent.tsx's generic field
// grid (lines ~702-774). `getFields(moduleId)` (api/apiCalls.tsx) is the
// source of these records; sub-project 3 (Fields configuration) is what
// will let a project admin edit them, but the shape itself already exists
// today and is reused as-is here.
export interface FieldDefinition {
  fieldName: string;
  displayName: string;
  fieldType: string;
  isDisplayed: boolean;
  isMandatory: boolean;
  isDefault?: boolean;
  defaultValue?: string[];
}

export type FieldValues = Record<string, unknown>;

export interface FieldGridProps {
  fields: FieldDefinition[];
  values: FieldValues;
  /**
   * Renders every control non-editable. Callers pass `!can('write')`.
   *
   * The legacy page gated its Edit button on `canPerform('write')`
   * (TabContent.tsx:631), but per-field inline edit removed that single
   * affordance and nothing replaced it, so a read-only user was shown
   * fully editable fields whose writes the backend then rejected
   * (authorize('write') is mounted on every write route). This restores
   * the gate the migration dropped.
   */
  readOnly?: boolean;
  /**
   * Fired on every keystroke/selection, before the value is committed --
   * lets the caller mark the owning tab dirty the moment an edit starts
   * (TestCaseDetail does exactly this).
   */
  onFieldChange?: (fieldName: string, value: unknown) => void;
  /**
   * Fired once a field's edit is final: on blur for free-text controls
   * (Text/TextArea/Editor), immediately on selection for DropDown. This
   * per-field commit is what replaces TabContent's page-level Save button
   * (spec sub-project 1, "per-field inline edit").
   */
  onFieldCommit: (fieldName: string, value: unknown) => void;
  /**
   * WP-077 -- generic module id, threaded through to `UserDropDown`
   * (DynamicAutocomplete needs it to pick its own persistence branch).
   * Harmless/unused for any module with no `UserDropDown` field.
   */
  moduleId?: number;
  /**
   * WP-077 -- the entity's business id (e.g. "DEF-12", "TC-104"), threaded
   * through to `UserDropDown` (DynamicAutocomplete's own "is this a
   * not-yet-saved record" check) and to `IssueDropDown` as a fallback label.
   * Harmless/unused for any module with neither field type.
   */
  entityId?: string;
  /**
   * WP-077 -- surfaces errors raised by the `IssueDropDown` status control
   * (DefectStatus) the same way LifecycleStatusSection's onError does.
   * Optional: a module with no `IssueDropDown` field never calls it.
   */
  onError?: (message: string, severity: string) => void;
}

// TabContent.tsx:705 excludes these four field names from its generic grid
// because each is rendered elsewhere: the two *Summary fields in the
// header (now DetailHeader), Expected/testStep in the steps table (now
// AddDeleteTableRows, driven directly by TestCaseDetail/RequirementDetail
// etc). Preserved verbatim -- this is the "same special-cased field names"
// behaviour Step 1 of WP-074 requires.
const EXCLUDED_FIELD_NAMES = new Set(['requirementSummary', 'TestCaseSummary', 'Expected', 'testStep']);

// Verbatim from TabContent.tsx's `modules`/`formats` ReactQuill config.
const QUILL_MODULES = {
  toolbar: [
    [{ header: '1' }, { header: '2' }, { font: [] }],
    [{ size: ['small', false, 'large', 'huge'] }],
    ['bold', 'italic', 'underline', 'strike', 'blockquote'],
    [{ list: 'ordered' }, { list: 'bullet' }, { indent: '-1' }, { indent: '+1' }],
    ['clean'],
  ],
};
const QUILL_FORMATS = [
  'header', 'font', 'size',
  'bold', 'italic', 'underline', 'strike', 'blockquote',
  'list', 'bullet', 'indent',
];

interface FieldControlProps {
  field: FieldDefinition;
  value: unknown;
  readOnly?: boolean;
  onFieldChange?: (fieldName: string, value: unknown) => void;
  onFieldCommit: (fieldName: string, value: unknown) => void;
  // WP-077 -- extra context only IssueDropDown/UserDropDown read. Every
  // other control ignores these; they are not part of that control's own
  // generic contract above.
  mongoId?: string;
  entityId?: string;
  moduleId?: number;
  statusHistory?: StatusHistoryEntry[];
  onError?: (message: string, severity: string) => void;
}

function TextAreaField({ field, value, readOnly, onFieldChange, onFieldCommit }: FieldControlProps): JSX.Element {
  const [draft, setDraft] = useState<string>((value as string) ?? '');
  useEffect(() => setDraft((value as string) ?? ''), [value]);
  return (
    <>
      <TextField
        value={draft}
        minRows={2}
        multiline
        fullWidth
        disabled={readOnly}
        size="small"
        id={field.displayName}
        onChange={(e) => {
          setDraft(e.target.value);
          onFieldChange?.(field.fieldName, e.target.value);
        }}
        onBlur={() => onFieldCommit(field.fieldName, draft)}
      />
    </>
  );
}

function TextInputField({ field, value, readOnly, onFieldChange, onFieldCommit }: FieldControlProps): JSX.Element {
  const [draft, setDraft] = useState<string>((value as string) ?? '');
  useEffect(() => setDraft((value as string) ?? ''), [value]);
  return (
    <TextField
      id={field.displayName}
      value={draft}
      disabled={readOnly}
      onChange={(e) => {
        setDraft(e.target.value);
        onFieldChange?.(field.fieldName, e.target.value);
      }}
      onBlur={() => onFieldCommit(field.fieldName, draft)}
      variant="outlined"
      size="small"
      fullWidth
    />
  );
}

function DropDownField({ field, value, readOnly, onFieldChange, onFieldCommit }: FieldControlProps): JSX.Element {
  return (
    <Select
      fullWidth
      size="small"
      disabled={readOnly}
      inputProps={{ 'aria-label': field.displayName }}
      value={(value as string) ?? ''}
      onChange={(e: SelectChangeEvent) => {
        const nValue = e.target.value;
        onFieldChange?.(field.fieldName, nValue);
        // A selection is a discrete, complete edit -- there is no
        // intermediate "still typing" state to protect the network from,
        // so committing immediately on change is the same rule as
        // "commit on blur" applied to a control that has no separate blur
        // moment worth waiting for.
        onFieldCommit(field.fieldName, nValue);
      }}
    >
      {(field.defaultValue ?? []).map((dropDownValue) => (
        <MenuItem key={dropDownValue} value={dropDownValue}>{dropDownValue}</MenuItem>
      ))}
    </Select>
  );
}

// Editor values are USUALLY a JSON-serialised Quill Delta, but not always:
// real seeded records carry plain strings (e.g. TC-695's "seeded for ..."),
// and an unguarded JSON.parse throws on them, taking the whole detail region
// down. The legacy TabContent.tsx:760 has the identical unguarded parse, so
// this crash exists in the live product too -- it is simply not reproduced
// here. A plain string is rendered as plain text rather than discarded.
export function parseEditorValue(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw === '') return '';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function EditorField({ field, value, readOnly, onFieldChange, onFieldCommit }: FieldControlProps): JSX.Element {
  const [draft, setDraft] = useState<string>((value as string) ?? '');
  useEffect(() => setDraft((value as string) ?? ''), [value]);
  return (
    <ReactQuill
      modules={QUILL_MODULES}
      formats={QUILL_FORMATS}
      // `bubble` hides the formatting toolbar, so a read-only field does
      // not advertise editing controls that do nothing.
      theme={readOnly ? 'bubble' : 'snow'}
      readOnly={readOnly}
      value={parseEditorValue(draft) as never}
      onChange={(_content, _delta, source, editor) => {
        // Quill fires onChange while normalising its initial content, before
        // the user has touched anything -- with source 'api', not 'user'.
        // Reporting that as an edit marked a tab dirty the moment it was
        // opened. It bit hardest on values stored as plain strings rather
        // than a serialised Delta, where the normalised form always differs
        // from what was loaded, so a value comparison alone does not fix it.
        if (source !== 'user') return;
        const json = JSON.stringify(editor.getContents());
        if (json === draft) return;
        setDraft(json);
        onFieldChange?.(field.fieldName, json);
      }}
      onBlur={() => onFieldCommit(field.fieldName, draft)}
    />
  );
}

// WP-077 -- one entry of a defect's `statusHistory` (backend/defectService/
// models/defects.js, populated only by PUT /:id/status --
// controllers/defects.js's updateDefectStatus). Read here as plain data
// coming back on the entity record itself (same as `attachment`), not a
// module-5-specific type: any module whose record carries a `statusHistory`
// array on the field this IssueDropDown renders gets the same list for free.
export interface StatusHistoryEntry {
  from?: string;
  to: string;
  changedBy?: string;
  changedAt?: string;
}

// WP-077 -- second FieldGrid field type. Not ported from
// DefectContent.tsx/DefectStatus.tsx as-is: neither of those actually
// renders `statusHistory` today (verified by reading both files in full,
// and by grepping the whole frontend tree for "statusHistory" -- zero
// hits before this change), even though the plan's Task 8 checklist calls
// for "retaining ... statusHistory display". There was nothing to port;
// this is new, minimal, read-only UI over data the backend already writes
// (backend/defectService/controllers/defects.js:331), added to satisfy
// that acceptance criterion honestly rather than fabricate a "port" that
// never existed.
//
// `DefectStatus` (Components/governance/DefectStatus.tsx, WP-010) already
// owns the actual status workflow (StatusChip + "Change status" menu,
// scoped to the transitions valid from the current status) and its own PUT
// .../status call -- reused as-is. The "not-yet-saved record" fallback
// (disabled TextField reading "Save the defect to set its status") is
// DefectContent.tsx:365/423 verbatim, gated here on `mongoId` being falsy
// (no Mongo _id yet) rather than a hardcoded "newDefect" substring check --
// same behaviour, expressed generically instead of via a module-5 string.
function IssueDropDownField({ field, value, readOnly, mongoId, statusHistory, onFieldChange, onFieldCommit, onError }: FieldControlProps): JSX.Element {
  if (readOnly) {
    // No write permission: show the value, never the transition control.
    return (
      <TextField
        fullWidth
        size="small"
        disabled
        inputProps={{ 'aria-label': field.displayName }}
        value={(value as string) ?? ''}
      />
    );
  }
  if (!mongoId) {
    return (
      <TextField
        fullWidth
        size="small"
        disabled
        inputProps={{ 'aria-label': field.displayName }}
        value="Save the defect to set its status"
      />
    );
  }
  return (
    <Box>
      <DefectStatus
        defectId={mongoId}
        status={(value as string) ?? ''}
        onStatusChanged={(newStatus) => {
          onFieldChange?.(field.fieldName, newStatus);
          onFieldCommit(field.fieldName, newStatus);
        }}
        onError={(message, severity) => onError?.(message, severity)}
      />
      {Array.isArray(statusHistory) && statusHistory.length > 0 && (
        <List dense aria-label="Status history">
          {statusHistory.map((entry, idx) => (
            // No stable id on this embedded subdocument shape -- index is
            // fine, this list is never reordered or edited from the UI.
            // eslint-disable-next-line react/no-array-index-key
            <ListItem key={idx} disableGutters>
              <ListItemText
                primary={`${entry.from ?? '—'} → ${entry.to}`}
                secondary={entry.changedBy ? `by ${entry.changedBy}` : undefined}
              />
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );
}

// WP-077 -- third FieldGrid field type. `DynamicAutocomplete`
// (Components/Lists/dropDownList.tsx) owns its own persistence for
// moduleId 5: `handleSelection` there PUTs the defect directly
// (`updateDefect(props.defectId, ...)`) before calling back into
// `updateUser`, exactly like DefectContent.tsx:408's usage. That callback is
// wired to the normal onFieldChange/onFieldCommit pair so the caller's
// react-query cache and tab-dirty state stay in sync -- the caller decides
// whether to also re-PUT the field (DefectDetail does not, to avoid a
// redundant write; see its commitField mutation).
function UserDropDownField({ field, value, readOnly, mongoId, entityId, moduleId, onFieldChange, onFieldCommit }: FieldControlProps): JSX.Element {
  return (
    readOnly ? (
      <TextField
        fullWidth
        size="small"
        disabled
        inputProps={{ 'aria-label': field.displayName }}
        value={(value as string) ?? ''}
      />
    ) : (
    <DynamicAutocomplete
      moduleId={moduleId}
      defecnId={entityId ?? ''}
      defectId={mongoId ?? ''}
      userName={(value as string) ?? ''}
      // D6 -- thread the field's own label through instead of leaving the
      // combobox unlabelled (see dropDownList.tsx's own comment on this
      // prop for why axe was failing).
      displayName={field.displayName}
      updateUser={(selected: { label: string; value: string }) => {
        onFieldChange?.(field.fieldName, selected.label);
        onFieldCommit(field.fieldName, selected.label);
      }}
    />
    )
  );
}

// WP-074 -- behaviour-preserving extraction of TabContent.tsx's generic
// field grid. Same field types (Text/TextArea/Editor/DropDown), same
// isMandatory -> FormLabel `required`, same excluded field names. The one
// change: TabContent rendered either a fully-editable form (edit===true)
// or an all-disabled read-only form (edit===false), toggled by a
// page-level Edit/Save/Cancel; every field here is always live, and each
// commits independently (see FieldGridProps doc above) -- that swap is the
// sub-project's one deliberate behaviour change, not a redesign of field
// rendering itself.
//
// `isDisplayed` is read here as gating the WHOLE field (label + control).
// TabContent's own edit-mode branches (lines 707/726/734/739) do not
// actually re-check isDisplayed on the control, only on its label and on
// the separate read-only fallback (line 765) -- almost certainly a
// pre-existing gap (an edit-mode control with no visible label) rather
// than an intentional semantic, and not one worth reproducing now that
// there is only one rendering mode. "same isDisplayed ... semantics" is
// read here as its evident intent: a field with isDisplayed: false does
// not appear.
export function FieldGrid({ fields, values, readOnly, onFieldChange, onFieldCommit, moduleId, entityId, onError }: FieldGridProps): JSX.Element {
  const visibleFields = fields.filter(
    (field) => field.isDisplayed && !EXCLUDED_FIELD_NAMES.has(field.fieldName),
  );
  // Generic, not module-5-specific: whatever record this is, its own Mongo
  // _id (if it has been saved) and its own `statusHistory` array (if it has
  // one) ride along on `values` exactly like `attachment` already does.
  const mongoId = values._id as string | undefined;
  const statusHistory = values.statusHistory as StatusHistoryEntry[] | undefined;

  return (
    // The theme's spacing unit is 4px (tokens.density.spacing), not MUI's
    // default 8 -- `spacing={1}` here was a 4px gutter, which is why a
    // dozen fields read as one undifferentiated block.
    <Grid container mt={2} spacing={4}>
      {visibleFields.map((field) => (
        <Grid item xs={field.fieldType === 'TextArea' || field.fieldType === 'Editor' ? 12 : 6} key={field.fieldName}>
          {/* A label set at the same size and weight as the value it
              labels makes the reader do the sorting. Quiet and small, so
              the value is what the eye lands on. */}
          <FormLabel
            required={field.isMandatory}
            htmlFor={field.displayName}
            sx={{ display: 'block', fontSize: 12, color: 'text.secondary', mb: 0.5 }}
          >
            {field.displayName}
          </FormLabel>
          {field.fieldType === 'TextArea' && (
            <TextAreaField field={field} readOnly={readOnly} value={values[field.fieldName]} onFieldChange={onFieldChange} onFieldCommit={onFieldCommit} />
          )}
          {field.fieldType === 'Editor' && (
            <EditorField field={field} readOnly={readOnly} value={values[field.fieldName]} onFieldChange={onFieldChange} onFieldCommit={onFieldCommit} />
          )}
          {field.fieldType === 'Text' && (
            <TextInputField field={field} readOnly={readOnly} value={values[field.fieldName]} onFieldChange={onFieldChange} onFieldCommit={onFieldCommit} />
          )}
          {field.fieldType === 'DropDown' && (
            <DropDownField field={field} readOnly={readOnly} value={values[field.fieldName]} onFieldChange={onFieldChange} onFieldCommit={onFieldCommit} />
          )}
          {field.fieldType === 'IssueDropDown' && (
            <IssueDropDownField
              readOnly={readOnly}
              field={field}
              value={values[field.fieldName]}
              mongoId={mongoId}
              statusHistory={statusHistory}
              onFieldChange={onFieldChange}
              onFieldCommit={onFieldCommit}
              onError={onError}
            />
          )}
          {field.fieldType === 'UserDropDown' && (
            <UserDropDownField
              readOnly={readOnly}
              field={field}
              value={values[field.fieldName]}
              mongoId={mongoId}
              entityId={entityId}
              moduleId={moduleId}
              onFieldChange={onFieldChange}
              onFieldCommit={onFieldCommit}
            />
          )}
        </Grid>
      ))}
    </Grid>
  );
}

export default FieldGrid;
