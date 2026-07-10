import { BadRequestException, NotFoundException } from '@nestjs/common';
import { QualityInspection, SeafoodLot } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { CreateQualityInspectionDto } from '../dto/create-quality-inspection.dto';
import { QualityInspectionsRepository } from '../repositories/quality-inspections.repository';
import { SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { ComplianceAuditLogService } from './compliance-audit-log.service';
import { QualityInspectionsService } from './quality-inspections.service';
import { SeafoodLotsService } from './seafood-lots.service';

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

function buildInspection(overrides: Partial<QualityInspection> = {}): QualityInspection {
  return {
    id: 'inspection-1',
    lotId: 'lot-1',
    inspectorId: 'admin-1',
    result: 'PASSED',
    freshnessGrade: 'GRADE_A',
    qualityScore: 95,
    notes: null,
    photoUrl: null,
    inspectedAt: new Date(),
    ...overrides,
  };
}

describe('QualityInspectionsService', () => {
  let inspectionsRepository: jest.Mocked<Pick<QualityInspectionsRepository, 'create' | 'findByLotId'>>;
  let lotsRepository: jest.Mocked<Pick<SeafoodLotsRepository, 'findById' | 'updateStatus' | 'updateGrading'>>;
  let seafoodLotsService: jest.Mocked<Pick<SeafoodLotsService, 'assertOwnedByRequester'>>;
  let auditLogService: jest.Mocked<Pick<ComplianceAuditLogService, 'record'>>;
  let service: QualityInspectionsService;

  beforeEach(() => {
    inspectionsRepository = { create: jest.fn(), findByLotId: jest.fn() };
    lotsRepository = { findById: jest.fn(), updateStatus: jest.fn(), updateGrading: jest.fn() };
    seafoodLotsService = { assertOwnedByRequester: jest.fn() };
    auditLogService = { record: jest.fn() };

    service = new QualityInspectionsService(
      inspectionsRepository as unknown as QualityInspectionsRepository,
      lotsRepository as unknown as SeafoodLotsRepository,
      seafoodLotsService as unknown as SeafoodLotsService,
      auditLogService as unknown as ComplianceAuditLogService,
    );
  });

  describe('inspect', () => {
    const dto: CreateQualityInspectionDto = {
      lotId: 'lot-1',
      result: 'PASSED',
      freshnessGrade: 'GRADE_A',
      qualityScore: 95,
      notes: 'Looks great',
      photoUrl: 'https://cdn.example.com/inspection.jpg',
    };

    it('throws NotFoundException when the lot does not exist', async () => {
      lotsRepository.findById.mockResolvedValue(null);
      await expect(service.inspect('admin-1', dto)).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      ['PASSED', 'SAFE', 'GRADE_A', 95],
      ['CONDITIONAL', 'UNDER_REVIEW', 'GRADE_B', 75],
      ['REJECTED', 'REJECTED', 'REJECTED', 50],
      ['QUARANTINED', 'QUARANTINED', 'REJECTED', 40],
    ] as const)(
      'creates an inspection with result %s and updates the lot status to %s',
      async (result, expectedStatus, freshnessGrade, qualityScore) => {
        lotsRepository.findById.mockResolvedValue(buildLot({ foodSafetyStatus: 'SAFE' }));
        inspectionsRepository.create.mockResolvedValue(buildInspection({ result }));
        lotsRepository.updateGrading.mockResolvedValue(buildLot());
        lotsRepository.updateStatus.mockResolvedValue(buildLot({ foodSafetyStatus: expectedStatus }));

        const result_ = await service.inspect('admin-1', { ...dto, result, freshnessGrade, qualityScore });

        expect(result_.result).toBe(result);
        expect(lotsRepository.updateStatus).toHaveBeenCalledWith(
          'lot-1',
          expectedStatus,
          expect.stringContaining(result),
        );
      },
    );

    it('always updates grading fields on the lot', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      inspectionsRepository.create.mockResolvedValue(buildInspection());
      lotsRepository.updateGrading.mockResolvedValue(buildLot());
      lotsRepository.updateStatus.mockResolvedValue(buildLot());

      await service.inspect('admin-1', dto);

      expect(lotsRepository.updateGrading).toHaveBeenCalledWith('lot-1', {
        freshnessGrade: 'GRADE_A',
        qualityScore: 95,
      });
    });

    it('rejects a PASSED result paired with a Grade C or Rejected grade', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      await expect(
        service.inspect('admin-1', { ...dto, result: 'PASSED', freshnessGrade: 'GRADE_C' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(inspectionsRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a REJECTED result paired with a non-Rejected grade', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      await expect(
        service.inspect('admin-1', { ...dto, result: 'REJECTED', freshnessGrade: 'GRADE_B' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a Grade A score below the Premium/Excellent band', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      await expect(
        service.inspect('admin-1', { ...dto, freshnessGrade: 'GRADE_A', qualityScore: 50 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a Rejected grade with a score of 60 or above', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      await expect(
        service.inspect('admin-1', {
          ...dto,
          result: 'REJECTED',
          freshnessGrade: 'REJECTED',
          qualityScore: 65,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('skips the status update but still creates the inspection when the lot is RECALLED', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot({ foodSafetyStatus: 'RECALLED' }));
      inspectionsRepository.create.mockResolvedValue(buildInspection());
      lotsRepository.updateGrading.mockResolvedValue(buildLot({ foodSafetyStatus: 'RECALLED' }));

      const result = await service.inspect('admin-1', dto);

      expect(result.id).toBe('inspection-1');
      expect(inspectionsRepository.create).toHaveBeenCalled();
      expect(lotsRepository.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('getForLot', () => {
    it("returns a lot's inspection history after an ownership check", async () => {
      const user: RequestUser = { id: 'vendor-user-1', email: 'v@example.com', roles: ['VENDOR'] as never };
      seafoodLotsService.assertOwnedByRequester.mockResolvedValue(
        undefined as unknown as Awaited<ReturnType<SeafoodLotsService['assertOwnedByRequester']>>,
      );
      inspectionsRepository.findByLotId.mockResolvedValue({ items: [buildInspection()], total: 1 });

      const result = await service.getForLot(user, 'lot-1', { page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(seafoodLotsService.assertOwnedByRequester).toHaveBeenCalledWith(user, 'lot-1');
    });
  });
});
