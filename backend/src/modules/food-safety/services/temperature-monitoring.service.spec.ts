import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  Driver,
  SeafoodLot,
  TemperatureAlert,
  TemperatureDevice,
  TemperatureReading,
  TemperatureThreshold,
  Vendor,
} from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateTemperatureReadingDto } from '../dto/create-temperature-reading.dto';
import { EmergencyResponsesRepository } from '../repositories/emergency-responses.repository';
import { SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { TemperatureAlertsRepository } from '../repositories/temperature-alerts.repository';
import { TemperatureDevicesRepository } from '../repositories/temperature-devices.repository';
import { TemperatureReadingsRepository } from '../repositories/temperature-readings.repository';
import { TemperatureThresholdsRepository } from '../repositories/temperature-thresholds.repository';
import { SeafoodLotsService } from './seafood-lots.service';
import { TemperatureMonitoringService } from './temperature-monitoring.service';

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
    termsAcceptedAt: new Date(),
    primaryZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
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

function buildLot(overrides: Partial<SeafoodLot> = {}): SeafoodLot {
  return {
    id: 'lot-1',
    lotNumber: 'LOT-2026-000001',
    publicTraceToken: 'trace-token-1',
    vendorId: 'vendor-1',
    catchItemId: null,
    species: 'Snapper',
    speciesId: null,
    storageType: 'FRESH',
    catchDate: new Date(),
    catchLocation: null,
    landingSite: null,
    weight: { toString: () => '20' } as unknown as SeafoodLot['weight'],
    weightUnit: 'POUNDS',
    freshnessGrade: null,
    qualityScore: null,
    foodSafetyStatus: 'SAFE',
    statusNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildReading(overrides: Partial<TemperatureReading> = {}): TemperatureReading {
  return {
    id: 'reading-1',
    lotId: 'lot-1',
    deviceId: null,
    checkpoint: 'VENDOR_STORAGE',
    temperatureC: { toString: () => '2.5' } as unknown as TemperatureReading['temperatureC'],
    recordedById: 'vendor-user-1',
    latitude: null,
    longitude: null,
    photoUrl: null,
    recordedAt: new Date(),
    ...overrides,
  };
}

function buildAlert(overrides: Partial<TemperatureAlert> = {}): TemperatureAlert {
  return {
    id: 'alert-1',
    readingId: 'reading-1',
    lotId: 'lot-1',
    severity: 'WARNING',
    actualC: { toString: () => '8' } as unknown as TemperatureAlert['actualC'],
    resolved: false,
    resolvedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function buildThreshold(overrides: Partial<TemperatureThreshold> = {}): TemperatureThreshold {
  return {
    id: 'threshold-fresh',
    deviceId: null,
    storageType: 'FRESH',
    minC: { toNumber: () => 0 } as unknown as TemperatureThreshold['minC'],
    maxC: { toNumber: () => 4 } as unknown as TemperatureThreshold['maxC'],
    warningBandC: { toNumber: () => 3 } as unknown as TemperatureThreshold['warningBandC'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildFrozenThreshold(overrides: Partial<TemperatureThreshold> = {}): TemperatureThreshold {
  return buildThreshold({
    id: 'threshold-frozen',
    storageType: 'FROZEN',
    minC: { toNumber: () => -100 } as unknown as TemperatureThreshold['minC'],
    maxC: { toNumber: () => -18 } as unknown as TemperatureThreshold['maxC'],
    ...overrides,
  });
}

function buildDevice(overrides: Partial<TemperatureDevice> = {}): TemperatureDevice {
  return {
    id: 'device-1',
    vendorId: 'vendor-1',
    deviceCode: 'DEV-001',
    status: 'ACTIVE',
    lastSeenAt: null,
    lastCalibratedAt: null,
    calibrationDueAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('TemperatureMonitoringService', () => {
  let readingsRepository: jest.Mocked<Pick<TemperatureReadingsRepository, 'create' | 'findByLotId'>>;
  let alertsRepository: jest.Mocked<
    Pick<TemperatureAlertsRepository, 'create' | 'findById' | 'resolve' | 'findMany'>
  >;
  let lotsRepository: jest.Mocked<Pick<SeafoodLotsRepository, 'findById' | 'updateStatus'>>;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findByUserId'>>;
  let driversRepository: jest.Mocked<Pick<DriversRepository, 'findByUserId'>>;
  let seafoodLotsService: jest.Mocked<Pick<SeafoodLotsService, 'assertOwnedByRequester'>>;
  let thresholdsRepository: jest.Mocked<
    Pick<TemperatureThresholdsRepository, 'findByDeviceAndStorageType' | 'findPlatformDefault'>
  >;
  let devicesRepository: jest.Mocked<Pick<TemperatureDevicesRepository, 'touchLastSeen'>>;
  let emergencyResponsesRepository: jest.Mocked<Pick<EmergencyResponsesRepository, 'create'>>;
  let service: TemperatureMonitoringService;

  beforeEach(() => {
    readingsRepository = { create: jest.fn(), findByLotId: jest.fn() };
    alertsRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      resolve: jest.fn(),
      findMany: jest.fn(),
    };
    lotsRepository = { findById: jest.fn(), updateStatus: jest.fn() };
    vendorsRepository = { findByUserId: jest.fn() };
    driversRepository = { findByUserId: jest.fn() };
    seafoodLotsService = { assertOwnedByRequester: jest.fn() };
    thresholdsRepository = {
      findByDeviceAndStorageType: jest.fn(),
      findPlatformDefault: jest.fn().mockResolvedValue(buildThreshold()),
    };
    devicesRepository = { touchLastSeen: jest.fn().mockResolvedValue(buildDevice()) };
    emergencyResponsesRepository = { create: jest.fn() };

    service = new TemperatureMonitoringService(
      readingsRepository as unknown as TemperatureReadingsRepository,
      alertsRepository as unknown as TemperatureAlertsRepository,
      lotsRepository as unknown as SeafoodLotsRepository,
      vendorsRepository as unknown as VendorsRepository,
      driversRepository as unknown as DriversRepository,
      seafoodLotsService as unknown as SeafoodLotsService,
      thresholdsRepository as unknown as TemperatureThresholdsRepository,
      devicesRepository as unknown as TemperatureDevicesRepository,
      emergencyResponsesRepository as unknown as EmergencyResponsesRepository,
    );
  });

  describe('recordReading', () => {
    const dto: CreateTemperatureReadingDto = {
      lotId: 'lot-1',
      checkpoint: 'VENDOR_STORAGE',
      temperatureC: 2.5,
      latitude: 17.9714,
      longitude: -76.7931,
      photoUrl: 'https://cdn.example.com/reading.jpg',
    };

    it('throws NotFoundException when the lot does not exist', async () => {
      lotsRepository.findById.mockResolvedValue(null);
      await expect(service.recordReading('vendor-user-1', dto)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('records a reading for the owning vendor with no alert when within the safe band', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      readingsRepository.create.mockResolvedValue(buildReading());

      const result = await service.recordReading('vendor-user-1', dto);

      expect(result.alert).toBeUndefined();
      expect(result.reading.id).toBe('reading-1');
      expect(alertsRepository.create).not.toHaveBeenCalled();
      expect(lotsRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when a vendor does not own the lot', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ id: 'vendor-2' }));

      await expect(service.recordReading('vendor-user-1', dto)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows an approved driver to record a reading', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(null);
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      readingsRepository.create.mockResolvedValue(buildReading());

      const result = await service.recordReading('driver-user-1', dto);
      expect(result.reading.id).toBe('reading-1');
    });

    it('throws ForbiddenException when the driver is not approved', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(null);
      driversRepository.findByUserId.mockResolvedValue(buildDriver({ status: 'PENDING' }));

      await expect(service.recordReading('driver-user-1', dto)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws ForbiddenException when the requester is neither a vendor nor a driver', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(null);
      driversRepository.findByUserId.mockResolvedValue(null);

      await expect(service.recordReading('random-user', dto)).rejects.toBeInstanceOf(ForbiddenException);
    });

    describe('severity thresholds for FRESH storage (safe band 0-4C)', () => {
      it('does not raise an alert at the low edge of the safe band (0C)', async () => {
        lotsRepository.findById.mockResolvedValue(buildLot({ storageType: 'FRESH' }));
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        readingsRepository.create.mockResolvedValue(buildReading());

        const result = await service.recordReading('vendor-user-1', { ...dto, temperatureC: 0 });
        expect(result.alert).toBeUndefined();
      });

      it('does not raise an alert at the high edge of the safe band (4C)', async () => {
        lotsRepository.findById.mockResolvedValue(buildLot({ storageType: 'FRESH' }));
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        readingsRepository.create.mockResolvedValue(buildReading());

        const result = await service.recordReading('vendor-user-1', { ...dto, temperatureC: 4 });
        expect(result.alert).toBeUndefined();
      });

      it('raises a WARNING when below the minimum (< 0C)', async () => {
        lotsRepository.findById.mockResolvedValue(buildLot({ storageType: 'FRESH' }));
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        readingsRepository.create.mockResolvedValue(buildReading({ temperatureC: { toString: () => '-1' } as unknown as TemperatureReading['temperatureC'] }));
        alertsRepository.create.mockResolvedValue(buildAlert({ severity: 'WARNING' }));

        const result = await service.recordReading('vendor-user-1', { ...dto, temperatureC: -1 });
        expect(result.alert?.severity).toBe('WARNING');
      });

      it('raises a WARNING between 4C (exclusive) and 7C (inclusive)', async () => {
        lotsRepository.findById.mockResolvedValue(buildLot({ storageType: 'FRESH' }));
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        readingsRepository.create.mockResolvedValue(buildReading());
        alertsRepository.create.mockResolvedValue(buildAlert({ severity: 'WARNING' }));

        const result = await service.recordReading('vendor-user-1', { ...dto, temperatureC: 7 });
        expect(result.alert?.severity).toBe('WARNING');
      });

      it('raises a CRITICAL above 7C', async () => {
        lotsRepository.findById.mockResolvedValue(buildLot({ storageType: 'FRESH', foodSafetyStatus: 'SAFE' }));
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        readingsRepository.create.mockResolvedValue(buildReading());
        alertsRepository.create.mockResolvedValue(buildAlert({ severity: 'CRITICAL' }));
        lotsRepository.updateStatus.mockResolvedValue(buildLot({ foodSafetyStatus: 'UNDER_REVIEW' }));

        const result = await service.recordReading('vendor-user-1', { ...dto, temperatureC: 7.1 });

        expect(result.alert?.severity).toBe('CRITICAL');
        expect(lotsRepository.updateStatus).toHaveBeenCalledWith(
          'lot-1',
          'UNDER_REVIEW',
          expect.stringContaining('critical temperature reading'),
        );
      });
    });

    describe('severity thresholds for FROZEN storage (safe band <= -18C)', () => {
      beforeEach(() => {
        thresholdsRepository.findPlatformDefault.mockResolvedValue(buildFrozenThreshold());
      });

      it('does not raise an alert at or below -18C', async () => {
        lotsRepository.findById.mockResolvedValue(buildLot({ storageType: 'FROZEN' }));
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        readingsRepository.create.mockResolvedValue(buildReading());

        const result = await service.recordReading('vendor-user-1', { ...dto, temperatureC: -18 });
        expect(result.alert).toBeUndefined();
      });

      it('raises a WARNING between -18C (exclusive) and -15C (inclusive)', async () => {
        lotsRepository.findById.mockResolvedValue(buildLot({ storageType: 'FROZEN' }));
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        readingsRepository.create.mockResolvedValue(buildReading());
        alertsRepository.create.mockResolvedValue(buildAlert({ severity: 'WARNING' }));

        const result = await service.recordReading('vendor-user-1', { ...dto, temperatureC: -15 });
        expect(result.alert?.severity).toBe('WARNING');
      });

      it('raises a CRITICAL above -15C', async () => {
        lotsRepository.findById.mockResolvedValue(buildLot({ storageType: 'FROZEN', foodSafetyStatus: 'SAFE' }));
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        readingsRepository.create.mockResolvedValue(buildReading());
        alertsRepository.create.mockResolvedValue(buildAlert({ severity: 'CRITICAL' }));
        lotsRepository.updateStatus.mockResolvedValue(buildLot({ foodSafetyStatus: 'UNDER_REVIEW' }));

        const result = await service.recordReading('vendor-user-1', { ...dto, temperatureC: -14.9 });
        expect(result.alert?.severity).toBe('CRITICAL');
      });
    });

    it('does not downgrade a lot that is already non-SAFE on a CRITICAL reading', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot({ storageType: 'FRESH', foodSafetyStatus: 'QUARANTINED' }));
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      readingsRepository.create.mockResolvedValue(buildReading());
      alertsRepository.create.mockResolvedValue(buildAlert({ severity: 'CRITICAL' }));

      const result = await service.recordReading('vendor-user-1', { ...dto, temperatureC: 10 });

      expect(result.alert?.severity).toBe('CRITICAL');
      expect(lotsRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('raises an EMERGENCY and quarantines the lot when far outside the safe band', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot({ storageType: 'FRESH', foodSafetyStatus: 'SAFE' }));
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      readingsRepository.create.mockResolvedValue(buildReading());
      alertsRepository.create.mockResolvedValue(buildAlert({ severity: 'EMERGENCY' }));
      lotsRepository.updateStatus.mockResolvedValue(buildLot({ foodSafetyStatus: 'QUARANTINED' }));

      const result = await service.recordReading('vendor-user-1', { ...dto, temperatureC: 11 });

      expect(result.alert?.severity).toBe('EMERGENCY');
      expect(lotsRepository.updateStatus).toHaveBeenCalledWith(
        'lot-1',
        'QUARANTINED',
        expect.stringContaining('emergency temperature reading'),
      );
      expect(emergencyResponsesRepository.create).toHaveBeenCalledWith('alert-1');
    });

    it('does not re-quarantine a lot that is already RECALLED on an EMERGENCY reading', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot({ storageType: 'FRESH', foodSafetyStatus: 'RECALLED' }));
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      readingsRepository.create.mockResolvedValue(buildReading());
      alertsRepository.create.mockResolvedValue(buildAlert({ severity: 'EMERGENCY' }));

      const result = await service.recordReading('vendor-user-1', { ...dto, temperatureC: 11 });

      expect(result.alert?.severity).toBe('EMERGENCY');
      expect(lotsRepository.updateStatus).not.toHaveBeenCalled();
      expect(emergencyResponsesRepository.create).toHaveBeenCalledWith('alert-1');
    });

    it('does not create an EmergencyResponse for a CRITICAL (non-EMERGENCY) reading', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot({ storageType: 'FRESH', foodSafetyStatus: 'SAFE' }));
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      readingsRepository.create.mockResolvedValue(buildReading());
      alertsRepository.create.mockResolvedValue(buildAlert({ severity: 'CRITICAL' }));

      await service.recordReading('vendor-user-1', { ...dto, temperatureC: 7.1 });

      expect(emergencyResponsesRepository.create).not.toHaveBeenCalled();
    });

    it('touches the device lastSeenAt when a deviceId is supplied', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      readingsRepository.create.mockResolvedValue(buildReading({ deviceId: 'device-1' }));

      await service.recordReading('vendor-user-1', { ...dto, deviceId: 'device-1' });

      expect(devicesRepository.touchLastSeen).toHaveBeenCalledWith('device-1');
    });

    it('does not touch any device when no deviceId is supplied', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      readingsRepository.create.mockResolvedValue(buildReading());

      await service.recordReading('vendor-user-1', dto);

      expect(devicesRepository.touchLastSeen).not.toHaveBeenCalled();
    });

    it('prefers a device-specific threshold over the platform default', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      readingsRepository.create.mockResolvedValue(buildReading({ deviceId: 'device-1' }));
      thresholdsRepository.findByDeviceAndStorageType.mockResolvedValue(
        buildThreshold({ id: 'threshold-device', deviceId: 'device-1', maxC: { toNumber: () => 10 } as unknown as TemperatureThreshold['maxC'] }),
      );

      const result = await service.recordReading('vendor-user-1', {
        ...dto,
        deviceId: 'device-1',
        temperatureC: 6,
      });

      expect(thresholdsRepository.findByDeviceAndStorageType).toHaveBeenCalledWith('device-1', 'FRESH');
      expect(thresholdsRepository.findPlatformDefault).not.toHaveBeenCalled();
      expect(result.alert).toBeUndefined();
    });

    it('raises no alert when no threshold is configured for the storage type', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      readingsRepository.create.mockResolvedValue(buildReading());
      thresholdsRepository.findPlatformDefault.mockResolvedValue(null);

      const result = await service.recordReading('vendor-user-1', { ...dto, temperatureC: 100 });

      expect(result.alert).toBeUndefined();
      expect(alertsRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('getReadingsForLot', () => {
    const user: RequestUser = { id: 'vendor-user-1', email: 'v@example.com', roles: ['VENDOR'] as never };

    it("returns a lot's reading history after an ownership check", async () => {
      seafoodLotsService.assertOwnedByRequester.mockResolvedValue(
        undefined as unknown as Awaited<ReturnType<SeafoodLotsService['assertOwnedByRequester']>>,
      );
      readingsRepository.findByLotId.mockResolvedValue({ items: [buildReading()], total: 1 });

      const result = await service.getReadingsForLot(user, 'lot-1', { page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(seafoodLotsService.assertOwnedByRequester).toHaveBeenCalledWith(user, 'lot-1');
    });
  });

  describe('listAlerts', () => {
    it('lists alerts with filters applied', async () => {
      alertsRepository.findMany.mockResolvedValue({ items: [buildAlert()], total: 1 });

      const result = await service.listAlerts({
        page: 1,
        pageSize: 20,
        severity: 'WARNING',
        resolved: false,
      });

      expect(result.total).toBe(1);
      expect(alertsRepository.findMany).toHaveBeenCalledWith(
        { severity: 'WARNING', resolved: false },
        { skip: 0, take: 20 },
      );
    });
  });

  describe('resolveAlert', () => {
    it('resolves an alert', async () => {
      alertsRepository.findById.mockResolvedValue(buildAlert());
      alertsRepository.resolve.mockResolvedValue(buildAlert({ resolved: true, resolvedAt: new Date() }));

      const result = await service.resolveAlert('alert-1');
      expect(result.resolved).toBe(true);
    });

    it('throws when the alert does not exist', async () => {
      alertsRepository.findById.mockResolvedValue(null);
      await expect(service.resolveAlert('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
