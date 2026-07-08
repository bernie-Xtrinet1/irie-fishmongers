import { DeliveryRejectedEvent } from '../../../common/events/delivery-rejected.event';
import { PrismaService } from '../../../database/prisma.service';
import { FoodSafetyIncidentsRepository } from '../repositories/food-safety-incidents.repository';
import { FoodSafetyEventsListener } from './food-safety-events.listener';

describe('FoodSafetyEventsListener', () => {
  let prisma: { orderItem: { findMany: jest.Mock } };
  let incidentsRepository: jest.Mocked<Pick<FoodSafetyIncidentsRepository, 'create'>>;
  let listener: FoodSafetyEventsListener;

  beforeEach(() => {
    prisma = { orderItem: { findMany: jest.fn() } };
    incidentsRepository = { create: jest.fn() };
    listener = new FoodSafetyEventsListener(
      prisma as unknown as PrismaService,
      incidentsRepository as unknown as FoodSafetyIncidentsRepository,
    );
  });

  it('raises one incident per distinct lot among the rejected vendor order items', async () => {
    prisma.orderItem.findMany.mockResolvedValue([
      { product: { lotId: 'lot-1' } },
      { product: { lotId: 'lot-1' } },
      { product: { lotId: 'lot-2' } },
    ]);

    const event = new DeliveryRejectedEvent('customer-1', 'vo-1', 'Package arrived warm');
    await listener.onDeliveryRejected(event);

    expect(incidentsRepository.create).toHaveBeenCalledTimes(2);
    expect(incidentsRepository.create).toHaveBeenCalledWith({
      lotId: 'lot-1',
      reportedById: 'customer-1',
      severity: 'MEDIUM',
      description: 'Customer rejected delivery: Package arrived warm',
    });
    expect(incidentsRepository.create).toHaveBeenCalledWith({
      lotId: 'lot-2',
      reportedById: 'customer-1',
      severity: 'MEDIUM',
      description: 'Customer rejected delivery: Package arrived warm',
    });
  });

  it('skips items with no linked lot', async () => {
    prisma.orderItem.findMany.mockResolvedValue([
      { product: { lotId: null } },
      { product: { lotId: null } },
    ]);

    const event = new DeliveryRejectedEvent('customer-1', 'vo-1', 'Wrong item delivered');
    await listener.onDeliveryRejected(event);

    expect(incidentsRepository.create).not.toHaveBeenCalled();
  });
});
