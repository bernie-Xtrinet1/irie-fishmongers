import { RoleName } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { SeafoodLotResponseEntity } from '../entities/seafood-lot-response.entity';
import { SeafoodLotPublicEntity } from '../entities/seafood-lot-public.entity';
import { SeafoodLotsService } from '../services/seafood-lots.service';
import { SeafoodLotsController } from './seafood-lots.controller';

const lot: SeafoodLotResponseEntity = {
  id: 'lot-1',
  lotNumber: 'LOT-2026-000001',
  vendorId: 'vendor-1',
  species: 'Snapper',
  storageType: 'FRESH',
  catchDate: new Date(),
  catchLocation: 'North Coast',
  landingSite: 'Falmouth Landing Site',
  weight: '20',
  weightUnit: 'POUNDS',
  freshnessGrade: null,
  qualityScore: null,
  foodSafetyStatus: 'SAFE',
  statusNotes: null,
  createdAt: new Date(),
};

const publicLot: SeafoodLotPublicEntity = {
  lotNumber: 'LOT-2026-000001',
  species: 'Snapper',
  storageType: 'FRESH',
  catchDate: new Date(),
  catchLocation: 'North Coast',
  landingSite: 'Falmouth Landing Site',
  freshnessGrade: null,
  vendorBusinessName: "Vera's Catch",
  temperatureVerified: true,
};

const vendorUser: RequestUser = { id: 'vendor-user-1', email: 'v@example.com', roles: [RoleName.VENDOR] };

describe('SeafoodLotsController', () => {
  let seafoodLotsService: jest.Mocked<
    Pick<SeafoodLotsService, 'register' | 'getMine' | 'list' | 'getPublicById' | 'getById' | 'updateStatus'>
  >;
  let controller: SeafoodLotsController;

  beforeEach(() => {
    seafoodLotsService = {
      register: jest.fn().mockResolvedValue(lot),
      getMine: jest.fn().mockResolvedValue({ items: [lot], total: 1, page: 1, pageSize: 20 }),
      list: jest.fn().mockResolvedValue({ items: [lot], total: 1, page: 1, pageSize: 20 }),
      getPublicById: jest.fn().mockResolvedValue(publicLot),
      getById: jest.fn().mockResolvedValue(lot),
      updateStatus: jest.fn().mockResolvedValue({ ...lot, foodSafetyStatus: 'QUARANTINED' }),
    };
    controller = new SeafoodLotsController(seafoodLotsService as unknown as SeafoodLotsService);
  });

  it('registers a lot', async () => {
    const dto = {
      species: 'Snapper',
      storageType: 'FRESH' as const,
      catchDate: '2026-01-15',
      weight: 20,
      weightUnit: 'POUNDS' as const,
    };
    await expect(controller.register(vendorUser, dto)).resolves.toEqual(lot);
    expect(seafoodLotsService.register).toHaveBeenCalledWith('vendor-user-1', dto);
  });

  it("lists the vendor's own lots", async () => {
    const result = await controller.getMine(vendorUser, { page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
    expect(seafoodLotsService.getMine).toHaveBeenCalledWith('vendor-user-1', { page: 1, pageSize: 20 });
  });

  it('lists lots (admin)', async () => {
    const dto = { page: 1, pageSize: 20 };
    const result = await controller.list(dto);
    expect(result.total).toBe(1);
    expect(seafoodLotsService.list).toHaveBeenCalledWith(dto);
  });

  it('gets the public traceability view', async () => {
    await expect(controller.getPublic('lot-1')).resolves.toEqual(publicLot);
    expect(seafoodLotsService.getPublicById).toHaveBeenCalledWith('lot-1');
  });

  it('gets a lot by id (admin)', async () => {
    await expect(controller.getById('lot-1')).resolves.toEqual(lot);
    expect(seafoodLotsService.getById).toHaveBeenCalledWith('lot-1');
  });

  it('updates a lot status (admin)', async () => {
    const adminUser: RequestUser = { id: 'admin-1', email: 'a@example.com', roles: [RoleName.ADMINISTRATOR] };
    const dto = { status: 'QUARANTINED' as const, reason: 'Cleared after review' };
    const req = { ip: '127.0.0.1' } as unknown as import('express').Request;
    const result = await controller.updateStatus(adminUser, 'lot-1', dto, req);
    expect(result.foodSafetyStatus).toBe('QUARANTINED');
    expect(seafoodLotsService.updateStatus).toHaveBeenCalledWith(
      'admin-1',
      'lot-1',
      'QUARANTINED',
      'Cleared after review',
      '127.0.0.1',
    );
  });
});
