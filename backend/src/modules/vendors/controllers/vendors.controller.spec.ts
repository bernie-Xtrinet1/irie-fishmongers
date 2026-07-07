import { Vendor } from '@prisma/client';

import { VendorPublicEntity } from '../entities/vendor-public.entity';
import { VendorsService } from '../services/vendors.service';
import { VendorsController } from './vendors.controller';

const vendor: Vendor = {
  id: 'vendor-1',
  userId: 'user-1',
  businessName: "Vera's Catch",
  description: null,
  phone: null,
  parish: 'KINGSTON',
  logoUrl: null,
  status: 'PENDING',
  tier: 'COMMUNITY_FISHER',
  complianceScore: null,
  termsAcceptedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const publicVendor: VendorPublicEntity = {
  id: 'vendor-1',
  businessName: "Vera's Catch",
  description: null,
  parish: 'KINGSTON',
  logoUrl: null,
  tier: 'COMMUNITY_FISHER',
};

const user = { id: 'user-1', email: 'a@b.com', roles: ['VENDOR' as const] };

describe('VendorsController', () => {
  let vendorsService: jest.Mocked<
    Pick<VendorsService, 'register' | 'getOwnProfile' | 'updateOwnProfile' | 'getPublicProfile' | 'updateStatus' | 'list'>
  >;
  let controller: VendorsController;

  beforeEach(() => {
    vendorsService = {
      register: jest.fn().mockResolvedValue(vendor),
      getOwnProfile: jest.fn().mockResolvedValue(vendor),
      updateOwnProfile: jest.fn().mockResolvedValue({ ...vendor, businessName: 'New Name' }),
      getPublicProfile: jest.fn().mockResolvedValue(publicVendor),
      updateStatus: jest.fn().mockResolvedValue({ ...vendor, status: 'APPROVED' }),
      list: jest.fn().mockResolvedValue({ items: [vendor], total: 1, page: 1, pageSize: 20 }),
    };
    controller = new VendorsController(vendorsService as unknown as VendorsService);
  });

  const registerDto = { businessName: "Vera's Catch", parish: 'KINGSTON' as const, acceptedTerms: true as const };

  it('registers a vendor profile for the authenticated user', async () => {
    const result = await controller.register(user, registerDto);
    expect(result).toEqual(vendor);
    expect(vendorsService.register).toHaveBeenCalledWith('user-1', registerDto);
  });

  it("returns the authenticated user's vendor profile", async () => {
    const result = await controller.getOwnProfile(user);
    expect(result).toEqual(vendor);
  });

  it("updates the authenticated user's vendor profile", async () => {
    const result = await controller.updateOwnProfile(user, { businessName: 'New Name' });
    expect(result.businessName).toBe('New Name');
    expect(vendorsService.updateOwnProfile).toHaveBeenCalledWith('user-1', {
      businessName: 'New Name',
    });
  });

  it('lists vendors', async () => {
    const result = await controller.list({ page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
  });

  it('returns a public vendor profile', async () => {
    const result = await controller.getPublicProfile('vendor-1');
    expect(result).toEqual(publicVendor);
  });

  it('updates a vendor status', async () => {
    const result = await controller.updateStatus('vendor-1', { status: 'APPROVED' });
    expect(result.status).toBe('APPROVED');
    expect(vendorsService.updateStatus).toHaveBeenCalledWith('vendor-1', 'APPROVED');
  });
});
