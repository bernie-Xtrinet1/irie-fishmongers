import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { FoodSafetyIncident, RoleName } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { CreateIncidentDto } from '../dto/create-incident.dto';
import { FoodSafetyIncidentsRepository } from '../repositories/food-safety-incidents.repository';
import { ComplianceAuditLogService } from './compliance-audit-log.service';
import { FoodSafetyIncidentsService } from './food-safety-incidents.service';
import { SeafoodLotsService } from './seafood-lots.service';

function buildIncident(overrides: Partial<FoodSafetyIncident> = {}): FoodSafetyIncident {
  return {
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
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('FoodSafetyIncidentsService', () => {
  let incidentsRepository: jest.Mocked<
    Pick<FoodSafetyIncidentsRepository, 'create' | 'findByLotId' | 'findMany' | 'findById' | 'updateStatus'>
  >;
  let seafoodLotsService: jest.Mocked<Pick<SeafoodLotsService, 'assertOwnedByRequester'>>;
  let auditLogService: jest.Mocked<Pick<ComplianceAuditLogService, 'record'>>;
  let service: FoodSafetyIncidentsService;

  const vendorUser: RequestUser = { id: 'vendor-user-1', email: 'v@example.com', roles: [RoleName.VENDOR] };
  const adminUser: RequestUser = { id: 'admin-1', email: 'a@example.com', roles: [RoleName.ADMINISTRATOR] };

  beforeEach(() => {
    incidentsRepository = {
      create: jest.fn(),
      findByLotId: jest.fn(),
      findMany: jest.fn(),
      findById: jest.fn(),
      updateStatus: jest.fn(),
    };
    seafoodLotsService = { assertOwnedByRequester: jest.fn() };
    auditLogService = { record: jest.fn() };

    service = new FoodSafetyIncidentsService(
      incidentsRepository as unknown as FoodSafetyIncidentsRepository,
      seafoodLotsService as unknown as SeafoodLotsService,
      auditLogService as unknown as ComplianceAuditLogService,
    );
  });

  describe('report', () => {
    const dto: CreateIncidentDto = {
      lotId: 'lot-1',
      severity: 'HIGH',
      description: 'Packaging found torn on arrival with visible ice loss',
    };

    it('allows the vendor who owns the lot to report an incident', async () => {
      seafoodLotsService.assertOwnedByRequester.mockResolvedValue(
        undefined as unknown as Awaited<ReturnType<SeafoodLotsService['assertOwnedByRequester']>>,
      );
      incidentsRepository.create.mockResolvedValue(buildIncident());

      const result = await service.report(vendorUser, dto);

      expect(result.id).toBe('incident-1');
      expect(seafoodLotsService.assertOwnedByRequester).toHaveBeenCalledWith(vendorUser, 'lot-1');
      expect(incidentsRepository.create).toHaveBeenCalledWith({
        lotId: 'lot-1',
        reportedById: 'vendor-user-1',
        severity: 'HIGH',
        description: dto.description,
        photoUrl: undefined,
      });
    });

    it('allows an administrator to report an incident', async () => {
      seafoodLotsService.assertOwnedByRequester.mockResolvedValue(
        undefined as unknown as Awaited<ReturnType<SeafoodLotsService['assertOwnedByRequester']>>,
      );
      incidentsRepository.create.mockResolvedValue(buildIncident({ reportedById: 'admin-1' }));

      const result = await service.report(adminUser, dto);
      expect(result.reportedById).toBe('admin-1');
    });

    it('rejects a requester who does not own the lot and is not an admin', async () => {
      seafoodLotsService.assertOwnedByRequester.mockRejectedValue(
        new ForbiddenException('You do not have access to this lot'),
      );

      await expect(service.report(vendorUser, dto)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('getForLot', () => {
    it("returns a lot's incident history after an ownership check", async () => {
      seafoodLotsService.assertOwnedByRequester.mockResolvedValue(
        undefined as unknown as Awaited<ReturnType<SeafoodLotsService['assertOwnedByRequester']>>,
      );
      incidentsRepository.findByLotId.mockResolvedValue({ items: [buildIncident()], total: 1 });

      const result = await service.getForLot(vendorUser, 'lot-1', { page: 1, pageSize: 20 });
      expect(result.total).toBe(1);
    });
  });

  describe('list', () => {
    it('lists incidents with filters applied', async () => {
      incidentsRepository.findMany.mockResolvedValue({ items: [buildIncident()], total: 1 });

      const result = await service.list({
        page: 1,
        pageSize: 20,
        severity: 'HIGH',
        status: 'OPEN',
      });

      expect(result.total).toBe(1);
      expect(incidentsRepository.findMany).toHaveBeenCalledWith(
        { severity: 'HIGH', status: 'OPEN' },
        { skip: 0, take: 20 },
      );
    });
  });

  describe('updateStatus', () => {
    it('throws NotFoundException when the incident does not exist', async () => {
      incidentsRepository.findById.mockResolvedValue(null);
      await expect(service.updateStatus('admin-1', 'missing', 'INVESTIGATING')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it.each([
      ['OPEN', 'INVESTIGATING'],
      ['OPEN', 'RESOLVED'],
      ['OPEN', 'CLOSED'],
      ['INVESTIGATING', 'RESOLVED'],
      ['INVESTIGATING', 'CLOSED'],
      ['RESOLVED', 'CLOSED'],
    ] as const)('allows the transition from %s to %s', async (from, to) => {
      incidentsRepository.findById.mockResolvedValue(buildIncident({ status: from }));
      incidentsRepository.updateStatus.mockResolvedValue(buildIncident({ status: to }));

      const result = await service.updateStatus('admin-1', 'incident-1', to);
      expect(result.status).toBe(to);
    });

    it('sets resolvedAt when transitioning to RESOLVED', async () => {
      incidentsRepository.findById.mockResolvedValue(buildIncident({ status: 'OPEN' }));
      incidentsRepository.updateStatus.mockResolvedValue(
        buildIncident({ status: 'RESOLVED', resolvedAt: new Date() }),
      );

      await service.updateStatus('admin-1', 'incident-1', 'RESOLVED', 'Vendor retrained on packaging procedure');

      expect(incidentsRepository.updateStatus).toHaveBeenCalledWith('incident-1', 'RESOLVED', {
        correctiveAction: 'Vendor retrained on packaging procedure',
        resolvedAt: expect.any(Date) as Date,
      });
    });

    it('does not set resolvedAt for non-RESOLVED transitions', async () => {
      incidentsRepository.findById.mockResolvedValue(buildIncident({ status: 'OPEN' }));
      incidentsRepository.updateStatus.mockResolvedValue(buildIncident({ status: 'INVESTIGATING' }));

      await service.updateStatus('admin-1', 'incident-1', 'INVESTIGATING');

      expect(incidentsRepository.updateStatus).toHaveBeenCalledWith('incident-1', 'INVESTIGATING', {
        correctiveAction: undefined,
        resolvedAt: undefined,
      });
    });

    it.each([
      ['RESOLVED', 'OPEN'],
      ['RESOLVED', 'INVESTIGATING'],
      ['CLOSED', 'OPEN'],
      ['CLOSED', 'INVESTIGATING'],
      ['CLOSED', 'RESOLVED'],
      ['OPEN', 'OPEN'],
    ] as const)('rejects the invalid transition from %s to %s', async (from, to) => {
      incidentsRepository.findById.mockResolvedValue(buildIncident({ status: from }));

      await expect(service.updateStatus('admin-1', 'incident-1', to)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
