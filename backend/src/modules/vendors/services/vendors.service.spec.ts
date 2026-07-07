import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Vendor } from '@prisma/client';

import { VendorsRepository } from '../repositories/vendors.repository';
import { VendorsService } from './vendors.service';

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'user-1',
    businessName: "Vera's Catch",
    description: null,
    phone: null,
    parish: 'KINGSTON',
    logoUrl: null,
    status: 'PENDING',
    termsAcceptedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('VendorsService', () => {
  let vendorsRepository: jest.Mocked<
    Pick<VendorsRepository, 'create' | 'findById' | 'findByUserId' | 'updateStatus' | 'update' | 'findMany'>
  >;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emitAsync'>>;
  let service: VendorsService;

  beforeEach(() => {
    vendorsRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findByUserId: jest.fn(),
      updateStatus: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    };
    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };
    service = new VendorsService(
      vendorsRepository as unknown as VendorsRepository,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('register', () => {
    const dto = {
      businessName: "Vera's Catch",
      parish: 'KINGSTON' as const,
      acceptedTerms: true as const,
    };

    it('creates a vendor profile when none exists', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      vendorsRepository.create.mockResolvedValue(buildVendor());

      const vendor = await service.register('user-1', dto);

      expect(vendor.status).toBe('PENDING');
      expect(vendorsRepository.create).toHaveBeenCalledWith({
        userId: 'user-1',
        businessName: "Vera's Catch",
        parish: 'KINGSTON',
        phone: undefined,
        description: undefined,
        termsAcceptedAt: expect.any(Date) as Date,
      });
    });

    it('rejects registration when a vendor profile already exists', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());

      await expect(service.register('user-1', dto)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('getOwnProfile', () => {
    it('returns the vendor profile when it exists', async () => {
      const vendor = buildVendor();
      vendorsRepository.findByUserId.mockResolvedValue(vendor);
      await expect(service.getOwnProfile('user-1')).resolves.toEqual(vendor);
    });

    it('throws when no vendor profile exists', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(service.getOwnProfile('user-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateOwnProfile', () => {
    it('updates the profile for an existing vendor', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      vendorsRepository.update.mockResolvedValue(buildVendor({ businessName: 'New Name' }));

      const result = await service.updateOwnProfile('user-1', { businessName: 'New Name' });

      expect(result.businessName).toBe('New Name');
      expect(vendorsRepository.update).toHaveBeenCalledWith('vendor-1', { businessName: 'New Name' });
    });

    it('throws when no vendor profile exists', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(
        service.updateOwnProfile('user-1', { businessName: 'New Name' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getPublicProfile', () => {
    it('returns a public-safe view of an approved vendor', async () => {
      vendorsRepository.findById.mockResolvedValue(
        buildVendor({ status: 'APPROVED', phone: '+18765551234' }),
      );

      const result = await service.getPublicProfile('vendor-1');

      expect(result).toEqual({
        id: 'vendor-1',
        businessName: "Vera's Catch",
        description: null,
        parish: 'KINGSTON',
        logoUrl: null,
      });
      expect(result).not.toHaveProperty('phone');
      expect(result).not.toHaveProperty('userId');
    });

    it('throws when the vendor is not approved', async () => {
      vendorsRepository.findById.mockResolvedValue(buildVendor({ status: 'PENDING' }));
      await expect(service.getPublicProfile('vendor-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the vendor does not exist', async () => {
      vendorsRepository.findById.mockResolvedValue(null);
      await expect(service.getPublicProfile('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('updates the status when the vendor exists', async () => {
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      vendorsRepository.updateStatus.mockResolvedValue(buildVendor({ status: 'APPROVED' }));

      const result = await service.updateStatus('vendor-1', 'APPROVED');

      expect(result.status).toBe('APPROVED');
      expect(vendorsRepository.updateStatus).toHaveBeenCalledWith('vendor-1', 'APPROVED');
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'vendor.approved',
        expect.objectContaining({ userId: 'user-1', businessName: "Vera's Catch" }),
      );
    });

    it('does not re-emit vendor.approved when the vendor was already approved', async () => {
      vendorsRepository.findById.mockResolvedValue(buildVendor({ status: 'APPROVED' }));
      vendorsRepository.updateStatus.mockResolvedValue(buildVendor({ status: 'APPROVED' }));

      await service.updateStatus('vendor-1', 'APPROVED');

      expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
    });

    it('throws when the vendor does not exist', async () => {
      vendorsRepository.findById.mockResolvedValue(null);
      await expect(service.updateStatus('vendor-1', 'APPROVED')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('list', () => {
    it('paginates vendors filtered by status', async () => {
      vendorsRepository.findMany.mockResolvedValue({ items: [buildVendor()], total: 1 });

      const result = await service.list({ status: 'PENDING', page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(vendorsRepository.findMany).toHaveBeenCalledWith('PENDING', { skip: 0, take: 20 });
    });
  });
});
