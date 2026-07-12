import { SLABreachResponseEntity } from '../entities/sla-breach-response.entity';
import { SLABreachesService } from '../services/sla-breaches.service';
import { SLABreachesController } from './sla-breaches.controller';

const breach: SLABreachResponseEntity = {
  id: 'breach-1',
  deliveryId: 'delivery-1',
  type: 'OVERDUE_IN_TRANSIT',
  scheduledEnd: new Date('2026-07-08T10:00:00.000Z'),
  minutesLate: 20,
  detectedAt: new Date(),
  resolved: false,
  resolvedAt: null,
  resolvedById: null,
};

const adminUser = { id: 'admin-1', email: 'admin@example.com', roles: ['ADMINISTRATOR' as const] };

describe('SLABreachesController', () => {
  let slaBreachesService: jest.Mocked<Pick<SLABreachesService, 'list' | 'resolve' | 'getZoneSummary'>>;
  let controller: SLABreachesController;

  beforeEach(() => {
    slaBreachesService = {
      list: jest.fn().mockResolvedValue({ items: [breach], total: 1, page: 1, pageSize: 20 }),
      resolve: jest.fn().mockResolvedValue({ ...breach, resolved: true }),
      getZoneSummary: jest
        .fn()
        .mockResolvedValue([{ zoneId: 'zone-1', totalBreaches: 1, unresolvedBreaches: 1 }]),
    };
    controller = new SLABreachesController(slaBreachesService as unknown as SLABreachesService);
  });

  it('lists SLA breaches', async () => {
    const result = await controller.list({ resolved: false, page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
  });

  it('resolves an SLA breach', async () => {
    const result = await controller.resolve(adminUser, 'breach-1');
    expect(result.resolved).toBe(true);
    expect(slaBreachesService.resolve).toHaveBeenCalledWith('breach-1', 'admin-1');
  });

  it('gets the zone summary rollup', async () => {
    const result = await controller.getZoneSummary();
    expect(result).toEqual([{ zoneId: 'zone-1', totalBreaches: 1, unresolvedBreaches: 1 }]);
  });
});
