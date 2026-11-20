export interface RefreshedSessionUser {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  status?: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  roles: string[];
}

export function isActiveAdminUser(
  user?: { roles?: readonly string[]; status?: string } | null,
): boolean {
  if (!user || !Array.isArray(user.roles) || !user.roles.includes('ADMINISTRATOR')) {
    return false;
  }
  return user.status === undefined || user.status === 'ACTIVE';
}
