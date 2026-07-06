import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Driver, Order, OrderItem, User, Vendor, VendorOrder } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { AssignDeliveryDto } from '../dto/assign-delivery.dto';
import {
  AvailableVendorOrder,
  DeliveriesRepository,
  DeliveryWithDetails,
} from '../repositories/deliveries.repository';
import { DriverLocationsRepository } from '../repositories/driver-locations.repository';
import { DriversRepository } from '../repositories/drivers.repository';
import { DeliveriesService } from './deliveries.service';

function buildDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: 'driver-1',
    userId: 'driver-user-1',
    licensePlate: 'AB 1234',
    vehicleType: 'CAR',
    status: 'APPROVED',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'driver-user-1',
    email: 'dana@example.com',
    passwordHash: 'hashed',
    firstName: 'Dana',
    lastName: 'Driver',
    phone: '+18765550000',
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
    emailVerificationTokenHash: null,
    emailVerificationTokenExpiresAt: null,
    passwordResetTokenHash: null,
    passwordResetTokenExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

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
    termsAcceptedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    customerId: 'customer-1',
    deliveryAddressLine1: '1 Ocean View Road',
    deliveryAddressLine2: null,
    deliveryParish: 'KINGSTON',
    deliveryPhone: '+18765551234',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildItem(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: 'item-1',
    vendorOrderId: 'vo-1',
    productId: 'product-1',
    productName: 'Fresh Snapper',
    unitPrice: { toString: () => '500' } as OrderItem['unitPrice'],
    unit: 'PER_POUND',
    quantity: 2,
    subtotal: { toString: () => '1000' } as OrderItem['subtotal'],
    createdAt: new Date(),
    ...overrides,
  };
}

function buildVendorOrder(overrides: Partial<VendorOrder> = {}): VendorOrder {
  return {
    id: 'vo-1',
    orderId: 'order-1',
    vendorId: 'vendor-1',
    status: 'READY_FOR_PICKUP',
    subtotal: { toString: () => '1000' } as VendorOrder['subtotal'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildAvailableVendorOrder(
  overrides: Partial<AvailableVendorOrder> = {},
): AvailableVendorOrder {
  return {
    ...buildVendorOrder(),
    vendor: buildVendor(),
    items: [buildItem()],
    ...overrides,
  };
}

function buildDeliveryWithDetails(overrides: Partial<DeliveryWithDetails> = {}): DeliveryWithDetails {
  return {
    id: 'delivery-1',
    vendorOrderId: 'vo-1',
    driverId: 'driver-1',
    assignedAt: new Date(),
    pickedUpAt: null,
    deliveredAt: null,
    failedAt: null,
    failureReason: null,
    proofType: null,
    proofUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    driver: { ...buildDriver(), user: buildUser() },
    vendorOrder: { ...buildVendorOrder(), order: buildOrder(), vendor: buildVendor(), items: [buildItem()] },
    ...overrides,
  };
}

describe('DeliveriesService', () => {
  let prisma: { $transaction: jest.Mock };
  let deliveriesRepository: jest.Mocked<
    Pick<
      DeliveriesRepository,
      | 'findAvailableForPickup'
      | 'findVendorOrderForPickup'
      | 'create'
      | 'findById'
      | 'findByVendorOrderId'
      | 'countActiveByDriverId'
      | 'findManyByDriver'
      | 'markPickedUp'
      | 'markDelivered'
      | 'markFailed'
    >
  >;
  let vendorOrdersRepository: jest.Mocked<Pick<VendorOrdersRepository, 'updateStatus'>>;
  let driversRepository: jest.Mocked<Pick<DriversRepository, 'findByUserId'>>;
  let driverLocationsRepository: jest.Mocked<Pick<DriverLocationsRepository, 'findLatestByDriverId'>>;
  let service: DeliveriesService;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn().mockImplementation((callback: (tx: unknown) => unknown) =>
        callback({}),
      ),
    };
    deliveriesRepository = {
      findAvailableForPickup: jest.fn(),
      findVendorOrderForPickup: jest.fn(),
      create: jest.fn(),
      findById: jest.fn(),
      findByVendorOrderId: jest.fn(),
      countActiveByDriverId: jest.fn(),
      findManyByDriver: jest.fn(),
      markPickedUp: jest.fn(),
      markDelivered: jest.fn(),
      markFailed: jest.fn(),
    };
    vendorOrdersRepository = { updateStatus: jest.fn() };
    driversRepository = { findByUserId: jest.fn() };
    driverLocationsRepository = { findLatestByDriverId: jest.fn() };

    service = new DeliveriesService(
      prisma as unknown as PrismaService,
      deliveriesRepository as unknown as DeliveriesRepository,
      vendorOrdersRepository as unknown as VendorOrdersRepository,
      driversRepository as unknown as DriversRepository,
      driverLocationsRepository as unknown as DriverLocationsRepository,
    );
  });

  describe('getAvailable', () => {
    it('lists available vendor orders for an approved driver', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findAvailableForPickup.mockResolvedValue({
        items: [buildAvailableVendorOrder()],
        total: 1,
      });

      const result = await service.getAvailable('driver-user-1', { page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        vendorOrderId: 'vo-1',
        pickupVendorName: "Vera's Catch",
        pickupParish: 'KINGSTON',
      });
    });

    it('throws when the driver is not approved', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver({ status: 'PENDING' }));
      await expect(
        service.getAvailable('driver-user-1', { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws when no driver profile exists', async () => {
      driversRepository.findByUserId.mockResolvedValue(null);
      await expect(
        service.getAvailable('driver-user-1', { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('assign', () => {
    const dto: AssignDeliveryDto = { vendorOrderId: 'vo-1' };

    it('claims an available vendor order', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(0);
      deliveriesRepository.findVendorOrderForPickup.mockResolvedValue(buildAvailableVendorOrder());
      deliveriesRepository.findByVendorOrderId.mockResolvedValue(null);
      deliveriesRepository.create.mockResolvedValue(buildDeliveryWithDetails());

      const result = await service.assign('driver-user-1', dto);

      expect(result.stage).toBe('ASSIGNED');
      expect(deliveriesRepository.create).toHaveBeenCalledWith(
        { vendorOrderId: 'vo-1', driverId: 'driver-1' },
        {},
      );
      expect(vendorOrdersRepository.updateStatus).toHaveBeenCalledWith(
        'vo-1',
        'ASSIGNED_TO_DRIVER',
        {},
      );
    });

    it('rejects claiming a delivery while one is already active', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(1);

      await expect(service.assign('driver-user-1', dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(deliveriesRepository.findVendorOrderForPickup).not.toHaveBeenCalled();
    });

    it('throws when the vendor order does not exist', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(0);
      deliveriesRepository.findVendorOrderForPickup.mockResolvedValue(null);

      await expect(service.assign('driver-user-1', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects claiming a vendor order that is not ready for pickup', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(0);
      deliveriesRepository.findVendorOrderForPickup.mockResolvedValue(
        buildAvailableVendorOrder({ status: 'PREPARING' }),
      );

      await expect(service.assign('driver-user-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects claiming a vendor order already claimed by another driver', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(0);
      deliveriesRepository.findVendorOrderForPickup.mockResolvedValue(buildAvailableVendorOrder());
      deliveriesRepository.findByVendorOrderId.mockResolvedValue(buildDeliveryWithDetails());

      await expect(service.assign('driver-user-1', dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('getMine', () => {
    it("lists a driver's own deliveries regardless of approval status", async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver({ status: 'SUSPENDED' }));
      deliveriesRepository.findManyByDriver.mockResolvedValue({
        items: [buildDeliveryWithDetails()],
        total: 1,
      });

      const result = await service.getMine('driver-user-1', { page: 1, pageSize: 20 });
      expect(result.total).toBe(1);
    });

    it('throws when no driver profile exists', async () => {
      driversRepository.findByUserId.mockResolvedValue(null);
      await expect(
        service.getMine('driver-user-1', { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('marks a delivery picked up and advances the vendor order to in transit', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(buildDeliveryWithDetails());
      deliveriesRepository.markPickedUp.mockResolvedValue(
        buildDeliveryWithDetails({ pickedUpAt: new Date() }),
      );

      const result = await service.updateStatus('driver-user-1', 'delivery-1', {
        action: 'PICKED_UP',
      });

      expect(result.stage).toBe('PICKED_UP');
      expect(vendorOrdersRepository.updateStatus).toHaveBeenCalledWith('vo-1', 'IN_TRANSIT', {});
    });

    it('rejects marking picked up twice', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ pickedUpAt: new Date() }),
      );

      await expect(
        service.updateStatus('driver-user-1', 'delivery-1', { action: 'PICKED_UP' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('marks a delivery delivered with proof and closes the vendor order', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ pickedUpAt: new Date() }),
      );
      deliveriesRepository.markDelivered.mockResolvedValue(
        buildDeliveryWithDetails({
          pickedUpAt: new Date(),
          deliveredAt: new Date(),
          proofType: 'PHOTO',
          proofUrl: 'https://cdn.example.com/proof.jpg',
        }),
      );

      const result = await service.updateStatus('driver-user-1', 'delivery-1', {
        action: 'DELIVERED',
        proofType: 'PHOTO',
        proofUrl: 'https://cdn.example.com/proof.jpg',
      });

      expect(result.stage).toBe('DELIVERED');
      expect(deliveriesRepository.markDelivered).toHaveBeenCalledWith(
        'delivery-1',
        'PHOTO',
        'https://cdn.example.com/proof.jpg',
        {},
      );
      expect(vendorOrdersRepository.updateStatus).toHaveBeenCalledWith('vo-1', 'DELIVERED', {});
    });

    it('rejects marking delivered before pickup', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(buildDeliveryWithDetails());

      await expect(
        service.updateStatus('driver-user-1', 'delivery-1', {
          action: 'DELIVERED',
          proofType: 'PHOTO',
          proofUrl: 'https://cdn.example.com/proof.jpg',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects marking delivered without proof', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ pickedUpAt: new Date() }),
      );

      await expect(
        service.updateStatus('driver-user-1', 'delivery-1', { action: 'DELIVERED' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('marks a delivery failed with a reason and closes the vendor order', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ pickedUpAt: new Date() }),
      );
      deliveriesRepository.markFailed.mockResolvedValue(
        buildDeliveryWithDetails({ pickedUpAt: new Date(), failedAt: new Date(), failureReason: 'Customer not present' }),
      );

      const result = await service.updateStatus('driver-user-1', 'delivery-1', {
        action: 'FAILED',
        failureReason: 'Customer not present',
      });

      expect(result.stage).toBe('FAILED');
      expect(deliveriesRepository.markFailed).toHaveBeenCalledWith(
        'delivery-1',
        'Customer not present',
        {},
      );
      expect(vendorOrdersRepository.updateStatus).toHaveBeenCalledWith(
        'vo-1',
        'DELIVERY_FAILED',
        {},
      );
    });

    it('rejects marking failed without a reason', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(buildDeliveryWithDetails());

      await expect(
        service.updateStatus('driver-user-1', 'delivery-1', { action: 'FAILED' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects any transition once a delivery is already closed', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ deliveredAt: new Date() }),
      );

      await expect(
        service.updateStatus('driver-user-1', 'delivery-1', {
          action: 'FAILED',
          failureReason: 'Too late now',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the delivery does not exist', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(null);

      await expect(
        service.updateStatus('driver-user-1', 'missing', { action: 'PICKED_UP' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the delivery belongs to another driver', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ driverId: 'someone-elses-driver' }),
      );

      await expect(
        service.updateStatus('driver-user-1', 'delivery-1', { action: 'PICKED_UP' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('track', () => {
    it("returns tracking info for the order's owning customer", async () => {
      deliveriesRepository.findByVendorOrderId.mockResolvedValue(buildDeliveryWithDetails());
      driverLocationsRepository.findLatestByDriverId.mockResolvedValue({
        id: 'loc-1',
        driverId: 'driver-1',
        latitude: 17.9714,
        longitude: -76.7931,
        recordedAt: new Date(),
      });

      const result = await service.track('customer-1', 'vo-1');

      expect(result.stage).toBe('ASSIGNED');
      expect(result.driverFirstName).toBe('Dana');
      expect(result.latestLocation).toMatchObject({ latitude: 17.9714, longitude: -76.7931 });
    });

    it('returns a null location when the driver has not reported one yet', async () => {
      deliveriesRepository.findByVendorOrderId.mockResolvedValue(buildDeliveryWithDetails());
      driverLocationsRepository.findLatestByDriverId.mockResolvedValue(null);

      const result = await service.track('customer-1', 'vo-1');
      expect(result.latestLocation).toBeNull();
    });

    it('throws when no delivery has been assigned yet', async () => {
      deliveriesRepository.findByVendorOrderId.mockResolvedValue(null);
      await expect(service.track('customer-1', 'vo-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws when the requester does not own the order', async () => {
      deliveriesRepository.findByVendorOrderId.mockResolvedValue(buildDeliveryWithDetails());
      await expect(service.track('someone-else', 'vo-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
