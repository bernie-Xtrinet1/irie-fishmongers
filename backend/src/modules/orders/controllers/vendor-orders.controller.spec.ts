import { VendorOrderResponseEntity } from '../entities/vendor-order-response.entity';
import { VendorOrdersService } from '../services/vendor-orders.service';
import { VendorOrdersController } from './vendor-orders.controller';

const vendorOrder: VendorOrderResponseEntity = {
  id: 'vo-1',
  orderId: 'order-1',
  vendorId: 'vendor-1',
  status: 'PENDING',
  subtotal: '500',
  items: [],
  createdAt: new Date(),
};

const user = { id: 'user-1', email: 'a@b.com', roles: ['VENDOR' as const] };

describe('VendorOrdersController', () => {
  let vendorOrdersService: jest.Mocked<
    Pick<VendorOrdersService, 'getIncomingOrders' | 'accept' | 'reject' | 'markPreparing' | 'markReadyForPickup'>
  >;
  let controller: VendorOrdersController;

  beforeEach(() => {
    vendorOrdersService = {
      getIncomingOrders: jest
        .fn()
        .mockResolvedValue({ items: [vendorOrder], total: 1, page: 1, pageSize: 20 }),
      accept: jest.fn().mockResolvedValue({ ...vendorOrder, status: 'ACCEPTED' }),
      reject: jest.fn().mockResolvedValue({ ...vendorOrder, status: 'REJECTED' }),
      markPreparing: jest.fn().mockResolvedValue({ ...vendorOrder, status: 'PREPARING' }),
      markReadyForPickup: jest
        .fn()
        .mockResolvedValue({ ...vendorOrder, status: 'READY_FOR_PICKUP' }),
    };
    controller = new VendorOrdersController(vendorOrdersService as unknown as VendorOrdersService);
  });

  it('lists incoming orders', async () => {
    const result = await controller.list(user, { page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
    expect(vendorOrdersService.getIncomingOrders).toHaveBeenCalledWith('user-1', undefined, {
      page: 1,
      pageSize: 20,
    });
  });

  it('accepts an order', async () => {
    const result = await controller.accept(user, 'vo-1');
    expect(result.status).toBe('ACCEPTED');
  });

  it('rejects an order', async () => {
    const result = await controller.reject(user, 'vo-1');
    expect(result.status).toBe('REJECTED');
  });

  it('marks an order as preparing', async () => {
    const result = await controller.markPreparing(user, 'vo-1');
    expect(result.status).toBe('PREPARING');
  });

  it('marks an order as ready for pickup', async () => {
    const result = await controller.markReadyForPickup(user, 'vo-1');
    expect(result.status).toBe('READY_FOR_PICKUP');
  });
});
