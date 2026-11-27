export interface RefreshedSessionUser {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  status?: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  roles: string[];
  canAuthorizeVendorSettlements?: boolean;
  canManageCataloguePhotos?: boolean;
}

const ADMIN_PORTAL_ROLES = ['ADMINISTRATOR', 'OPERATIONS_STAFF'] as const;

const OPERATIONS_STAFF_ALLOWED_PATHS = [
  '/',
  '/vendors',
  '/vendor-dashboard',
  '/drivers',
  '/delivery-zones',
  '/delivery-operations',
  '/delivery-analytics',
  '/inventory-analytics',
  '/cold-chain',
  '/recalls',
  '/reviews',
] as const;

function hasActiveStatus(user?: { status?: string } | null): boolean {
  return Boolean(user) && (user?.status === undefined || user.status === 'ACTIVE');
}

/**
 * Returns true strictly for ACTIVE ADMINISTRATOR accounts (never OPERATIONS_STAFF).
 */
export function isActiveAdminUser(
  user?: { roles?: readonly string[]; status?: string } | null,
): boolean {
  if (!user || !Array.isArray(user.roles) || !user.roles.includes('ADMINISTRATOR')) {
    return false;
  }
  return hasActiveStatus(user);
}

export const isActiveAdministratorUser = isActiveAdminUser;

/**
 * Returns true when the account is active and holds either ADMINISTRATOR or OPERATIONS_STAFF.
 */
export function isActiveAdminPortalUser(
  user?: { roles?: readonly string[]; status?: string } | null,
): boolean {
  if (!user || !Array.isArray(user.roles) || !hasActiveStatus(user)) {
    return false;
  }
  const allowed: readonly string[] = ADMIN_PORTAL_ROLES;
  return user.roles.some((role: string) => allowed.includes(role));
}

/**
 * Returns true only for an active designated primary administrator authorized
 * to approve or mark vendor settlements as paid.
 */
export function canAuthorizeVendorSettlements(
  user?: { roles?: readonly string[]; status?: string; canAuthorizeVendorSettlements?: boolean } | null,
): boolean {
  return isActiveAdminUser(user) && Boolean(user?.canAuthorizeVendorSettlements);
}

/**
 * Returns true when an active admin portal account holds explicit catalogue
 * photo upload and editing permission.
 */
export function canManageCataloguePhotos(
  user?: { roles?: readonly string[]; status?: string; canManageCataloguePhotos?: boolean } | null,
): boolean {
  return isActiveAdminPortalUser(user) && Boolean(user?.canManageCataloguePhotos);
}

/**
 * Returns true when an active user can open the Admin -> Catalogue Photos screen
 * (either an active ADMINISTRATOR or portal staff with explicit upload/edit permission).
 */
export function canAccessCataloguePhotos(
  user?: { roles?: readonly string[]; status?: string; canManageCataloguePhotos?: boolean } | null,
): boolean {
  return isActiveAdminUser(user) || canManageCataloguePhotos(user);
}

/**
 * Reserves publishing, default selection, retirement, and bulk listing replacement
 * strictly for active ADMINISTRATOR accounts.
 */
export function canPublishOrRetireCataloguePhotos(
  user?: { roles?: readonly string[]; status?: string } | null,
): boolean {
  return isActiveAdminUser(user);
}

/**
 * Enforces the explicit route allowlist for OPERATIONS_STAFF (plus explicit
 * feature permissions such as catalogue photos) while allowing full ADMINISTRATOR
 * accounts across all portal paths.
 */
export function canAccessAdminPath(
  user:
    | { roles?: readonly string[]; status?: string; canManageCataloguePhotos?: boolean }
    | null
    | undefined,
  pathname: string,
): boolean {
  if (!isActiveAdminPortalUser(user)) {
    return false;
  }
  if (isActiveAdminUser(user)) {
    return true;
  }
  const normalized = pathname || '/';
  if (normalized === '/catalogue-photos' || normalized.startsWith('/catalogue-photos/')) {
    return canManageCataloguePhotos(user);
  }
  return OPERATIONS_STAFF_ALLOWED_PATHS.some((allowed) =>
    allowed === '/'
      ? normalized === '/'
      : normalized === allowed || normalized.startsWith(`${allowed}/`),
  );
}

/**
 * Human-readable role badge for the portal header.
 */
export function getAdminRoleLabel(
  user?: { roles?: readonly string[]; status?: string; canAuthorizeVendorSettlements?: boolean } | null,
): string {
  if (canAuthorizeVendorSettlements(user)) {
    return 'Primary Administrator';
  }
  if (isActiveAdminUser(user)) {
    return 'Administrator';
  }
  if (isActiveAdminPortalUser(user)) {
    return 'Operations Staff';
  }
  return 'Unauthorized';
}
