import { BadRequestException } from '@nestjs/common';
import { CustodyEventResponseEntity } from '../entities/custody-event-response.entity';
import { CustodyEventsRepository } from '../repositories/custody-events.repository';
import { CustodyEventsService } from './custody-events.service';

function buildEvent(overrides: Partial<CustodyEventResponseEntity> = {}): CustodyEventResponseEntity {
  return {
    id: 'event-1',
    catchId: null,
    lotId: 'lot-1',
    eventType: 'STORAGE_ENTRY',
    fromUserId: 'fisherman-user-1',
    toUserId: 'vendor-user-1',
    location: null,
    latitude: null,
    longitude: null,
    notes: null,
    occurredAt: new Date(),
    ...overrides,
  };
}

describe('CustodyEventsService', () => {
  let custodyEventsRepository: jest.Mocked<Pick<CustodyEventsRepository, 'create' | 'findMany'>>;
  let service: CustodyEventsService;

  beforeEach(() => {
    custodyEventsRepository = { create: jest.fn(), findMany: jest.fn() };
    service = new CustodyEventsService(custodyEventsRepository as unknown as CustodyEventsRepository);
  });

  describe('record', () => {
    it('rejects when neither catchId nor lotId is set', () => {
      expect(() => service.record({ eventType: 'INSPECTION' })).toThrow(BadRequestException);
      expect(custodyEventsRepository.create).not.toHaveBeenCalled();
    });

    it('creates an event when lotId is set', async () => {
      const dto = { lotId: 'lot-1', eventType: 'STORAGE_ENTRY' as const };
      custodyEventsRepository.create.mockResolvedValue(buildEvent());

      const result = await service.record(dto);

      expect(result.id).toBe('event-1');
      expect(custodyEventsRepository.create).toHaveBeenCalledWith(dto);
    });

    it('creates an event when only catchId is set', async () => {
      const dto = { catchId: 'catch-1', eventType: 'LANDING' as const, toUserId: 'fisherman-user-1' };
      custodyEventsRepository.create.mockResolvedValue(
        buildEvent({ catchId: 'catch-1', lotId: null, eventType: 'LANDING', fromUserId: null }),
      );

      const result = await service.record(dto);

      expect(result.eventType).toBe('LANDING');
      expect(custodyEventsRepository.create).toHaveBeenCalledWith(dto);
    });
  });

  describe('list', () => {
    it('lists events filtered by lotId', async () => {
      custodyEventsRepository.findMany.mockResolvedValue([buildEvent()]);

      const result = await service.list({ lotId: 'lot-1' });

      expect(result).toHaveLength(1);
      expect(custodyEventsRepository.findMany).toHaveBeenCalledWith({ lotId: 'lot-1' });
    });
  });
});
