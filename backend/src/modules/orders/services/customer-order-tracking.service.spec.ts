import { ForbiddenException } from '@nestjs/common';
import {
  CustomerAcceptanceStatus,
  FleetAssetStatus,
  Parish,
  VendorOrderStatus,
} from '@prisma/client';

import { OrdersRepository, OrderTrackingRecord } from '../repositories/orders.repository';
import { CustomerOrderTrackingService } from './customer-order-tracking.service';

const NOW = new Date('2026-11-26T12:00:00.000Z');

function makeVehicle(overrides: Partial<NonNullable<OrderTrackingRecord['vendorOrders'][number]['cargoAssignments'][number]>['fleetAsset']> = {}) {
  return {
    id: 'asset-1',
    status: FleetAssetStatus.ACTIVE,
    lastLatitude: 17.9714,
    lastLongitude: -76.7931,
    lastGpsCapturedAt: new Date(NOW.getTime() - 25_000),
    lastTelemetryReceivedAt: new Date(NOW.getTime() - 20_000),
    lastTelemetryDelayed: false,
    lastGpsNoFixAt: null,
    ...overrides,
  };
}

function makeOrderRecord(overrides: Partial<OrderTrackingRecord> = {}): OrderTrackingRecord {
  return {
    id: 'order-1',
    customerId: 'customer-1',
    deliveryParish: Parish.KINGSTON,
    vendorOrders: [
      {
        id: 'vo-1',
        status: VendorOrderStatus.IN_TRANSIT,
        vendor: { businessName: 'Harbour Fresh Seafood' },
        items: [{ productName: 'Red Snapper', quantity: 2 }],
        cargoAssignments: [
          {
            quantityUnits: 2,
            handedOverQuantity: 0,
            unloadedAt: null,
            fleetAsset: makeVehicle(),
          },
        ],
        delivery: {
          pickedUpAt: new Date(NOW.getTime() - 15 * 60_000),
          deliveredAt: null,
          failedAt: null,
          customerAcceptanceStatus: CustomerAcceptanceStatus.PENDING,
          customerRejectedAt: null,
          customerDeliveryWindowStart: null,
          customerDeliveryWindowEnd: null,
          runStop: null,
          driver: { operatedFleetAssets: [] },
        },
      },
    ],
    ...overrides,
  };
}

describe('CustomerOrderTrackingService', () => {
  let ordersRepository: { findOrderTrackingById: jest.Mock };
  let service: CustomerOrderTrackingService;

  beforeEach(() => {
    ordersRepository = {
      findOrderTrackingById: jest.fn(),
    };
    service = new CustomerOrderTrackingService(ordersRepository as unknown as OrdersRepository);
  });

  it('rejects requests from another customer and missing orders', async () => {
    ordersRepository.findOrderTrackingById.mockResolvedValue(makeOrderRecord());
    await expect(service.getOrderTracking('customer-2', 'order-1', NOW)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    ordersRepository.findOrderTrackingById.mockResolvedValue(null);
    await expect(service.getOrderTracking('customer-1', 'missing-order', NOW)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns live vehicle coordinates without leaking fleet or internal telemetry metadata', async () => {
    ordersRepository.findOrderTrackingById.mockResolvedValue(makeOrderRecord());

    const result = await service.getOrderTracking('customer-1', 'order-1', NOW);

    expect(result.hasActiveTracking).toBe(true);
    expect(result.isSplitOrder).toBe(false);
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]).toMatchObject({
      vendorOrderId: 'vo-1',
      deliveryLabel: 'Harbour Fresh Seafood',
      itemsSummary: '2x Red Snapper',
      stage: 'IN_TRANSIT',
      statusLabel: 'Picked up / In transit',
      onBoard: true,
      isLocationShared: true,
      locationStatus: 'LIVE',
      location: {
        latitude: 17.9714,
        longitude: -76.7931,
        capturedAt: new Date(NOW.getTime() - 25_000).toISOString(),
        stale: false,
        label: 'Live vehicle location',
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('asset-1');
    expect(serialized).not.toContain('imei');
    expect(serialized).not.toContain('licensePlate');
    expect(serialized).not.toContain('driverPhone');
    expect(serialized).not.toContain('cargoTemp');
  });

  it('splits deliveries clearly across multiple vendors and isolates locations', async () => {
    const base = makeOrderRecord();
    const firstVendorOrder = base.vendorOrders[0]!;
    ordersRepository.findOrderTrackingById.mockResolvedValue({
      ...base,
      vendorOrders: [
        firstVendorOrder,
        {
          id: 'vo-2',
          status: VendorOrderStatus.READY_FOR_PICKUP,
          vendor: { businessName: 'Port Royal Catch' },
          items: [{ productName: 'Tilapia Fillet', quantity: 3 }],
          cargoAssignments: [],
          delivery: null,
        },
      ],
    });

    const result = await service.getOrderTracking('customer-1', 'order-1', NOW);
    const [part1, part2] = result.deliveries;

    expect(result.isSplitOrder).toBe(true);
    expect(result.hasActiveTracking).toBe(true);
    expect(part1?.deliveryLabel).toBe('Part 1 of 2 · Harbour Fresh Seafood');
    expect(part1?.isLocationShared).toBe(true);
    expect(part2?.deliveryLabel).toBe('Part 2 of 2 · Port Royal Catch');
    expect(part2?.stage).toBe('AWAITING_PICKUP');
    expect(part2?.location).toBeNull();
    expect(part2?.isLocationShared).toBe(false);
  });

  it('labels stale and delayed older GPS positions as Last reported location with capturedAt', async () => {
    const staleCapturedAt = new Date(NOW.getTime() - 15 * 60_000);
    const record = makeOrderRecord();
    record.vendorOrders[0]!.cargoAssignments[0]!.fleetAsset = makeVehicle({
      lastGpsCapturedAt: staleCapturedAt,
      lastTelemetryReceivedAt: NOW,
      lastTelemetryDelayed: true,
    });
    ordersRepository.findOrderTrackingById.mockResolvedValue(record);

    const result = await service.getOrderTracking('customer-1', 'order-1', NOW);

    expect(result.deliveries[0]).toMatchObject({
      stage: 'IN_TRANSIT',
      statusLabel: 'Picked up / In transit',
      isLocationShared: true,
      locationStatus: 'STALE',
      location: {
        latitude: 17.9714,
        longitude: -76.7931,
        capturedAt: staleCapturedAt.toISOString(),
        stale: true,
        label: 'Last reported location',
      },
    });
  });

  it('keeps delivery status visible when no GPS coordinates have been captured yet', async () => {
    const record = makeOrderRecord();
    const vendorOrder = record.vendorOrders[0]!;
    vendorOrder.cargoAssignments = [];
    vendorOrder.delivery!.runStop = {
      deliveryRun: {
        fleetAsset: makeVehicle({
          lastLatitude: null,
          lastLongitude: null,
          lastGpsCapturedAt: null,
          lastTelemetryReceivedAt: null,
        }),
      },
    };
    ordersRepository.findOrderTrackingById.mockResolvedValue(record);

    const result = await service.getOrderTracking('customer-1', 'order-1', NOW);

    expect(result.hasActiveTracking).toBe(true);
    expect(result.deliveries[0]).toMatchObject({
      stage: 'IN_TRANSIT',
      statusLabel: 'Picked up / In transit',
      onBoard: true,
      isLocationShared: false,
      locationStatus: 'UNAVAILABLE',
      location: null,
    });
  });

  it('falls back to runStop vehicle when in transit without cargo assignments', async () => {
    const record = makeOrderRecord();
    const vendorOrder = record.vendorOrders[0]!;
    vendorOrder.cargoAssignments = [];
    vendorOrder.delivery!.runStop = {
      deliveryRun: {
        fleetAsset: makeVehicle({
          lastLatitude: 17.9414,
          lastLongitude: -77.1089,
        }),
      },
    };
    ordersRepository.findOrderTrackingById.mockResolvedValue(record);

    const result = await service.getOrderTracking('customer-1', 'order-1', NOW);
    expect(result.deliveries[0]?.location).toMatchObject({
      latitude: 17.9414,
      longitude: -77.1089,
      stale: false,
    });
  });

  it('stops sharing location immediately on handover even while the vehicle continues its route', async () => {
    const record = makeOrderRecord();
    // Vehicle has a brand new live GPS update, vendorOrder is still IN_TRANSIT operationally,
    // and deliveredAt is not stamped yet, but customer cargo compartment assignment was unloaded.
    record.vendorOrders[0]!.cargoAssignments[0] = {
      quantityUnits: 2,
      handedOverQuantity: 2,
      unloadedAt: new Date(NOW.getTime() - 10_000),
      fleetAsset: makeVehicle({
        lastGpsCapturedAt: NOW,
        lastTelemetryReceivedAt: NOW,
      }),
    };
    ordersRepository.findOrderTrackingById.mockResolvedValue(record);

    const result = await service.getOrderTracking('customer-1', 'order-1', NOW);

    expect(result.hasActiveTracking).toBe(false);
    expect(result.deliveries[0]).toMatchObject({
      stage: 'HANDED_OVER',
      statusLabel: 'Handed over',
      onBoard: false,
      isLocationShared: false,
      locationStatus: 'ENDED',
      location: null,
    });
  });

  it.each([
    [
      'delivered',
      { status: VendorOrderStatus.DELIVERED },
      { deliveredAt: NOW },
      'DELIVERED',
    ],
    [
      'returned / customer rejected',
      { status: VendorOrderStatus.DELIVERED },
      {
        deliveredAt: NOW,
        customerAcceptanceStatus: CustomerAcceptanceStatus.REJECTED,
        customerRejectedAt: NOW,
      },
      'RETURNED',
    ],
    [
      'cancelled',
      { status: VendorOrderStatus.CANCELLED },
      {},
      'CANCELLED',
    ],
    [
      'failed',
      { status: VendorOrderStatus.DELIVERY_FAILED },
      { failedAt: NOW },
      'FAILED',
    ],
  ])('stops sharing location when delivery is %s', async (_label, voOverrides, delOverrides, expectedStage) => {
    const record = makeOrderRecord();
    const vendorOrder = record.vendorOrders[0]!;
    Object.assign(vendorOrder, voOverrides);
    Object.assign(vendorOrder.delivery!, delOverrides);
    ordersRepository.findOrderTrackingById.mockResolvedValue(record);

    const result = await service.getOrderTracking('customer-1', 'order-1', NOW);
    const firstDelivery = result.deliveries[0]!;

    expect(result.hasActiveTracking).toBe(false);
    expect(firstDelivery.stage).toBe(expectedStage);
    expect(firstDelivery.isLocationShared).toBe(false);
    expect(firstDelivery.location).toBeNull();
  });
});
