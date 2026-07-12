import { SLABreachesRepository } from '../repositories/sla-breaches.repository';
import { SLABreachDetectionService } from './sla-breach-detection.service';

describe('SLABreachDetectionService', () => {
  let slaBreachesRepository: jest.Mocked<
    Pick<SLABreachesRepository, 'findOverdueInTransitCandidates' | 'upsert'>
  >;
  let service: SLABreachDetectionService;

  beforeEach(() => {
    slaBreachesRepository = {
      findOverdueInTransitCandidates: jest.fn(),
      upsert: jest.fn(),
    };
    service = new SLABreachDetectionService(
      slaBreachesRepository as unknown as SLABreachesRepository,
    );
  });

  it('does nothing when there are no overdue in-transit deliveries', async () => {
    slaBreachesRepository.findOverdueInTransitCandidates.mockResolvedValue([]);

    await service.detectOverdueInTransitDeliveries();

    expect(slaBreachesRepository.upsert).not.toHaveBeenCalled();
  });

  it('upserts an OVERDUE_IN_TRANSIT breach for each candidate with minutesLate computed from now', async () => {
    const windowEnd = new Date('2026-07-08T10:00:00.000Z');
    slaBreachesRepository.findOverdueInTransitCandidates.mockResolvedValue([
      { id: 'delivery-1', customerDeliveryWindowEnd: windowEnd },
    ]);

    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T10:25:00.000Z'));
    try {
      await service.detectOverdueInTransitDeliveries();
    } finally {
      jest.useRealTimers();
    }

    expect(slaBreachesRepository.upsert).toHaveBeenCalledWith({
      deliveryId: 'delivery-1',
      type: 'OVERDUE_IN_TRANSIT',
      scheduledEnd: windowEnd,
      minutesLate: 25,
    });
  });

  it('processes every candidate returned by the repository', async () => {
    const windowEnd = new Date('2026-07-08T10:00:00.000Z');
    slaBreachesRepository.findOverdueInTransitCandidates.mockResolvedValue([
      { id: 'delivery-1', customerDeliveryWindowEnd: windowEnd },
      { id: 'delivery-2', customerDeliveryWindowEnd: windowEnd },
    ]);

    await service.detectOverdueInTransitDeliveries();

    expect(slaBreachesRepository.upsert).toHaveBeenCalledTimes(2);
  });
});
