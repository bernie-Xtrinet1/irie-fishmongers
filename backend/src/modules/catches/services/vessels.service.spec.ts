import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Fisherman, Vessel } from '@prisma/client';

import { RegisterVesselDto } from '../dto/register-vessel.dto';
import { FishermenRepository } from '../repositories/fishermen.repository';
import { VesselsRepository } from '../repositories/vessels.repository';
import { VesselsService } from './vessels.service';

describe('VesselsService', () => {
  let vesselsRepo: jest.Mocked<
    Pick<VesselsRepository, 'findByRegistrationNumber' | 'create' | 'findById' | 'findMany' | 'updateStatus'>
  >;
  let fishermenRepo: jest.Mocked<Pick<FishermenRepository, 'findByUserId'>>;
  let service: VesselsService;

  const approvedFisherman = { id: 'fisher-1', status: 'APPROVED' } as unknown as Fisherman;
  const vessel = { id: 'vessel-1', ownerFishermanId: 'fisher-1' } as unknown as Vessel;

  beforeEach(() => {
    vesselsRepo = {
      findByRegistrationNumber: jest.fn(),
      create: jest.fn(),
      findById: jest.fn(),
      findMany: jest.fn(),
      updateStatus: jest.fn(),
    };
    fishermenRepo = { findByUserId: jest.fn() };
    service = new VesselsService(
      vesselsRepo as unknown as VesselsRepository,
      fishermenRepo as unknown as FishermenRepository,
    );
  });

  describe('register', () => {
    it('registers a vessel for an approved fisherman', async () => {
      const dto = { registrationNumber: 'REG-1', name: 'Sea Star' } as unknown as RegisterVesselDto;
      fishermenRepo.findByUserId.mockResolvedValue(approvedFisherman);
      vesselsRepo.findByRegistrationNumber.mockResolvedValue(null);
      vesselsRepo.create.mockResolvedValue(vessel);

      await expect(service.register('user-1', dto)).resolves.toBe(vessel);
      expect(vesselsRepo.create).toHaveBeenCalledWith({ ownerFishermanId: 'fisher-1', ...dto });
    });

    it('throws when the caller has no fisherman profile', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(null);

      await expect(service.register('user-1', {} as RegisterVesselDto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('forbids non-approved fishermen', async () => {
      fishermenRepo.findByUserId.mockResolvedValue({ ...approvedFisherman, status: 'PENDING' });

      await expect(service.register('user-1', {} as RegisterVesselDto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects a duplicate registration number', async () => {
      const dto = { registrationNumber: 'REG-1' } as unknown as RegisterVesselDto;
      fishermenRepo.findByUserId.mockResolvedValue(approvedFisherman);
      vesselsRepo.findByRegistrationNumber.mockResolvedValue(vessel);

      await expect(service.register('user-1', dto)).rejects.toBeInstanceOf(ConflictException);
      expect(vesselsRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('getMine', () => {
    it('paginates the callers vessels', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(approvedFisherman);
      vesselsRepo.findMany.mockResolvedValue({ items: [vessel], total: 1 });

      const result = await service.getMine('user-1', { page: 1, pageSize: 20 });

      expect(result).toEqual({ items: [vessel], total: 1, page: 1, pageSize: 20 });
      expect(vesselsRepo.findMany).toHaveBeenCalledWith({ ownerFishermanId: 'fisher-1' }, { skip: 0, take: 20 });
    });

    it('throws when the caller has no fisherman profile', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(null);

      await expect(service.getMine('user-1', { page: 1, pageSize: 20 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('list', () => {
    it('paginates all vessels', async () => {
      vesselsRepo.findMany.mockResolvedValue({ items: [vessel], total: 1 });

      const result = await service.list({ page: 2, pageSize: 10 });

      expect(result).toEqual({ items: [vessel], total: 1, page: 2, pageSize: 10 });
      expect(vesselsRepo.findMany).toHaveBeenCalledWith({}, { skip: 10, take: 10 });
    });
  });

  describe('updateStatus', () => {
    it('updates a vessel status', async () => {
      const updated = { ...vessel, status: 'DECOMMISSIONED' } as unknown as Vessel;
      vesselsRepo.findById.mockResolvedValue(vessel);
      vesselsRepo.updateStatus.mockResolvedValue(updated);

      await expect(service.updateStatus('vessel-1', 'DECOMMISSIONED')).resolves.toBe(updated);
      expect(vesselsRepo.updateStatus).toHaveBeenCalledWith('vessel-1', 'DECOMMISSIONED');
    });

    it('throws when the vessel is missing', async () => {
      vesselsRepo.findById.mockResolvedValue(null);

      await expect(service.updateStatus('missing', 'DECOMMISSIONED')).rejects.toBeInstanceOf(NotFoundException);
      expect(vesselsRepo.updateStatus).not.toHaveBeenCalled();
    });
  });
});
