import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EmergencyResponse } from '@prisma/client';

import { EmergencyResponsesRepository } from '../repositories/emergency-responses.repository';
import { EmergencyResponsesService } from './emergency-responses.service';

function buildResponse(overrides: Partial<EmergencyResponse> = {}): EmergencyResponse {
  return {
    id: 'response-1',
    alertId: 'alert-1',
    assignedToId: null,
    status: 'OPEN',
    actionsTaken: null,
    rootCause: null,
    correctiveAction: null,
    preventiveAction: null,
    acknowledgedAt: null,
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('EmergencyResponsesService', () => {
  let responsesRepository: jest.Mocked<
    Pick<EmergencyResponsesRepository, 'create' | 'findById' | 'update' | 'findMany'>
  >;
  let service: EmergencyResponsesService;

  beforeEach(() => {
    responsesRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    };
    service = new EmergencyResponsesService(
      responsesRepository as unknown as EmergencyResponsesRepository,
    );
  });

  describe('createForAlert', () => {
    it('creates an OPEN response for the given alert', async () => {
      responsesRepository.create.mockResolvedValue(buildResponse());

      const result = await service.createForAlert('alert-1');

      expect(result.status).toBe('OPEN');
      expect(responsesRepository.create).toHaveBeenCalledWith('alert-1');
    });
  });

  describe('acknowledge', () => {
    it('throws when the response does not exist', async () => {
      responsesRepository.findById.mockResolvedValue(null);
      await expect(service.acknowledge('admin-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects acknowledging a non-OPEN response', async () => {
      responsesRepository.findById.mockResolvedValue(buildResponse({ status: 'ACKNOWLEDGED' }));
      await expect(service.acknowledge('admin-1', 'response-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('self-assigns and moves an OPEN response to ACKNOWLEDGED', async () => {
      responsesRepository.findById.mockResolvedValue(buildResponse());
      responsesRepository.update.mockResolvedValue(
        buildResponse({ status: 'ACKNOWLEDGED', assignedToId: 'admin-1' }),
      );

      const result = await service.acknowledge('admin-1', 'response-1');

      expect(result.status).toBe('ACKNOWLEDGED');
      expect(responsesRepository.update).toHaveBeenCalledWith('response-1', {
        status: 'ACKNOWLEDGED',
        assignedToId: 'admin-1',
        acknowledgedAt: expect.any(Date) as Date,
      });
    });
  });

  describe('updateStatus', () => {
    it('throws when the response does not exist', async () => {
      responsesRepository.findById.mockResolvedValue(null);
      await expect(service.updateStatus('missing', { status: 'CONTAINED' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a disallowed transition (e.g. OPEN -> RESOLVED, skipping steps)', async () => {
      responsesRepository.findById.mockResolvedValue(buildResponse({ status: 'OPEN' }));
      await expect(
        service.updateStatus('response-1', {
          status: 'RESOLVED',
          rootCause: 'Compressor failure',
          correctiveAction: 'Replaced compressor unit',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('moves ACKNOWLEDGED to CONTAINED', async () => {
      responsesRepository.findById.mockResolvedValue(buildResponse({ status: 'ACKNOWLEDGED' }));
      responsesRepository.update.mockResolvedValue(buildResponse({ status: 'CONTAINED' }));

      const result = await service.updateStatus('response-1', {
        status: 'CONTAINED',
        actionsTaken: 'Moved product to backup freezer',
      });

      expect(result.status).toBe('CONTAINED');
    });

    it('rejects resolving without rootCause and correctiveAction', async () => {
      responsesRepository.findById.mockResolvedValue(buildResponse({ status: 'CONTAINED' }));
      await expect(
        service.updateStatus('response-1', { status: 'RESOLVED' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resolves a CONTAINED response with rootCause and correctiveAction, setting resolvedAt', async () => {
      responsesRepository.findById.mockResolvedValue(buildResponse({ status: 'CONTAINED' }));
      responsesRepository.update.mockResolvedValue(
        buildResponse({
          status: 'RESOLVED',
          rootCause: 'Compressor failure',
          correctiveAction: 'Replaced compressor unit',
          resolvedAt: new Date(),
        }),
      );

      const result = await service.updateStatus('response-1', {
        status: 'RESOLVED',
        rootCause: 'Compressor failure',
        correctiveAction: 'Replaced compressor unit',
      });

      expect(result.status).toBe('RESOLVED');
      expect(responsesRepository.update).toHaveBeenCalledWith('response-1', {
        status: 'RESOLVED',
        actionsTaken: undefined,
        rootCause: 'Compressor failure',
        correctiveAction: 'Replaced compressor unit',
        preventiveAction: undefined,
        resolvedAt: expect.any(Date) as Date,
      });
    });
  });

  describe('list', () => {
    it('lists responses filtered by status', async () => {
      responsesRepository.findMany.mockResolvedValue([buildResponse()]);

      const result = await service.list('OPEN');

      expect(result).toHaveLength(1);
      expect(responsesRepository.findMany).toHaveBeenCalledWith('OPEN');
    });
  });
});
