import { Vendor } from '@prisma/client';

import { VendorsService } from '../services/vendors.service';
import { VendorsController } from './vendors.controller';

const vendor: Vendor = {
  id: 'vendor-1',
  userId: 'user-1',
  businessName: "Vera's Catch",
  status: 'PENDING',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('VendorsController', () => {
  let vendorsService: jest.Mocked<Pick<VendorsService, 'register' | 'getOwnProfile' | 'updateStatus'>>;
  let controller: VendorsController;

  beforeEach(() => {
    vendorsService = {
      register: jest.fn().mockResolvedValue(vendor),
      getOwnProfile: jest.fn().mockResolvedValue(vendor),
      updateStatus: jest.fn().mockResolvedValue({ ...vendor, status: 'APPROVED' }),
    };
    controller = new VendorsController(vendorsService as unknown as VendorsService);
  });

  it('registers a vendor profile for the authenticated user', async () => {
    const result = await controller.register(
      { id: 'user-1', email: 'a@b.com', roles: ['VENDOR'] },
      { businessName: "Vera's Catch" },
    );
    expect(result).toEqual(vendor);
    expect(vendorsService.register).toHaveBeenCalledWith('user-1', {
      businessName: "Vera's Catch",
    });
  });

  it("returns the authenticated user's vendor profile", async () => {
    const result = await controller.getOwnProfile({ id: 'user-1', email: 'a@b.com', roles: ['VENDOR'] });
    expect(result).toEqual(vendor);
  });

  it('updates a vendor status', async () => {
    const result = await controller.updateStatus('vendor-1', { status: 'APPROVED' });
    expect(result.status).toBe('APPROVED');
    expect(vendorsService.updateStatus).toHaveBeenCalledWith('vendor-1', 'APPROVED');
  });
});
