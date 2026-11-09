import axiosPrivate from './axios';

// Wave D-1 -- Fields configuration admin CRUD (Settings > Fields). A *new*
// module, per the established pattern (savedViewApi.ts, auditApi.ts,
// apiKeyApi.ts, releaseApi.ts, ...): apiCalls.tsx is off-limits (WP-015/
// WP-025 precedent -- every sibling API module's own header comment repeats
// this verbatim). apiCalls.tsx's existing `getFields(moduleId)` already
// covers the read path every FieldGrid-consuming detail view calls; it is
// left untouched here and this file adds only the create/update/delete
// surface that never existed anywhere in the frontend before this WP.
//
// Backed by backend/fieldsService's /api/v1/fields routes
// (routes/field.js), secured end-to-end by Wave A-1: keycloak.protect() ->
// requireProjectScope() -> authorize(read|write|delete). createField stamps
// projectId from the verified req.projectScope (never trusted from the
// client body) and updateField/deleteField scope on {_id, projectId}, so a
// field belonging to a different project 404s exactly like a nonexistent
// id.

// backend/fieldsService/models/field.js's authoritative shape.
export interface Field {
  _id: string;
  id: number;
  fieldName: string;
  displayName: string;
  fieldType: string;
  moduleId: number;
  projectId: number;
  isDisplayed: boolean;
  isEnabled: boolean;
  isMandatory: boolean;
  isDefault: boolean;
  defaultValue?: string[];
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

// The types a project admin may pick when creating/editing a field here.
// Deliberately the INTERSECTION of two independent, unrelated constraints,
// not just one:
//
//   - workbench/detail/FieldGrid.tsx only has a rendering branch for Text,
//     TextArea, Editor, DropDown, IssueDropDown and UserDropDown -- any
//     other fieldType renders nothing on every detail form
//     (FieldGrid's `visibleFields.map` simply produces no output for an
//     unmatched type).
//   - backend/fieldsService/models/field.js's own Mongoose enum only
//     allows ['TextArea','Text','Date','DropDown','Editor','UserDropDown']
//     -- notably NOT 'IssueDropDown'. Live module-5 data has a Status field
//     with fieldType 'IssueDropDown' (verified through Kong), which could
//     only have gotten there by a direct write that bypassed this
//     validator -- POST /api/v1/fields with fieldType: 'IssueDropDown' is
//     rejected 400 by Mongoose's own enum check before this UI is even
//     involved.
//
// Offering 'IssueDropDown' here would look like it works and then 400 on
// save. Offering 'Date' has the opposite problem: the backend enum allows
// it, so it would save, but FieldGrid can't render it -- an invisible
// field. CREATABLE_FIELD_TYPES is the intersection: every type here is
// guaranteed both renderable AND actually creatable through this API.
export const CREATABLE_FIELD_TYPES = ['Text', 'TextArea', 'Editor', 'DropDown', 'UserDropDown'] as const;
export type CreatableFieldType = (typeof CREATABLE_FIELD_TYPES)[number];

// The one type among the creatable set whose `defaultValue` array is
// actually consumed anywhere (DropDownField in FieldGrid.tsx maps it to
// <MenuItem> options) -- the options editor in the create/edit dialog only
// appears for this type.
export const DROPDOWN_FIELD_TYPE: CreatableFieldType = 'DropDown';

export interface FieldPayload {
  fieldName: string;
  displayName: string;
  fieldType: string;
  isDisplayed: boolean;
  isEnabled: boolean;
  isMandatory: boolean;
  defaultValue?: string[];
}

export interface CreateFieldPayload extends FieldPayload {
  moduleId: number;
  // Required by the schema (`isDefault` has no default value and no
  // route ever derives it) but not a control this UI exposes -- see
  // Components/settings/FieldsPanel.tsx's header comment. Always false: a
  // field an admin creates through this CRUD tab is never one of the
  // product's own built-in/default fields.
  isDefault: false;
}

const FIELDS_BASE = '/api/v1/fields';

// Same endpoint/params as apiCalls.tsx's getFields(moduleId) (sorted by
// `id` so the admin table's row order matches the order FieldGrid renders
// fields in), reimplemented here rather than imported so this module has
// no runtime dependency on the off-limits file.
export const listFields = async (moduleId: number): Promise<Field[]> => {
  const resp = await axiosPrivate.get(FIELDS_BASE, { params: { moduleId, sort: 'id' } });
  return resp.data.data;
};

export const createField = async (payload: CreateFieldPayload): Promise<Field> => {
  const resp = await axiosPrivate.post(FIELDS_BASE, payload);
  return resp.data.data;
};

export const updateField = async (id: string, payload: FieldPayload): Promise<Field> => {
  const resp = await axiosPrivate.put(`${FIELDS_BASE}/${id}`, payload);
  return resp.data.data;
};

export const deleteField = async (id: string): Promise<void> => {
  await axiosPrivate.delete(`${FIELDS_BASE}/${id}`);
};
