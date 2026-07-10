import { RoleName } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { IncidentResponseEntity } from '../entities/incident-response.entity';
import { FoodSafetyIncidentsService } from '../services/food-safety-incidents.service';
import { FoodSafetyIncidentsController } from './food-safety-incidents.controller';

const incident: IncidentResponseEntity = {
  id: 'incident-1',
  lotId: 'lot-1',
  reportedById: 'vendor-user-1',
  severity: 'HIGH',
  status: 'OPEN',
  description: 'Packaging found torn on arrival with visible ice loss',
  photoUrl: null,
  correctiveAction: null,
  resolvedAt: null,
  createdAt: new Date(),
};

const vendorUser: RequestUser = { id: 'vendor-user-1', email: 'v@example.com', roles: [RoleName.VENDOR] };

describe('FoodSafetyIncidentsController', () => {
  let incidentsService: jest.Mocked<
    Pick<FoodSafetyIncidentsService, 'report' | 'getForLot' | 'list' | 'updateStatus'>
  >;
  let controller: FoodSafetyIncidentsController;

  beforeEach(() => {
    incidentsService = {
      report: jest.fn().mockResolvedValue(incident),
      getForLot: jest.fn().mockResolvedValue({ items: [incident], total: 1, page: 1, pageSize: 20 }),
      list: jest.fn().mockResolvedValue({ items: [incident], total: 1, page: 1, pageSize: 20 }),
      updateStatus: jest.fn().mockResolvedValue({ ...incident, status: 'INVESTIGATING' }),
    };
    controller = new FoodSafetyIncidentsController(
      incidentsService as unknown as FoodSafetyIncidentsService,
    );
  });

  it('reports an incident', async () => {
    const dto = {
      lotId: 'lot-1',
      severity: 'HIGH' as const,
      description: 'Packaging found torn on arrival with visible ice loss',
    };
    await expect(controller.report(vendorUser, dto)).resolves.toEqual(incident);
    expect(incidentsService.report).toHaveBeenCalledWith(vendorUser, dto);
  });

  it("gets a lot's incident history", async () => {
    const result = await controller.getForLot(vendorUser, 'lot-1', { page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
    expect(incidentsService.getForLot).toHaveBeenCalledWith(vendorUser, 'lot-1', { page: 1, pageSize: 20 });
  });

  it('lists incidents (admin)', async () => {
    const dto = { page: 1, pageSize: 20 };
    const result = await controller.list(dto);
    expect(result.total).toBe(1);
    expect(incidentsService.list).toHaveBeenCalledWith(dto);
  });

  it('updates an incident status (admin)', async () => {
    const adminUser: RequestUser = { id: 'admin-1', email: 'a@example.com', roles: [RoleName.ADMINISTRATOR] };
    const dto = { status: 'INVESTIGATING' as const };
    const req = { ip: '127.0.0.1' } as unknown as import('express').Request;
    const result = await controller.updateStatus(adminUser, 'incident-1', dto, req);
    expect(result.status).toBe('INVESTIGATING');
    expect(incidentsService.updateStatus).toHaveBeenCalledWith(
      'admin-1',
      'incident-1',
      'INVESTIGATING',
      undefined,
      '127.0.0.1',
    );
  });
});
