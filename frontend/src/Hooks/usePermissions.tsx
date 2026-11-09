import { useQuery } from '@tanstack/react-query';
import keycloak from '../keycloak';
import { getProjects } from '../api/projectApi';
import { getCurrentProjectId } from '../currentProject';
import { roleCan, Action, Role } from '../permissions';

// WP-022 — usePermissions(). Resolves the current Keycloak user's role on
// the current project (see currentProject.ts) and exposes a can(action)
// check UI components use to hide/disable write actions for a viewer.
//
// Reuses GET /api/v1/projects (api/projectApi.ts's getProjects(), WP-020)
// rather than a dedicated per-project endpoint -- that's the same response
// backend/shared/service-core/middleware/projectScope.js's
// requireProjectScope() itself resolves membership from, so this hook and
// every backend authorize() decision are reading the exact same
// members[]/role data, just on different sides of the wire. react-query
// caches/dedupes it, so mounting this hook in many components doesn't mean
// many requests.
//
// This is UI decoration ONLY (see permissions.ts's header comment) -- the
// real authorization boundary is server-side. A stale or wrong `role` here
// can make a control visibly wrong but can never grant real access; the
// server always re-checks.
export interface UsePermissionsResult {
  role: Role | null;
  isLoading: boolean;
  isError: boolean;
  /** true only once role data has loaded AND the role permits `action`. */
  can: (action: Action) => boolean;
}

export function usePermissions(projectId: number = getCurrentProjectId()): UsePermissionsResult {
  const sub = (keycloak.tokenParsed as { sub?: string } | undefined)?.sub;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['usePermissions', 'projects'],
    // Wrapped, not passed directly: getProjects(organizationId?) takes an
    // optional arg that doesn't match react-query's QueryFunction signature
    // (it would otherwise receive react-query's context object as that arg).
    queryFn: () => getProjects(),
    staleTime: 30_000,
    enabled: Boolean(sub) && Boolean(keycloak.authenticated)
  });

  const project = data?.find((p) => p.id === projectId);
  const member = sub && project ? project.members.find((m) => m.userId === sub) : undefined;
  const role = (member?.role as Role | undefined) ?? null;

  return {
    role,
    isLoading,
    isError,
    can: (action: Action) => !isLoading && roleCan(role, action)
  };
}

export default usePermissions;
