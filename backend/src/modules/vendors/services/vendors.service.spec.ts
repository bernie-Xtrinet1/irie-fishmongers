import { ConflictException, NotFoundException } from '@nestjs/common';
import { Vendor } from '@prisma/client';

import { VendorsRepository } from '../repositories/vendors.repository';
import { VendorsService } from './vendors.service';

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'user-1',
    businessName: "Vera's Catch",
    status: 'PENDING',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('VendorsService', () => {
  let vendorsRepository: jest.Mocked<
    Pick<VendorsRepository, 'create' | 'findById' | 'findByUserId' | 'updateStatus'>
  >;
  let service: VendorsService;

  beforeEach(() => {
    vendorsRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findByUserId: jest.fn(),
      updateStatus: jest.fn(),
    };
    service = new VendorsService(vendorsRepository as unknown as VendorsRepository);
  });

  describe('register', () => {
    it('creates a vendor profile when none exists', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      vendorsRepository.create.mockResolvedValue(buildVendor());

      const vendor = await service.register('user-1', { businessName: "Vera's Catch" });

      expect(vendor.status).toBe('PENDING');
      expect(vendorsRepository.create).toHaveBeenCalledWith({
        userId: 'user-1',
        businessName: "Vera's Catch",
      });
    });

    it('rejects registration when a vendor profile already exists', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());

      await expect(
        service.register('user-1', { businessName: "Vera's Catch" }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('getOwnProfile', () => {
    it('returns the vendor profile when it exists', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      await expect(service.getOwnProfile('user-1')).resolves.toEqual(buildVendor());
    });

    it('throws when no vendor profile exists', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(service.getOwnProfile('user-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('updates the status when the vendor exists', async () => {
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      vendorsRepository.updateStatus.mockResolvedValue(buildVendor({ status: 'APPROVED' }));

      const result = await service.updateStatus('vendor-1', 'APPROVED');

      expect(result.status).toBe('APPROVED');
      expect(vendorsRepository.updateStatus).toHaveBeenCalledWith('vendor-1', 'APPROVED');
    });

    it('throws when the vendor does not exist', async () => {
      vendorsRepository.findById.mockResolvedValue(null);
      await expect(service.updateStatus('vendor-1', 'APPROVED')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
