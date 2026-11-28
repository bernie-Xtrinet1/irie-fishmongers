import {
  canAccessAdminPath,
  canAccessCataloguePhotos,
  canAuthorizeVendorSettlements,
  canDelegateCataloguePhotoAccess,
  canManageCataloguePhotos,
  canPublishOrRetireCataloguePhotos,
  getAdminRoleLabel,
  isActiveAdminPortalUser,
  isActiveAdminUser,
} from './admin-access';

describe('admin-access helpers', () => {
  it('distinguishes ADMINISTRATOR from OPERATIONS_STAFF', () => {
    const admin = { roles: ['ADMINISTRATOR'], status: 'ACTIVE' };
    const primaryAdmin = {
      roles: ['ADMINISTRATOR'],
      status: 'ACTIVE',
      canAuthorizeVendorSettlements: true,
    };
    const staff = {
      roles: ['OPERATIONS_STAFF'],
      status: 'ACTIVE',
      canAuthorizeVendorSettlements: true,
    };

    expect(isActiveAdminUser(admin)).toBe(true);
    expect(isActiveAdminUser(staff)).toBe(false);
    expect(isActiveAdminPortalUser(staff)).toBe(true);

    expect(canAuthorizeVendorSettlements(admin)).toBe(false);
    expect(canAuthorizeVendorSettlements(staff)).toBe(false);
    expect(canAuthorizeVendorSettlements(primaryAdmin)).toBe(true);
    expect(canDelegateCataloguePhotoAccess(admin)).toBe(false);
    expect(canDelegateCataloguePhotoAccess(staff)).toBe(false);
    expect(canDelegateCataloguePhotoAccess(primaryAdmin)).toBe(true);
    expect(canAccessAdminPath(admin, '/catalogue-photos/staff-access')).toBe(false);
    expect(canAccessAdminPath(staff, '/catalogue-photos/staff-access')).toBe(false);
    expect(canAccessAdminPath(primaryAdmin, '/catalogue-photos/staff-access')).toBe(true);

    expect(getAdminRoleLabel(primaryAdmin)).toBe('Primary Administrator');
    expect(getAdminRoleLabel(admin)).toBe('Administrator');
    expect(getAdminRoleLabel(staff)).toBe('Operations Staff');
  });

  it('allows operations staff only on non-financial portal routes', () => {
    const staff = { roles: ['OPERATIONS_STAFF'], status: 'ACTIVE' };
    const admin = { roles: ['ADMINISTRATOR'], status: 'ACTIVE' };

    expect(canAccessAdminPath(staff, '/')).toBe(true);
    expect(canAccessAdminPath(staff, '/vendors')).toBe(true);
    expect(canAccessAdminPath(staff, '/vendor-dashboard')).toBe(true);
    expect(canAccessAdminPath(staff, '/drivers')).toBe(true);
    expect(canAccessAdminPath(staff, '/delivery-zones')).toBe(true);
    expect(canAccessAdminPath(staff, '/delivery-operations')).toBe(true);
    expect(canAccessAdminPath(staff, '/delivery-analytics')).toBe(true);
    expect(canAccessAdminPath(staff, '/inventory-analytics')).toBe(true);
    expect(canAccessAdminPath(staff, '/cold-chain')).toBe(true);
    expect(canAccessAdminPath(staff, '/recalls')).toBe(true);
    expect(canAccessAdminPath(staff, '/reviews')).toBe(true);

    expect(canAccessAdminPath(staff, '/sales-analytics')).toBe(false);
    expect(canAccessAdminPath(staff, '/sales-analytics/export')).toBe(false);
    expect(canAccessAdminPath(staff, '/vendor-settlements')).toBe(false);

    expect(canAccessAdminPath(admin, '/sales-analytics')).toBe(true);
    expect(canAccessAdminPath(admin, '/catalogue-photos')).toBe(true);
    expect(canAccessAdminPath(staff, '/catalogue-photos')).toBe(false);

    const catalogueEditor = {
      roles: ['OPERATIONS_STAFF'],
      status: 'ACTIVE',
      canManageCataloguePhotos: true,
    };
    expect(canManageCataloguePhotos(catalogueEditor)).toBe(true);
    expect(canAccessCataloguePhotos(catalogueEditor)).toBe(true);
    expect(canPublishOrRetireCataloguePhotos(catalogueEditor)).toBe(false);
    expect(canAccessAdminPath(catalogueEditor, '/catalogue-photos')).toBe(true);
    expect(canPublishOrRetireCataloguePhotos(admin)).toBe(true);
  });

  it('denies suspended or pending portal users', () => {
    expect(isActiveAdminPortalUser({ roles: ['OPERATIONS_STAFF'], status: 'SUSPENDED' })).toBe(false);
    expect(
      canAccessAdminPath({ roles: ['OPERATIONS_STAFF'], status: 'PENDING_VERIFICATION' }, '/cold-chain'),
    ).toBe(false);
  });
});
