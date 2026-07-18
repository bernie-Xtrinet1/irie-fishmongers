import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FleetAsset, FleetMaintenance } from '@prisma/client';

import { FleetMaintenanceOverdueEvent } from '../../../common/events/fleet-maintenance-overdue.event';
import { PrismaService } from '../../../database/prisma.service';
import { FleetAssetsRepository } from '../repositories/fleet-assets.repository';
import { FleetMaintenanceRepository } from '../repositories/fleet-maintenance.repository';
import { FleetMaintenanceService } from './fleet-maintenance.service';

function buildAsset(overrides: Partial<FleetAsset> = {}): FleetAsset {
  return {
    id: 'asset-1',
    zoneId: 'zone-1',
    assetType: 'TRUCK',
    ownership: 'COMPANY_OWNED',
    licensePlate: 'FL 1234',
    capacityLbs: { toNumber: () => 2000 } as FleetAsset['capacityLbs'],
    coldChainCapable: false,
    status: 'ACTIVE',
    currentDriverId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildMaintenance(overrides: Partial<FleetMaintenance> = {}): FleetMaintenance {
  return {
    id: 'maintenance-1',
    fleetAssetId: 'asset-1',
    serviceDate: new Date('2026-07-08T00:00:00.000Z'),
    mileage: null,
    technician: null,
    cost: null,
    nextServiceDue: null,
    status: 'SCHEDULED',
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('FleetMaintenanceService', () => {
  let maintenanceRepository: jest.Mocked<
    Pick<FleetMaintenanceRepository, 'create' | 'findById' | 'update' | 'findByFleetAssetId'>
  >;
  let fleetAssetsRepository: jest.Mocked<Pick<FleetAssetsRepository, 'findById'>>;
  let prisma: {
    $transaction: jest.Mock;
    fleetAsset: { update: jest.Mock };
    driver: { findUnique: jest.Mock };
  };
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emitAsync'>>;
  let service: FleetMaintenanceService;

  beforeEach(() => {
    maintenanceRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      findByFleetAssetId: jest.fn(),
    };
    fleetAssetsRepository = { findById: jest.fn() };
    prisma = {
      $transaction: jest.fn().mockImplementation((callback: (tx: unknown) => unknown) =>
        callback({ fleetAsset: { update: jest.fn() } }),
      ),
      fleetAsset: { update: jest.fn() },
      driver: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };
    service = new FleetMaintenanceService(
      maintenanceRepository as unknown as FleetMaintenanceRepository,
      fleetAssetsRepository as unknown as FleetAssetsRepository,
      prisma as unknown as PrismaService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('create', () => {
    const dto = { serviceDate: '2026-07-08T00:00:00.000Z' };

    it('creates a maintenance record for an existing fleet asset', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(buildAsset());
      maintenanceRepository.create.mockResolvedValue(buildMaintenance());

      const result = await service.create('asset-1', dto);
      expect(result.id).toBe('maintenance-1');
    });

    it('sets the fleet asset to MAINTENANCE when the record is created IN_PROGRESS', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(buildAsset());
      const txFleetAssetUpdate = jest.fn();
      prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
        callback({ fleetAsset: { update: txFleetAssetUpdate } }),
      );
      maintenanceRepository.create.mockResolvedValue(
        buildMaintenance({ status: 'IN_PROGRESS' }),
      );

      await service.create('asset-1', { ...dto, status: 'IN_PROGRESS' });

      expect(txFleetAssetUpdate).toHaveBeenCalledWith({
        where: { id: 'asset-1' },
        data: { status: 'MAINTENANCE' },
      });
    });

    it('throws when the fleet asset does not exist', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(null);
      await expect(service.create('missing', dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(maintenanceRepository.create).not.toHaveBeenCalled();
    });

    it('notifies the current driver when the record is created OVERDUE', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(buildAsset({ currentDriverId: 'driver-1' }));
      prisma.driver.findUnique.mockResolvedValue({ userId: 'driver-user-1' });
      maintenanceRepository.create.mockResolvedValue(
        buildMaintenance({ status: 'OVERDUE', nextServiceDue: new Date('2026-07-01T00:00:00.000Z') }),
      );

      await service.create('asset-1', { ...dto, status: 'OVERDUE' });

      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        FleetMaintenanceOverdueEvent.eventName,
        expect.objectContaining({ driverUserId: 'driver-user-1', licensePlate: 'FL 1234' }),
      );
    });

    it('does not notify when created OVERDUE with no driver currently assigned', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(buildAsset({ currentDriverId: null }));
      maintenanceRepository.create.mockResolvedValue(buildMaintenance({ status: 'OVERDUE' }));

      await service.create('asset-1', { ...dto, status: 'OVERDUE' });

      expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
    });
  });

  describe('findByFleetAssetId', () => {
    it('paginates maintenance records for a fleet asset', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(buildAsset());
      maintenanceRepository.findByFleetAssetId.mockResolvedValue({
        items: [buildMaintenance()],
        total: 1,
      });

      const result = await service.findByFleetAssetId('asset-1', { page: 1, pageSize: 20 });
      expect(result.total).toBe(1);
    });

    it('throws when the fleet asset does not exist', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(null);
      await expect(
        service.findByFleetAssetId('missing', { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('updates a maintenance record', async () => {
      maintenanceRepository.findById.mockResolvedValue(buildMaintenance());
      maintenanceRepository.update.mockResolvedValue(buildMaintenance({ status: 'COMPLETED' }));

      const result = await service.update('maintenance-1', { status: 'COMPLETED' });
      expect(result.status).toBe('COMPLETED');
    });

    it('sets the fleet asset to MAINTENANCE when updated to IN_PROGRESS', async () => {
      maintenanceRepository.findById.mockResolvedValue(buildMaintenance());
      maintenanceRepository.update.mockResolvedValue(
        buildMaintenance({ status: 'IN_PROGRESS' }),
      );

      await service.update('maintenance-1', { status: 'IN_PROGRESS' });

      expect(prisma.fleetAsset.update).toHaveBeenCalledWith({
        where: { id: 'asset-1' },
        data: { status: 'MAINTENANCE' },
      });
    });

    it('throws when the maintenance record does not exist', async () => {
      maintenanceRepository.findById.mockResolvedValue(null);
      await expect(service.update('missing', { status: 'COMPLETED' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('notifies the current driver when the record transitions to OVERDUE', async () => {
      maintenanceRepository.findById.mockResolvedValue(buildMaintenance({ status: 'SCHEDULED' }));
      maintenanceRepository.update.mockResolvedValue(buildMaintenance({ status: 'OVERDUE' }));
      fleetAssetsRepository.findById.mockResolvedValue(buildAsset({ currentDriverId: 'driver-1' }));
      prisma.driver.findUnique.mockResolvedValue({ userId: 'driver-user-1' });

      await service.update('maintenance-1', { status: 'OVERDUE' });

      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        FleetMaintenanceOverdueEvent.eventName,
        expect.objectContaining({ driverUserId: 'driver-user-1' }),
      );
    });

    it('does not re-notify when the record was already OVERDUE', async () => {
      maintenanceRepository.findById.mockResolvedValue(buildMaintenance({ status: 'OVERDUE' }));
      maintenanceRepository.update.mockResolvedValue(buildMaintenance({ status: 'OVERDUE' }));

      await service.update('maintenance-1', { status: 'OVERDUE' });

      expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
      expect(fleetAssetsRepository.findById).not.toHaveBeenCalled();
    });
  });
});
