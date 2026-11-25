import { RoleName } from '@prisma/client';

/**
 * Roles permitted to authenticate into the administrative operations portal
 * (subject to route-level role restrictions).
 */
export const ADMIN_PORTAL_ROLES: readonly RoleName[] = [
  RoleName.ADMINISTRATOR,
  RoleName.OPERATIONS_STAFF,
] as const;

function extractRoles(
  rolesOrUser: readonly RoleName[] | { roles?: readonly RoleName[] } | null | undefined,
): readonly RoleName[] {
  if (!rolesOrUser) {
    return [];
  }
  if (Array.isArray(rolesOrUser)) {
    return rolesOrUser as readonly RoleName[];
  }
  return (rolesOrUser as { roles?: readonly RoleName[] }).roles ?? [];
}

/**
 * Returns true strictly for full ADMINISTRATOR accounts (never OPERATIONS_STAFF).
 */
export function isAdministratorRole(
  rolesOrUser: readonly RoleName[] | { roles?: readonly RoleName[] } | null | undefined,
): boolean {
  return extractRoles(rolesOrUser).includes(RoleName.ADMINISTRATOR);
}

/**
 * Returns true when the caller holds ADMINISTRATOR or OPERATIONS_STAFF.
 */
export function hasAdminPortalRole(
  rolesOrUser: readonly RoleName[] | { roles?: readonly RoleName[] } | null | undefined,
): boolean {
  const roles = extractRoles(rolesOrUser);
  return roles.some((role) => ADMIN_PORTAL_ROLES.includes(role));
}
