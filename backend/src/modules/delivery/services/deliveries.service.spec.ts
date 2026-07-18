import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Driver, Order, OrderItem, User, Vendor, VendorOrder } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { DriverSettlementEngine } from '../../driver-settlements/services/driver-settlement-engine.service';
import { AssignDeliveryDto } from '../dto/assign-delivery.dto';
import { DeliveryRejectedEvent } from '../../../common/events/delivery-rejected.event';
import {
  AvailableVendorOrder,
  DeliveriesRepository,
  DeliveryWithDetails,
} from '../repositories/deliveries.repository';
import { DriverLocationsRepository } from '../repositories/driver-locations.repository';
import { DriversRepository } from '../repositories/drivers.repository';
import { RouteHistoryRepository } from '../repositories/route-history.repository';
import { SLABreachesRepository } from '../repositories/sla-breaches.repository';
import { DeliveriesService } from './deliveries.service';

function buildDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: 'driver-1',
    userId: 'driver-user-1',
    licensePlate: 'AB 1234',
    vehicleType: 'CAR',
    vehicleOwnership: 'PERSONAL_VEHICLE',
    status: 'APPROVED',
    availabilityStatus: 'OFFLINE',
    capacityLbs: null,
    coldChainCapable: false,
    assignedZoneId: null,
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

function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    customerId: 'customer-1',
    deliveryAddressLine1: '1 Ocean View Road',
    deliveryAddressLine2: null,
    deliveryParish: 'KINGSTON',
    deliveryPhone: '+18765551234',
    deliveryZoneId: null,
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
    scheduledPickupWindowStart: null,
    scheduledPickupWindowEnd: null,
    customerDeliveryWindowStart: null,
    customerDeliveryWindowEnd: null,
    vendorConfirmedAt: null,
    vendorConfirmedById: null,
    customerAcceptanceStatus: 'PENDING',
    customerAcceptedAt: null,
    customerRejectedAt: null,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    driver: { ...buildDriver(), user: buildUser() },
    vendorOrder: { ...buildVendorOrder(), order: buildOrder(), vendor: buildVendor(), items: [buildItem()] },
    exceptions: [],
    routeHistory: null,
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
      | 'vendorOrderRequiresColdChain'
      | 'create'
      | 'findById'
      | 'findByVendorOrderId'
      | 'countActiveByDriverId'
      | 'findManyByDriver'
      | 'markPickedUp'
      | 'markDelivered'
      | 'markFailed'
      | 'updateSchedule'
      | 'confirmVendorPickup'
      | 'recordCustomerAcceptance'
    >
  >;
  let vendorOrdersRepository: jest.Mocked<Pick<VendorOrdersRepository, 'updateStatus'>>;
  let driversRepository: jest.Mocked<
    Pick<DriversRepository, 'findByUserId' | 'updateAvailabilityStatus'>
  >;
  let driverLocationsRepository: jest.Mocked<
    Pick<DriverLocationsRepository, 'findLatestByDriverId' | 'findBetween'>
  >;
  let routeHistoryRepository: jest.Mocked<Pick<RouteHistoryRepository, 'create'>>;
  let slaBreachesRepository: jest.Mocked<Pick<SLABreachesRepository, 'upsert'>>;
  let settlementEngine: jest.Mocked<Pick<DriverSettlementEngine, 'computeDistanceKm'>>;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emitAsync'>>;
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
      vendorOrderRequiresColdChain: jest.fn().mockResolvedValue(false),
      create: jest.fn(),
      findById: jest.fn(),
      findByVendorOrderId: jest.fn(),
      countActiveByDriverId: jest.fn(),
      findManyByDriver: jest.fn(),
      markPickedUp: jest.fn(),
      markDelivered: jest.fn(),
      markFailed: jest.fn(),
      updateSchedule: jest.fn(),
      confirmVendorPickup: jest.fn(),
      recordCustomerAcceptance: jest.fn(),
    };
    vendorOrdersRepository = { updateStatus: jest.fn() };
    driversRepository = { findByUserId: jest.fn(), updateAvailabilityStatus: jest.fn() };
    driverLocationsRepository = {
      findLatestByDriverId: jest.fn(),
      findBetween: jest.fn().mockResolvedValue([]),
    };
    routeHistoryRepository = { create: jest.fn() };
    slaBreachesRepository = { upsert: jest.fn() };
    settlementEngine = { computeDistanceKm: jest.fn().mockReturnValue(0) };
    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };

    service = new DeliveriesService(
      prisma as unknown as PrismaService,
      deliveriesRepository as unknown as DeliveriesRepository,
      vendorOrdersRepository as unknown as VendorOrdersRepository,
      driversRepository as unknown as DriversRepository,
      driverLocationsRepository as unknown as DriverLocationsRepository,
      routeHistoryRepository as unknown as RouteHistoryRepository,
      slaBreachesRepository as unknown as SLABreachesRepository,
      settlementEngine as unknown as DriverSettlementEngine,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('getAvailable', () => {
    it('lists available vendor orders for an online, approved driver', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver({ availabilityStatus: 'ONLINE' }));
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
      driversRepository.findByUserId.mockResolvedValue(
        buildDriver({ status: 'PENDING', availabilityStatus: 'ONLINE' }),
      );
      await expect(
        service.getAvailable('driver-user-1', { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws when the driver is offline', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver({ availabilityStatus: 'OFFLINE' }));
      await expect(
        service.getAvailable('driver-user-1', { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(deliveriesRepository.findAvailableForPickup).not.toHaveBeenCalled();
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
    const onlineDriver = buildDriver({ availabilityStatus: 'ONLINE' });

    it('claims an available vendor order and marks the driver busy', async () => {
      driversRepository.findByUserId.mockResolvedValue(onlineDriver);
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
      expect(driversRepository.updateAvailabilityStatus).toHaveBeenCalledWith(
        'driver-1',
        'BUSY',
        {},
      );
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'delivery.driver_assigned',
        expect.objectContaining({ customerId: 'customer-1', vendorOrderId: 'vo-1', driverFirstName: 'Dana' }),
      );
    });

    it('rejects claiming a delivery while one is already active', async () => {
      driversRepository.findByUserId.mockResolvedValue(onlineDriver);
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(1);

      await expect(service.assign('driver-user-1', dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(deliveriesRepository.findVendorOrderForPickup).not.toHaveBeenCalled();
    });

    it('throws when the vendor order does not exist', async () => {
      driversRepository.findByUserId.mockResolvedValue(onlineDriver);
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(0);
      deliveriesRepository.findVendorOrderForPickup.mockResolvedValue(null);

      await expect(service.assign('driver-user-1', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects claiming a vendor order that is not ready for pickup', async () => {
      driversRepository.findByUserId.mockResolvedValue(onlineDriver);
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(0);
      deliveriesRepository.findVendorOrderForPickup.mockResolvedValue(
        buildAvailableVendorOrder({ status: 'PREPARING' }),
      );

      await expect(service.assign('driver-user-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects claiming a vendor order already claimed by another driver', async () => {
      driversRepository.findByUserId.mockResolvedValue(onlineDriver);
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(0);
      deliveriesRepository.findVendorOrderForPickup.mockResolvedValue(buildAvailableVendorOrder());
      deliveriesRepository.findByVendorOrderId.mockResolvedValue(buildDeliveryWithDetails());

      await expect(service.assign('driver-user-1', dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects claiming when the driver is offline', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver({ availabilityStatus: 'OFFLINE' }));

      await expect(service.assign('driver-user-1', dto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(deliveriesRepository.countActiveByDriverId).not.toHaveBeenCalled();
    });

    it('rejects claiming a cold-chain delivery when the driver is not cold-chain capable', async () => {
      driversRepository.findByUserId.mockResolvedValue(
        buildDriver({ availabilityStatus: 'ONLINE', coldChainCapable: false }),
      );
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(0);
      deliveriesRepository.findVendorOrderForPickup.mockResolvedValue(buildAvailableVendorOrder());
      deliveriesRepository.vendorOrderRequiresColdChain.mockResolvedValue(true);

      await expect(service.assign('driver-user-1', dto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(deliveriesRepository.findByVendorOrderId).not.toHaveBeenCalled();
    });

    it('allows claiming a cold-chain delivery when the driver is cold-chain capable', async () => {
      driversRepository.findByUserId.mockResolvedValue(
        buildDriver({ availabilityStatus: 'ONLINE', coldChainCapable: true }),
      );
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(0);
      deliveriesRepository.findVendorOrderForPickup.mockResolvedValue(buildAvailableVendorOrder());
      deliveriesRepository.vendorOrderRequiresColdChain.mockResolvedValue(true);
      deliveriesRepository.findByVendorOrderId.mockResolvedValue(null);
      deliveriesRepository.create.mockResolvedValue(buildDeliveryWithDetails());

      const result = await service.assign('driver-user-1', dto);
      expect(result.stage).toBe('ASSIGNED');
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

    it("includes each delivery's reported exceptions", async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findManyByDriver.mockResolvedValue({
        items: [
          buildDeliveryWithDetails({
            exceptions: [
              {
                id: 'exception-1',
                deliveryId: 'delivery-1',
                type: 'TRAFFIC_DELAY',
                reason: 'Major road closure downtown',
                photos: [],
                notes: null,
                resolved: false,
                resolvedAt: null,
                resolvedById: null,
                createdAt: new Date(),
              },
            ],
          }),
        ],
        total: 1,
      });

      const result = await service.getMine('driver-user-1', { page: 1, pageSize: 20 });
      expect(result.items[0]?.exceptions).toHaveLength(1);
      expect(result.items[0]?.exceptions[0]).toMatchObject({
        id: 'exception-1',
        type: 'TRAFFIC_DELAY',
      });
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
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'delivery.status_updated',
        expect.objectContaining({ vendorOrderId: 'vo-1', stage: 'PICKED_UP' }),
      );
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

    it('marks a delivery delivered with proof, closes the vendor order, and records route history', async () => {
      const pickedUpAt = new Date('2026-07-08T10:00:00.000Z');
      const deliveredAt = new Date('2026-07-08T10:30:00.000Z');
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ pickedUpAt }),
      );
      deliveriesRepository.markDelivered.mockResolvedValue(
        buildDeliveryWithDetails({
          pickedUpAt,
          deliveredAt,
          proofType: 'PHOTO',
          proofUrl: 'https://cdn.example.com/proof.jpg',
        }),
      );
      driverLocationsRepository.findBetween.mockResolvedValue([
        { id: 'loc-1', driverId: 'driver-1', latitude: 17.9, longitude: -76.8, recordedAt: pickedUpAt },
      ]);
      settlementEngine.computeDistanceKm.mockReturnValue(5.5);
      routeHistoryRepository.create.mockResolvedValue({
        id: 'route-1',
        deliveryId: 'delivery-1',
        driverId: 'driver-1',
        gpsSamples: 1,
        distanceKm: { toString: () => '5.5' } as never,
        durationMinutes: 30,
        createdAt: new Date(),
      });

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
      expect(driversRepository.updateAvailabilityStatus).toHaveBeenCalledWith(
        'driver-1',
        'ONLINE',
        {},
      );
      expect(driverLocationsRepository.findBetween).toHaveBeenCalledWith(
        'driver-1',
        pickedUpAt,
        deliveredAt,
      );
      expect(settlementEngine.computeDistanceKm).toHaveBeenCalledWith([
        { id: 'loc-1', driverId: 'driver-1', latitude: 17.9, longitude: -76.8, recordedAt: pickedUpAt },
      ]);
      expect(routeHistoryRepository.create).toHaveBeenCalledWith(
        {
          deliveryId: 'delivery-1',
          driverId: 'driver-1',
          gpsSamples: 1,
          distanceKm: 5.5,
          durationMinutes: 30,
        },
        {},
      );
      expect(result.routeHistory?.id).toBe('route-1');
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'delivery.status_updated',
        expect.objectContaining({ customerId: 'customer-1', vendorOrderId: 'vo-1', stage: 'DELIVERED' }),
      );
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'delivery.awaiting_customer_acceptance',
        expect.objectContaining({ customerId: 'customer-1', vendorOrderId: 'vo-1' }),
      );
    });

    it('records an SLA breach when delivered after the promised window', async () => {
      const pickedUpAt = new Date('2026-07-08T09:00:00.000Z');
      const windowEnd = new Date('2026-07-08T10:00:00.000Z');
      const deliveredAt = new Date('2026-07-08T10:20:00.000Z');
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ pickedUpAt, customerDeliveryWindowEnd: windowEnd }),
      );
      deliveriesRepository.markDelivered.mockResolvedValue(
        buildDeliveryWithDetails({
          pickedUpAt,
          deliveredAt,
          customerDeliveryWindowEnd: windowEnd,
          proofType: 'PHOTO',
          proofUrl: 'https://cdn.example.com/proof.jpg',
        }),
      );
      driverLocationsRepository.findBetween.mockResolvedValue([]);
      routeHistoryRepository.create.mockResolvedValue({
        id: 'route-1',
        deliveryId: 'delivery-1',
        driverId: 'driver-1',
        gpsSamples: 0,
        distanceKm: { toString: () => '0' } as never,
        durationMinutes: 80,
        createdAt: new Date(),
      });

      await service.updateStatus('driver-user-1', 'delivery-1', {
        action: 'DELIVERED',
        proofType: 'PHOTO',
        proofUrl: 'https://cdn.example.com/proof.jpg',
      });

      expect(slaBreachesRepository.upsert).toHaveBeenCalledWith(
        {
          deliveryId: 'delivery-1',
          type: 'LATE_DELIVERY',
          scheduledEnd: windowEnd,
          minutesLate: 20,
        },
        {},
      );
    });

    it('does not record an SLA breach when delivered within the promised window', async () => {
      const pickedUpAt = new Date('2026-07-08T09:00:00.000Z');
      const windowEnd = new Date('2026-07-08T10:00:00.000Z');
      const deliveredAt = new Date('2026-07-08T09:50:00.000Z');
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ pickedUpAt, customerDeliveryWindowEnd: windowEnd }),
      );
      deliveriesRepository.markDelivered.mockResolvedValue(
        buildDeliveryWithDetails({
          pickedUpAt,
          deliveredAt,
          customerDeliveryWindowEnd: windowEnd,
          proofType: 'PHOTO',
          proofUrl: 'https://cdn.example.com/proof.jpg',
        }),
      );
      driverLocationsRepository.findBetween.mockResolvedValue([]);
      routeHistoryRepository.create.mockResolvedValue({
        id: 'route-1',
        deliveryId: 'delivery-1',
        driverId: 'driver-1',
        gpsSamples: 0,
        distanceKm: { toString: () => '0' } as never,
        durationMinutes: 50,
        createdAt: new Date(),
      });

      await service.updateStatus('driver-user-1', 'delivery-1', {
        action: 'DELIVERED',
        proofType: 'PHOTO',
        proofUrl: 'https://cdn.example.com/proof.jpg',
      });

      expect(slaBreachesRepository.upsert).not.toHaveBeenCalled();
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

    it('marks a delivery failed with a reason, closes the vendor order, and records route history', async () => {
      const assignedAt = new Date('2026-07-08T09:00:00.000Z');
      const failedAt = new Date('2026-07-08T09:15:00.000Z');
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ assignedAt, pickedUpAt: null }),
      );
      deliveriesRepository.markFailed.mockResolvedValue(
        buildDeliveryWithDetails({ assignedAt, failedAt, failureReason: 'Customer not present' }),
      );
      routeHistoryRepository.create.mockResolvedValue({
        id: 'route-2',
        deliveryId: 'delivery-1',
        driverId: 'driver-1',
        gpsSamples: 0,
        distanceKm: { toString: () => '0' } as never,
        durationMinutes: 15,
        createdAt: new Date(),
      });

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
      expect(driversRepository.updateAvailabilityStatus).toHaveBeenCalledWith(
        'driver-1',
        'ONLINE',
        {},
      );
      expect(driverLocationsRepository.findBetween).toHaveBeenCalledWith(
        'driver-1',
        assignedAt,
        failedAt,
      );
      expect(routeHistoryRepository.create).toHaveBeenCalledWith(
        {
          deliveryId: 'delivery-1',
          driverId: 'driver-1',
          gpsSamples: 0,
          distanceKm: 0,
          durationMinutes: 15,
        },
        {},
      );
      expect(result.routeHistory?.id).toBe('route-2');
      expect(eventEmitter.emitAsync).not.toHaveBeenCalledWith(
        'delivery.awaiting_customer_acceptance',
        expect.anything(),
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

  describe('updateSchedule', () => {
    it('sets pickup and delivery windows on an owned, open delivery', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(buildDeliveryWithDetails());
      deliveriesRepository.updateSchedule.mockResolvedValue(
        buildDeliveryWithDetails({
          scheduledPickupWindowStart: new Date('2026-07-10T10:00:00.000Z'),
          scheduledPickupWindowEnd: new Date('2026-07-10T12:00:00.000Z'),
        }),
      );

      const dto = {
        scheduledPickupWindowStart: '2026-07-10T10:00:00.000Z',
        scheduledPickupWindowEnd: '2026-07-10T12:00:00.000Z',
      };
      const result = await service.updateSchedule('driver-user-1', 'delivery-1', dto);

      expect(result.scheduledPickupWindowStart).toEqual(new Date('2026-07-10T10:00:00.000Z'));
      expect(deliveriesRepository.updateSchedule).toHaveBeenCalledWith('delivery-1', {
        scheduledPickupWindowStart: new Date('2026-07-10T10:00:00.000Z'),
        scheduledPickupWindowEnd: new Date('2026-07-10T12:00:00.000Z'),
        customerDeliveryWindowStart: undefined,
        customerDeliveryWindowEnd: undefined,
      });
    });

    it('rejects a pickup window whose end is not after its start', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(buildDeliveryWithDetails());

      const dto = {
        scheduledPickupWindowStart: '2026-07-10T12:00:00.000Z',
        scheduledPickupWindowEnd: '2026-07-10T10:00:00.000Z',
      };
      await expect(
        service.updateSchedule('driver-user-1', 'delivery-1', dto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(deliveriesRepository.updateSchedule).not.toHaveBeenCalled();
    });

    it('rejects a delivery window whose end is not after its start', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(buildDeliveryWithDetails());

      const dto = {
        customerDeliveryWindowStart: '2026-07-10T12:00:00.000Z',
        customerDeliveryWindowEnd: '2026-07-10T12:00:00.000Z',
      };
      await expect(
        service.updateSchedule('driver-user-1', 'delivery-1', dto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects scheduling a delivery that is already closed', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ deliveredAt: new Date() }),
      );

      await expect(
        service.updateSchedule('driver-user-1', 'delivery-1', {
          scheduledPickupWindowStart: '2026-07-10T10:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the delivery belongs to another driver', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ driverId: 'someone-elses-driver' }),
      );

      await expect(
        service.updateSchedule('driver-user-1', 'delivery-1', {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('confirmVendorPickup', () => {
    it('records the vendor confirmation without changing the delivery stage', async () => {
      deliveriesRepository.findById.mockResolvedValue(buildDeliveryWithDetails());
      deliveriesRepository.confirmVendorPickup.mockResolvedValue(
        buildDeliveryWithDetails({
          vendorConfirmedAt: new Date(),
          vendorConfirmedById: 'vendor-user-1',
        }),
      );

      const result = await service.confirmVendorPickup('vendor-user-1', 'delivery-1');

      expect(result.vendorConfirmedAt).not.toBeNull();
      expect(result.stage).toBe('ASSIGNED');
      expect(deliveriesRepository.confirmVendorPickup).toHaveBeenCalledWith(
        'delivery-1',
        'vendor-user-1',
      );
    });

    it('throws when the requester does not own the vendor order', async () => {
      deliveriesRepository.findById.mockResolvedValue(buildDeliveryWithDetails());
      await expect(
        service.confirmVendorPickup('someone-else', 'delivery-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects confirmation once the delivery is already closed', async () => {
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ deliveredAt: new Date() }),
      );
      await expect(
        service.confirmVendorPickup('vendor-user-1', 'delivery-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the delivery does not exist', async () => {
      deliveriesRepository.findById.mockResolvedValue(null);
      await expect(
        service.confirmVendorPickup('vendor-user-1', 'missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('recordCustomerAcceptance', () => {
    it('accepts a delivered order', async () => {
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ deliveredAt: new Date() }),
      );
      deliveriesRepository.recordCustomerAcceptance.mockResolvedValue(
        buildDeliveryWithDetails({
          deliveredAt: new Date(),
          customerAcceptanceStatus: 'ACCEPTED',
          customerAcceptedAt: new Date(),
        }),
      );

      const result = await service.recordCustomerAcceptance('customer-1', 'delivery-1', {
        decision: 'ACCEPTED',
      });

      expect(result.customerAcceptanceStatus).toBe('ACCEPTED');
      expect(deliveriesRepository.recordCustomerAcceptance).toHaveBeenCalledWith('delivery-1', {
        customerAcceptanceStatus: 'ACCEPTED',
        customerAcceptedAt: expect.any(Date) as Date,
        customerRejectedAt: undefined,
        rejectionReason: undefined,
      });
      expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
    });

    it('rejects a delivered order and emits DeliveryRejectedEvent', async () => {
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ deliveredAt: new Date() }),
      );
      deliveriesRepository.recordCustomerAcceptance.mockResolvedValue(
        buildDeliveryWithDetails({
          deliveredAt: new Date(),
          customerAcceptanceStatus: 'REJECTED',
          customerRejectedAt: new Date(),
          rejectionReason: 'Package arrived warm',
        }),
      );

      const result = await service.recordCustomerAcceptance('customer-1', 'delivery-1', {
        decision: 'REJECTED',
        reason: 'Package arrived warm',
      });

      expect(result.customerAcceptanceStatus).toBe('REJECTED');
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        DeliveryRejectedEvent.eventName,
        expect.objectContaining({
          customerId: 'customer-1',
          vendorOrderId: 'vo-1',
          reason: 'Package arrived warm',
          vendorUserId: 'vendor-user-1',
        }),
      );
    });

    it('requires a reason when rejecting', async () => {
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ deliveredAt: new Date() }),
      );

      await expect(
        service.recordCustomerAcceptance('customer-1', 'delivery-1', { decision: 'REJECTED' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(deliveriesRepository.recordCustomerAcceptance).not.toHaveBeenCalled();
    });

    it('rejects acceptance before the delivery has been marked delivered', async () => {
      deliveriesRepository.findById.mockResolvedValue(buildDeliveryWithDetails());

      await expect(
        service.recordCustomerAcceptance('customer-1', 'delivery-1', { decision: 'ACCEPTED' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a second acceptance decision once one is already resolved', async () => {
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ deliveredAt: new Date(), customerAcceptanceStatus: 'ACCEPTED' }),
      );

      await expect(
        service.recordCustomerAcceptance('customer-1', 'delivery-1', { decision: 'ACCEPTED' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the requester does not own the order', async () => {
      deliveriesRepository.findById.mockResolvedValue(
        buildDeliveryWithDetails({ deliveredAt: new Date() }),
      );

      await expect(
        service.recordCustomerAcceptance('someone-else', 'delivery-1', { decision: 'ACCEPTED' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws when the delivery does not exist', async () => {
      deliveriesRepository.findById.mockResolvedValue(null);
      await expect(
        service.recordCustomerAcceptance('customer-1', 'missing', { decision: 'ACCEPTED' }),
      ).rejects.toBeInstanceOf(NotFoundException);
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
