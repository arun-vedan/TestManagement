// WP-022 — RBAC permission matrix, frontend mirror.
//
// Source of truth is backend/shared/service-core/permissions.js (a plain
// CommonJS module inside the backend workspace, not importable into this
// CRA build across the package boundary). This file intentionally mirrors
// it exactly, the same way frontend/src/api/projectApi.ts's own
// PROJECT_ROLES already mirrors the backend's ROLES list (WP-020
// precedent). If the backend matrix ever changes, this file must change
// with it -- there is no automatic sync.
//
// This frontend copy is UI-decoration only (hide/disable controls a viewer
// shouldn't see). It is never the actual authorization boundary -- every
// route on every service enforces the real matrix server-side via
// authorize()/requireProjectAction(), so a mismatched or bypassed frontend
// check can make a button visible that a 403 then rejects, never the
// reverse.
export const ROLES = ['admin', 'manager', 'contributor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = ['read', 'write', 'delete', 'manage_members', 'manage_project'] as const;
export type Action = (typeof ACTIONS)[number];

const PERMISSION_MATRIX: Record<Role, Record<Action, boolean>> = {
  admin: { read: true, write: true, delete: true, manage_members: true, manage_project: true },
  manager: { read: true, write: true, delete: true, manage_members: true, manage_project: false },
  contributor: { read: true, write: true, delete: false, manage_members: false, manage_project: false },
  viewer: { read: true, write: false, delete: false, manage_members: false, manage_project: false }
};

export function roleCan(role: Role | null | undefined, action: Action): boolean {
  if (!role) return false;
  return PERMISSION_MATRIX[role]?.[action] === true;
}
