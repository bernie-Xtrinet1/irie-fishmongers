import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Driver, FleetAsset, Prisma } from '@prisma/client';

import { DeliveryRunResponseEntity } from '../../delivery/entities/delivery-run-response.entity';
import {
  DeliveryRunsRepository,
  DeliveryRunWithDispatchContext,
} from '../../delivery/repositories/delivery-runs.repository';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { DeliveryRunsService } from '../../delivery/services/delivery-runs.service';
import { FleetAssetsRepository } from '../../fleet/repositories/fleet-assets.repository';
import { DispatchDecisionLogsRepository } from '../repositories/dispatch-decision-logs.repository';
import { DispatchService } from './dispatch.service';

function decimal(value: number): Prisma.Decimal {
  return { toNumber: () => value, toString: () => String(value) } as unknown as Prisma.Decimal;
}

function buildDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: 'driver-1',
    userId: 'driver-user-1',
    licensePlate: 'AB 1234',
    vehicleType: 'CAR',
    vehicleOwnership: 'PERSONAL_VEHICLE',
    status: 'APPROVED',
    availabilityStatus: 'ONLINE',
    capacityLbs: decimal(100),
    coldChainCapable: false,
    assignedZoneId: 'zone-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildFleetAsset(overrides: Partial<FleetAsset> = {}): FleetAsset {
  return {
    id: 'asset-1',
    zoneId: 'zone-1',
    assetType: 'VAN',
    ownership: 'COMPANY_OWNED',
    licensePlate: 'ZN 1234',
    capacityLbs: decimal(200),
    coldChainCapable: false,
    status: 'ACTIVE',
    currentDriverId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildRunContext(
  overrides: Partial<DeliveryRunWithDispatchContext> = {},
  itemOverrides: { weightLbs: number | null; lotId: string | null; quantity: number }[] = [
    { weightLbs: 10, lotId: null, quantity: 5 },
  ],
): DeliveryRunWithDispatchContext {
  return {
    id: 'run-1',
    zoneId: 'zone-1',
    driverId: null,
    fleetAssetId: null,
    status: 'PLANNED',
    createdAt: new Date(),
    updatedAt: new Date(),
    stops: [
      {
        id: 'stop-1',
        deliveryRunId: 'run-1',
        deliveryId: 'delivery-1',
        sequence: 1,
        delivery: {
          vendorOrder: {
            items: itemOverrides.map((item, index) => ({
              id: `item-${index}`,
              quantity: item.quantity,
              product: {
                weightLbs: item.weightLbs === null ? null : decimal(item.weightLbs),
                lotId: item.lotId,
              },
            })),
          },
        },
      },
    ],
    ...overrides,
  } as unknown as DeliveryRunWithDispatchContext;
}

describe('DispatchService', () => {
  let deliveryRunsRepository: jest.Mocked<Pick<DeliveryRunsRepository, 'findByIdWithDispatchContext'>>;
  let deliveryRunsService: jest.Mocked<Pick<DeliveryRunsService, 'assign'>>;
  let driversRepository: jest.Mocked<Pick<DriversRepository, 'findDispatchCandidates'>>;
  let fleetAssetsRepository: jest.Mocked<Pick<FleetAssetsRepository, 'findDispatchCandidates'>>;
  let dispatchDecisionLogsRepository: jest.Mocked<Pick<DispatchDecisionLogsRepository, 'create'>>;
  let service: DispatchService;

  beforeEach(() => {
    deliveryRunsRepository = { findByIdWithDispatchContext: jest.fn() };
    deliveryRunsService = { assign: jest.fn() };
    driversRepository = { findDispatchCandidates: jest.fn() };
    fleetAssetsRepository = { findDispatchCandidates: jest.fn() };
    dispatchDecisionLogsRepository = { create: jest.fn() };

    service = new DispatchService(
      deliveryRunsRepository as unknown as DeliveryRunsRepository,
      deliveryRunsService as unknown as DeliveryRunsService,
      driversRepository as unknown as DriversRepository,
      fleetAssetsRepository as unknown as FleetAssetsRepository,
      dispatchDecisionLogsRepository as unknown as DispatchDecisionLogsRepository,
    );
  });

  it('throws NotFoundException when the delivery run does not exist', async () => {
    deliveryRunsRepository.findByIdWithDispatchContext.mockResolvedValue(null);
    await expect(service.dispatch('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws BadRequestException when the run is not PLANNED', async () => {
    deliveryRunsRepository.findByIdWithDispatchContext.mockResolvedValue(
      buildRunContext({ status: 'IN_PROGRESS' }),
    );
    await expect(service.dispatch('run-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('selects the tightest-fit eligible driver and fleet asset, then calls assign()', async () => {
    // 50lb total weight (10lb/item x 5 qty). A 60lb driver is a tighter fit
    // than a 100lb driver, so it should win despite arriving second.
    deliveryRunsRepository.findByIdWithDispatchContext.mockResolvedValue(buildRunContext());
    driversRepository.findDispatchCandidates.mockResolvedValue([
      buildDriver({ id: 'driver-loose', capacityLbs: decimal(100) }),
      buildDriver({ id: 'driver-tight', capacityLbs: decimal(60) }),
    ]);
    fleetAssetsRepository.findDispatchCandidates.mockResolvedValue([
      buildFleetAsset({ id: 'asset-1', capacityLbs: decimal(200) }),
    ]);
    deliveryRunsService.assign.mockResolvedValue({} as DeliveryRunResponseEntity);

    await service.dispatch('run-1');

    expect(deliveryRunsService.assign).toHaveBeenCalledWith('run-1', {
      driverId: 'driver-tight',
      fleetAssetId: 'asset-1',
    });
    expect(dispatchDecisionLogsRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryRunId: 'run-1',
        requiresColdChain: false,
        totalWeightLbs: 50,
        selectedDriverId: 'driver-tight',
        selectedAssetId: 'asset-1',
      }),
    );
  });

  it('excludes a driver whose capacity is below the total weight', async () => {
    deliveryRunsRepository.findByIdWithDispatchContext.mockResolvedValue(buildRunContext());
    driversRepository.findDispatchCandidates.mockResolvedValue([
      buildDriver({ id: 'driver-too-small', capacityLbs: decimal(10) }),
      buildDriver({ id: 'driver-sufficient', capacityLbs: decimal(50) }),
    ]);
    fleetAssetsRepository.findDispatchCandidates.mockResolvedValue([]);
    deliveryRunsService.assign.mockResolvedValue({} as DeliveryRunResponseEntity);

    await service.dispatch('run-1');

    expect(deliveryRunsService.assign).toHaveBeenCalledWith('run-1', {
      driverId: 'driver-sufficient',
      fleetAssetId: undefined,
    });
  });

  it('treats a null driver capacity as unlimited and eligible', async () => {
    deliveryRunsRepository.findByIdWithDispatchContext.mockResolvedValue(buildRunContext());
    driversRepository.findDispatchCandidates.mockResolvedValue([
      buildDriver({ id: 'driver-unlimited', capacityLbs: null }),
    ]);
    fleetAssetsRepository.findDispatchCandidates.mockResolvedValue([]);
    deliveryRunsService.assign.mockResolvedValue({} as DeliveryRunResponseEntity);

    await service.dispatch('run-1');

    expect(deliveryRunsService.assign).toHaveBeenCalledWith('run-1', {
      driverId: 'driver-unlimited',
      fleetAssetId: undefined,
    });
  });

  it('throws ConflictException and logs the decision when no eligible driver exists', async () => {
    deliveryRunsRepository.findByIdWithDispatchContext.mockResolvedValue(buildRunContext());
    driversRepository.findDispatchCandidates.mockResolvedValue([]);
    fleetAssetsRepository.findDispatchCandidates.mockResolvedValue([]);

    await expect(service.dispatch('run-1')).rejects.toBeInstanceOf(ConflictException);

    expect(dispatchDecisionLogsRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ selectedDriverId: null, selectedAssetId: null }),
    );
    expect(deliveryRunsService.assign).not.toHaveBeenCalled();
  });

  it('computes requiresColdChain from any item tied to a seafood lot', async () => {
    deliveryRunsRepository.findByIdWithDispatchContext.mockResolvedValue(
      buildRunContext({}, [{ weightLbs: 5, lotId: 'lot-1', quantity: 1 }]),
    );
    driversRepository.findDispatchCandidates.mockResolvedValue([buildDriver()]);
    fleetAssetsRepository.findDispatchCandidates.mockResolvedValue([]);
    deliveryRunsService.assign.mockResolvedValue({} as DeliveryRunResponseEntity);

    await service.dispatch('run-1');

    expect(driversRepository.findDispatchCandidates).toHaveBeenCalledWith('zone-1', true);
    expect(fleetAssetsRepository.findDispatchCandidates).toHaveBeenCalledWith('zone-1', true);
  });
});
