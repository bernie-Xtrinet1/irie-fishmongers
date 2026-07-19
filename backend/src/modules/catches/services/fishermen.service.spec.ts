import { ConflictException, NotFoundException } from '@nestjs/common';
import { Fisherman } from '@prisma/client';

import { ComplianceAuditLogService } from '../../food-safety/services/compliance-audit-log.service';
import { RegisterFishermanDto } from '../dto/register-fisherman.dto';
import { FishermenRepository } from '../repositories/fishermen.repository';
import { LandingSitesRepository } from '../repositories/landing-sites.repository';
import { FishermenService } from './fishermen.service';

describe('FishermenService', () => {
  let fishermenRepo: jest.Mocked<
    Pick<FishermenRepository, 'findByUserId' | 'findById' | 'create' | 'updateStatus' | 'findMany'>
  >;
  let landingSitesRepo: jest.Mocked<Pick<LandingSitesRepository, 'findById'>>;
  let auditLog: jest.Mocked<Pick<ComplianceAuditLogService, 'record'>>;
  let service: FishermenService;

  const fisherman = { id: 'fisher-1', status: 'PENDING' } as unknown as Fisherman;

  beforeEach(() => {
    fishermenRepo = {
      findByUserId: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      updateStatus: jest.fn(),
      findMany: jest.fn(),
    };
    landingSitesRepo = { findById: jest.fn() };
    auditLog = { record: jest.fn() };
    service = new FishermenService(
      fishermenRepo as unknown as FishermenRepository,
      landingSitesRepo as unknown as LandingSitesRepository,
      auditLog as unknown as ComplianceAuditLogService,
    );
  });

  describe('register', () => {
    it('registers a fisherman without a landing site', async () => {
      const dto = { fullName: 'Bob Marley' } as unknown as RegisterFishermanDto;
      fishermenRepo.findByUserId.mockResolvedValue(null);
      fishermenRepo.create.mockResolvedValue(fisherman);

      await expect(service.register('user-1', dto)).resolves.toBe(fisherman);
      expect(fishermenRepo.create).toHaveBeenCalledWith({ userId: 'user-1', ...dto });
    });

    it('validates the landing site when provided', async () => {
      const dto = { fullName: 'Bob', landingSiteId: 'site-1' } as unknown as RegisterFishermanDto;
      fishermenRepo.findByUserId.mockResolvedValue(null);
      landingSitesRepo.findById.mockResolvedValue({ id: 'site-1' } as never);
      fishermenRepo.create.mockResolvedValue(fisherman);

      await expect(service.register('user-1', dto)).resolves.toBe(fisherman);
      expect(landingSitesRepo.findById).toHaveBeenCalledWith('site-1');
    });

    it('rejects when the landing site is missing', async () => {
      const dto = { landingSiteId: 'missing' } as unknown as RegisterFishermanDto;
      fishermenRepo.findByUserId.mockResolvedValue(null);
      landingSitesRepo.findById.mockResolvedValue(null);

      await expect(service.register('user-1', dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(fishermenRepo.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate fisherman profile', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(fisherman);

      await expect(service.register('user-1', {} as RegisterFishermanDto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(fishermenRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('getOwnProfile', () => {
    it('returns the caller profile', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(fisherman);

      await expect(service.getOwnProfile('user-1')).resolves.toBe(fisherman);
    });

    it('throws when no profile exists', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(null);

      await expect(service.getOwnProfile('user-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('updates status and writes an audit log', async () => {
      const updated = { id: 'fisher-1', status: 'APPROVED' } as unknown as Fisherman;
      fishermenRepo.findById.mockResolvedValue(fisherman);
      fishermenRepo.updateStatus.mockResolvedValue(updated);
      auditLog.record.mockResolvedValue(null);

      await expect(service.updateStatus('admin-1', 'fisher-1', 'APPROVED', '127.0.0.1')).resolves.toBe(updated);
      expect(fishermenRepo.updateStatus).toHaveBeenCalledWith('fisher-1', 'APPROVED');
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-1',
          action: 'FISHERMAN_STATUS_UPDATED',
          entityType: 'Fisherman',
          entityId: 'fisher-1',
          beforeValue: { status: 'PENDING' },
          afterValue: { status: 'APPROVED' },
          ipAddress: '127.0.0.1',
        }),
      );
    });

    it('throws when the fisherman is missing', async () => {
      fishermenRepo.findById.mockResolvedValue(null);

      await expect(service.updateStatus('admin-1', 'missing', 'APPROVED')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(fishermenRepo.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('paginates fishermen', async () => {
      fishermenRepo.findMany.mockResolvedValue({ items: [fisherman], total: 1 });

      const result = await service.list({ page: 1, pageSize: 20 });

      expect(result).toEqual({ items: [fisherman], total: 1, page: 1, pageSize: 20 });
      expect(fishermenRepo.findMany).toHaveBeenCalledWith(undefined, { skip: 0, take: 20 });
    });
  });
});
