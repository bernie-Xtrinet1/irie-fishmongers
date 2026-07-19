import { NotFoundException } from '@nestjs/common';
import { Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { VendorsRepository } from '../repositories/vendors.repository';
import { VendorPickupQueueService } from './vendor-pickup-queue.service';

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'vendor-user-1',
    businessName: "Vera's Catch",
    description: null,
    phone: null,
    parish: 'KINGSTON',
    logoUrl: null,
    status: 'APPROVED',
    tier: 'COMMUNITY_FISHER',
    complianceScore: null,
    complianceScoreUpdatedAt: null,
    termsAcceptedAt: new Date(),
    primaryZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('VendorPickupQueueService', () => {
  let prisma: { vendorOrder: { findMany: jest.Mock } };
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findByUserId'>>;
  let service: VendorPickupQueueService;

  beforeEach(() => {
    prisma = { vendorOrder: { findMany: jest.fn() } };
    vendorsRepository = { findByUserId: jest.fn() };
    service = new VendorPickupQueueService(
      prisma as unknown as PrismaService,
      vendorsRepository as unknown as VendorsRepository,
    );
  });

  it("lists the vendor's ready-for-pickup and assigned-to-driver orders", async () => {
    vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
    prisma.vendorOrder.findMany.mockResolvedValue([
      {
        id: 'vo-1',
        status: 'ASSIGNED_TO_DRIVER',
        delivery: {
          scheduledPickupWindowStart: new Date('2026-07-10T10:00:00.000Z'),
          driver: { user: { firstName: 'Dana', lastName: 'Driver' } },
          runStop: { sequence: 2 },
        },
      },
      {
        id: 'vo-2',
        status: 'READY_FOR_PICKUP',
        delivery: null,
      },
    ]);

    const result = await service.getForUser('vendor-user-1');

    expect(result).toEqual([
      {
        vendorOrderId: 'vo-1',
        status: 'ASSIGNED_TO_DRIVER',
        driverName: 'Dana Driver',
        scheduledPickupWindowStart: new Date('2026-07-10T10:00:00.000Z'),
        pickupOrder: 2,
      },
      {
        vendorOrderId: 'vo-2',
        status: 'READY_FOR_PICKUP',
        driverName: null,
        scheduledPickupWindowStart: null,
        pickupOrder: null,
      },
    ]);
    expect(prisma.vendorOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vendorId: 'vendor-1', status: { in: ['READY_FOR_PICKUP', 'ASSIGNED_TO_DRIVER'] } },
      }),
    );
  });

  it('throws when no vendor profile exists', async () => {
    vendorsRepository.findByUserId.mockResolvedValue(null);
    await expect(service.getForUser('missing-user')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.vendorOrder.findMany).not.toHaveBeenCalled();
  });
});
