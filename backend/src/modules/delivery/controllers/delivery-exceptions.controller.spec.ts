import { DeliveryExceptionResponseEntity } from '../entities/delivery-exception-response.entity';
import { DeliveryExceptionsService } from '../services/delivery-exceptions.service';
import { DeliveryExceptionsController } from './delivery-exceptions.controller';

const exception: DeliveryExceptionResponseEntity = {
  id: 'exception-1',
  deliveryId: 'delivery-1',
  type: 'CUSTOMER_UNAVAILABLE',
  reason: 'Customer did not answer the door after three attempts',
  photos: [],
  notes: null,
  resolved: false,
  resolvedAt: null,
  resolvedById: null,
  createdAt: new Date(),
};

const driverUser = { id: 'driver-user-1', email: 'a@b.com', roles: ['DRIVER' as const] };
const adminUser = { id: 'admin-1', email: 'admin@example.com', roles: ['ADMINISTRATOR' as const] };

describe('DeliveryExceptionsController', () => {
  let deliveryExceptionsService: jest.Mocked<Pick<DeliveryExceptionsService, 'create' | 'list' | 'resolve'>>;
  let controller: DeliveryExceptionsController;

  beforeEach(() => {
    deliveryExceptionsService = {
      create: jest.fn().mockResolvedValue(exception),
      list: jest.fn().mockResolvedValue({ items: [exception], total: 1, page: 1, pageSize: 20 }),
      resolve: jest.fn().mockResolvedValue({ ...exception, resolved: true }),
    };
    controller = new DeliveryExceptionsController(
      deliveryExceptionsService as unknown as DeliveryExceptionsService,
    );
  });

  it('reports a delivery exception', async () => {
    const dto = {
      type: 'CUSTOMER_UNAVAILABLE' as const,
      reason: 'Customer did not answer the door after three attempts',
    };
    await expect(controller.create(driverUser, 'delivery-1', dto)).resolves.toEqual(exception);
    expect(deliveryExceptionsService.create).toHaveBeenCalledWith('driver-user-1', 'delivery-1', dto);
  });

  it('lists delivery exceptions', async () => {
    const result = await controller.list({ resolved: false, page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
  });

  it('resolves a delivery exception', async () => {
    const result = await controller.resolve(adminUser, 'exception-1');
    expect(result.resolved).toBe(true);
    expect(deliveryExceptionsService.resolve).toHaveBeenCalledWith('exception-1', 'admin-1');
  });
});
