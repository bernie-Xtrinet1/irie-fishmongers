import { BadRequestException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { Driver, DriverSettlement, Prisma, SettlementRateConfig, VendorOrder } from '@prisma/client';

import { DriverLocationsRepository } from '../../delivery/repositories/driver-locations.repository';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { CreateRateConfigDto } from '../dto/create-rate-config.dto';
import {
  DeliveryForSettlement,
  DriverSettlementsRepository,
} from '../repositories/driver-settlements.repository';
import { SettlementRateConfigsRepository } from '../repositories/settlement-rate-configs.repository';
import { DriverSettlementEngine } from './driver-settlement-engine.service';
import { DriverSettlementsService } from './driver-settlements.service';

function buildRateConfig(overrides: Partial<SettlementRateConfig> = {}): SettlementRateConfig {
  return {
    id: 'rate-config-1',
    baseFee: new Prisma.Decimal(150),
    distanceCompensationEnabled: true,
    distanceRatePerKm: new Prisma.Decimal(20),
    heavyLoadThresholdLbs: new Prisma.Decimal(50),
    heavyLoadBonus: new Prisma.Decimal(200),
    peakBonus: new Prisma.Decimal(100),
    volumeBonusTier1Threshold: 20,
    volumeBonusTier1Amount: new Prisma.Decimal(1000),
    volumeBonusTier2Threshold: 40,
    volumeBonusTier2Amount: new Prisma.Decimal(3000),
    volumeBonusTier3Threshold: 60,
    volumeBonusTier3Amount: new Prisma.Decimal(5000),
    createdAt: new Date(),
    ...overrides,
  };
}

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

function buildVendorOrder(overrides: Partial<VendorOrder> = {}): VendorOrder {
  return {
    id: 'vo-1',
    orderId: 'order-1',
    vendorId: 'vendor-1',
    status: 'DELIVERED',
    subtotal: new Prisma.Decimal(1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildDelivery(overrides: Partial<DeliveryForSettlement> = {}): DeliveryForSettlement {
  return {
    id: 'delivery-1',
    vendorOrderId: 'vo-1',
    driverId: 'driver-1',
    assignedAt: new Date('2026-06-30T12:00:00.000Z'),
    pickedUpAt: new Date('2026-06-30T12:30:00.000Z'),
    deliveredAt: new Date('2026-06-30T13:00:00.000Z'),
    failedAt: null,
    failureReason: null,
    proofType: 'PHOTO',
    proofUrl: 'https://cdn.example.com/proof.jpg',
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
    driver: buildDriver(),
    vendorOrder: { ...buildVendorOrder(), items: [{
      id: 'item-1', vendorOrderId: 'vo-1', productId: 'product-1', productName: 'Snapper',
      unitPrice: new Prisma.Decimal(500), unit: 'PER_POUND', quantity: 2, subtotal: new Prisma.Decimal(1000), createdAt: new Date(),
    }] },
    ...overrides,
  };
}

function buildSettlement(overrides: Partial<DriverSettlement> = {}): DriverSettlement {
  return {
    id: 'settlement-1',
    driverId: 'driver-1',
    deliveryId: 'delivery-1',
    vehicleOwnership: 'PERSONAL_VEHICLE',
    baseFee: new Prisma.Decimal(150),
    distanceKm: new Prisma.Decimal(12),
    distanceFee: new Prisma.Decimal(240),
    heavyLoadBonus: new Prisma.Decimal(0),
    peakBonus: new Prisma.Decimal(0),
    volumeBonus: new Prisma.Decimal(0),
    totalPayout: new Prisma.Decimal(390),
    status: 'PENDING',
    settlementPeriodStart: new Date('2026-06-29T05:00:00.000Z'),
    settlementPeriodEnd: new Date('2026-07-06T04:59:59.999Z'),
    payoutDate: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('DriverSettlementsService', () => {
  let driverSettlementsRepository: jest.Mocked<
    Pick<
      DriverSettlementsRepository,
      | 'findUnsettledDeliveries'
      | 'create'
      | 'findById'
      | 'countDeliveriesInPeriod'
      | 'findVolumeBonusRow'
      | 'updateStatus'
      | 'findManyByDriver'
      | 'findMany'
    >
  >;
  let rateConfigsRepository: jest.Mocked<Pick<SettlementRateConfigsRepository, 'findCurrent' | 'create'>>;
  let driversRepository: jest.Mocked<Pick<DriversRepository, 'findByUserId'>>;
  let driverLocationsRepository: jest.Mocked<Pick<DriverLocationsRepository, 'findBetween'>>;
  let engine: jest.Mocked<
    Pick<DriverSettlementEngine, 'computeDistanceKm' | 'computeDeliveryCompensation' | 'computeVolumeBonus'>
  >;
  let service: DriverSettlementsService;

  beforeEach(() => {
    driverSettlementsRepository = {
      findUnsettledDeliveries: jest.fn(),
      create: jest.fn(),
      findById: jest.fn(),
      countDeliveriesInPeriod: jest.fn(),
      findVolumeBonusRow: jest.fn(),
      updateStatus: jest.fn(),
      findManyByDriver: jest.fn(),
      findMany: jest.fn(),
    };
    rateConfigsRepository = { findCurrent: jest.fn(), create: jest.fn() };
    driversRepository = { findByUserId: jest.fn() };
    driverLocationsRepository = { findBetween: jest.fn() };
    engine = {
      computeDistanceKm: jest.fn().mockReturnValue(12),
      computeDeliveryCompensation: jest
        .fn()
        .mockReturnValue({ baseFee: 150, distanceFee: 240, heavyLoadBonus: 0, peakBonus: 0 }),
      computeVolumeBonus: jest.fn().mockReturnValue(0),
    };

    service = new DriverSettlementsService(
      driverSettlementsRepository as unknown as DriverSettlementsRepository,
      rateConfigsRepository as unknown as SettlementRateConfigsRepository,
      driversRepository as unknown as DriversRepository,
      driverLocationsRepository as unknown as DriverLocationsRepository,
      engine,
    );
  });

  describe('generateWeeklySettlements', () => {
    it('creates a settlement row for each unsettled delivery', async () => {
      rateConfigsRepository.findCurrent.mockResolvedValue(buildRateConfig());
      driverSettlementsRepository.findUnsettledDeliveries.mockResolvedValue([buildDelivery()]);
      driverLocationsRepository.findBetween.mockResolvedValue([]);
      driverSettlementsRepository.create.mockResolvedValue(buildSettlement());
      driverSettlementsRepository.countDeliveriesInPeriod.mockResolvedValue(1);

      const result = await service.generateWeeklySettlements('2026-06-29');

      expect(result.settlementsCreated).toBe(1);
      expect(driverSettlementsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ driverId: 'driver-1', deliveryId: 'delivery-1', totalPayout: 390 }),
      );
    });

    it('falls back to assignedAt as the distance window start when pickedUpAt is not set', async () => {
      rateConfigsRepository.findCurrent.mockResolvedValue(buildRateConfig());
      const assignedAt = new Date('2026-06-30T11:00:00.000Z');
      driverSettlementsRepository.findUnsettledDeliveries.mockResolvedValue([
        buildDelivery({ pickedUpAt: null, assignedAt }),
      ]);
      driverLocationsRepository.findBetween.mockResolvedValue([]);
      driverSettlementsRepository.create.mockResolvedValue(buildSettlement());
      driverSettlementsRepository.countDeliveriesInPeriod.mockResolvedValue(1);

      await service.generateWeeklySettlements('2026-06-29');

      expect(driverLocationsRepository.findBetween).toHaveBeenCalledWith(
        'driver-1',
        assignedAt,
        expect.any(Date),
      );
    });

    it('creates one volume-bonus row per driver when a tier is reached', async () => {
      rateConfigsRepository.findCurrent.mockResolvedValue(buildRateConfig());
      driverSettlementsRepository.findUnsettledDeliveries.mockResolvedValue([buildDelivery()]);
      driverLocationsRepository.findBetween.mockResolvedValue([]);
      driverSettlementsRepository.create.mockResolvedValue(buildSettlement());
      driverSettlementsRepository.countDeliveriesInPeriod.mockResolvedValue(20);
      engine.computeVolumeBonus.mockReturnValue(1000);
      driverSettlementsRepository.findVolumeBonusRow.mockResolvedValue(null);

      const result = await service.generateWeeklySettlements('2026-06-29');

      expect(result.settlementsCreated).toBe(2);
      const bonusRowCall = driverSettlementsRepository.create.mock.calls.find(
        (call) => call[0].volumeBonus === 1000,
      );
      expect(bonusRowCall?.[0]).toMatchObject({ driverId: 'driver-1', volumeBonus: 1000, totalPayout: 1000 });
      expect(bonusRowCall?.[0].deliveryId).toBeUndefined();
    });

    it('does not duplicate the volume bonus row if one already exists for the period', async () => {
      rateConfigsRepository.findCurrent.mockResolvedValue(buildRateConfig());
      driverSettlementsRepository.findUnsettledDeliveries.mockResolvedValue([buildDelivery()]);
      driverLocationsRepository.findBetween.mockResolvedValue([]);
      driverSettlementsRepository.create.mockResolvedValue(buildSettlement());
      driverSettlementsRepository.countDeliveriesInPeriod.mockResolvedValue(20);
      engine.computeVolumeBonus.mockReturnValue(1000);
      driverSettlementsRepository.findVolumeBonusRow.mockResolvedValue(
        buildSettlement({ deliveryId: null, volumeBonus: new Prisma.Decimal(1000) }),
      );

      const result = await service.generateWeeklySettlements('2026-06-29');

      expect(result.settlementsCreated).toBe(1);
      expect(driverSettlementsRepository.create).toHaveBeenCalledTimes(1);
    });

    it('does not create a volume bonus row when no tier is reached', async () => {
      rateConfigsRepository.findCurrent.mockResolvedValue(buildRateConfig());
      driverSettlementsRepository.findUnsettledDeliveries.mockResolvedValue([buildDelivery()]);
      driverLocationsRepository.findBetween.mockResolvedValue([]);
      driverSettlementsRepository.create.mockResolvedValue(buildSettlement());
      driverSettlementsRepository.countDeliveriesInPeriod.mockResolvedValue(1);
      engine.computeVolumeBonus.mockReturnValue(0);

      const result = await service.generateWeeklySettlements('2026-06-29');

      expect(result.settlementsCreated).toBe(1);
      expect(driverSettlementsRepository.findVolumeBonusRow).not.toHaveBeenCalled();
    });

    it('groups deliveries by driver and settles each driver independently', async () => {
      rateConfigsRepository.findCurrent.mockResolvedValue(buildRateConfig());
      driverSettlementsRepository.findUnsettledDeliveries.mockResolvedValue([
        buildDelivery({ id: 'delivery-1', driverId: 'driver-1', driver: buildDriver({ id: 'driver-1' }) }),
        buildDelivery({ id: 'delivery-2', driverId: 'driver-2', driver: buildDriver({ id: 'driver-2' }) }),
      ]);
      driverLocationsRepository.findBetween.mockResolvedValue([]);
      driverSettlementsRepository.create.mockResolvedValue(buildSettlement());
      driverSettlementsRepository.countDeliveriesInPeriod.mockResolvedValue(1);

      const result = await service.generateWeeklySettlements('2026-06-29');

      expect(result.settlementsCreated).toBe(2);
      expect(driverSettlementsRepository.countDeliveriesInPeriod).toHaveBeenCalledWith(
        'driver-1',
        expect.any(Date),
        expect.any(Date),
      );
      expect(driverSettlementsRepository.countDeliveriesInPeriod).toHaveBeenCalledWith(
        'driver-2',
        expect.any(Date),
        expect.any(Date),
      );
    });

    it('settles multiple deliveries for the same driver in one run', async () => {
      rateConfigsRepository.findCurrent.mockResolvedValue(buildRateConfig());
      driverSettlementsRepository.findUnsettledDeliveries.mockResolvedValue([
        buildDelivery({ id: 'delivery-1' }),
        buildDelivery({ id: 'delivery-2' }),
      ]);
      driverLocationsRepository.findBetween.mockResolvedValue([]);
      driverSettlementsRepository.create.mockResolvedValue(buildSettlement());
      driverSettlementsRepository.countDeliveriesInPeriod.mockResolvedValue(2);

      const result = await service.generateWeeklySettlements('2026-06-29');

      expect(result.settlementsCreated).toBe(2);
      expect(driverSettlementsRepository.create).toHaveBeenCalledTimes(2);
      expect(driverSettlementsRepository.countDeliveriesInPeriod).toHaveBeenCalledTimes(1);
    });

    it('throws when no rate configuration exists', async () => {
      rateConfigsRepository.findCurrent.mockResolvedValue(null);
      await expect(service.generateWeeklySettlements('2026-06-29')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('throws on an invalid weekStart date', async () => {
      rateConfigsRepository.findCurrent.mockResolvedValue(buildRateConfig());
      await expect(service.generateWeeklySettlements('not-a-date')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('getMine', () => {
    it("returns the driver's own settlements", async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      driverSettlementsRepository.findManyByDriver.mockResolvedValue({
        items: [buildSettlement()],
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

  describe('list', () => {
    it('paginates settlements with filters', async () => {
      driverSettlementsRepository.findMany.mockResolvedValue({ items: [buildSettlement()], total: 1 });
      const result = await service.list({ page: 1, pageSize: 20, status: 'PENDING' });
      expect(result.total).toBe(1);
      expect(driverSettlementsRepository.findMany).toHaveBeenCalledWith(
        { driverId: undefined, status: 'PENDING' },
        { skip: 0, take: 20 },
      );
    });
  });

  describe('updateStatus', () => {
    it('approves a pending settlement', async () => {
      driverSettlementsRepository.findById.mockResolvedValue(buildSettlement());
      driverSettlementsRepository.updateStatus.mockResolvedValue(
        buildSettlement({ status: 'APPROVED' }),
      );

      const result = await service.updateStatus('settlement-1', 'APPROVED');
      expect(result.status).toBe('APPROVED');
      expect(driverSettlementsRepository.updateStatus).toHaveBeenCalledWith('settlement-1', 'APPROVED', {
        payoutDate: undefined,
        notes: undefined,
      });
    });

    it('sets a payout date when marking a settlement paid', async () => {
      driverSettlementsRepository.findById.mockResolvedValue(buildSettlement({ status: 'APPROVED' }));
      driverSettlementsRepository.updateStatus.mockResolvedValue(
        buildSettlement({ status: 'PAID', payoutDate: new Date() }),
      );

      await service.updateStatus('settlement-1', 'PAID');

      expect(driverSettlementsRepository.updateStatus).toHaveBeenCalledWith(
        'settlement-1',
        'PAID',
        expect.objectContaining({ payoutDate: expect.any(Date) as Date }),
      );
    });

    it('rejects skipping straight from PENDING to PAID', async () => {
      driverSettlementsRepository.findById.mockResolvedValue(buildSettlement({ status: 'PENDING' }));
      await expect(service.updateStatus('settlement-1', 'PAID')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects any transition once a settlement is PAID', async () => {
      driverSettlementsRepository.findById.mockResolvedValue(buildSettlement({ status: 'PAID' }));
      await expect(service.updateStatus('settlement-1', 'DISPUTED')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws when the settlement does not exist', async () => {
      driverSettlementsRepository.findById.mockResolvedValue(null);
      await expect(service.updateStatus('missing', 'APPROVED')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getCurrentRateConfig', () => {
    it('returns the current rate config', async () => {
      rateConfigsRepository.findCurrent.mockResolvedValue(buildRateConfig());
      const result = await service.getCurrentRateConfig();
      expect(result.baseFee).toBe('150');
    });

    it('throws when no rate config exists', async () => {
      rateConfigsRepository.findCurrent.mockResolvedValue(null);
      await expect(service.getCurrentRateConfig()).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('createRateConfig', () => {
    const dto: CreateRateConfigDto = {
      baseFee: 150,
      distanceCompensationEnabled: true,
      distanceRatePerKm: 20,
      heavyLoadThresholdLbs: 50,
      heavyLoadBonus: 200,
      peakBonus: 100,
      volumeBonusTier1Threshold: 20,
      volumeBonusTier1Amount: 1000,
      volumeBonusTier2Threshold: 40,
      volumeBonusTier2Amount: 3000,
      volumeBonusTier3Threshold: 60,
      volumeBonusTier3Amount: 5000,
    };

    it('creates a new rate config with strictly increasing tiers', async () => {
      rateConfigsRepository.create.mockResolvedValue(buildRateConfig());
      const result = await service.createRateConfig(dto);
      expect(result.baseFee).toBe('150');
      expect(rateConfigsRepository.create).toHaveBeenCalledWith(dto);
    });

    it('rejects non-increasing tier thresholds', async () => {
      await expect(
        service.createRateConfig({ ...dto, volumeBonusTier2Threshold: 20 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.createRateConfig({ ...dto, volumeBonusTier3Threshold: 40 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
