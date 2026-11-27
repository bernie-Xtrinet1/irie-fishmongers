import { OrderDeliveryTrackingEntity } from '../entities/order-delivery-tracking.entity';
import { OrderResponseEntity } from '../entities/order-response.entity';
import { CustomerOrderTrackingService } from '../services/customer-order-tracking.service';
import { OrdersService } from '../services/orders.service';
import { OrdersController } from './orders.controller';

const order: OrderResponseEntity = {
  id: 'order-1',
  customerId: 'user-1',
  deliveryAddressLine1: '1 Test Street',
  deliveryAddressLine2: null,
  deliveryParish: 'KINGSTON',
  deliveryPhone: '+18765551234',
  deliveryZoneId: null,
  vendorOrders: [],
  createdAt: new Date(),
};

const tracking: OrderDeliveryTrackingEntity = {
  orderId: 'order-1',
  deliveryParish: 'KINGSTON',
  isSplitOrder: false,
  hasActiveTracking: false,
  deliveries: [],
  checkedAt: new Date().toISOString(),
};

const user = { id: 'user-1', email: 'a@b.com', roles: ['CUSTOMER' as const] };

describe('OrdersController', () => {
  let ordersService: jest.Mocked<
    Pick<OrdersService, 'checkout' | 'getCustomerOrders' | 'getCustomerOrderById' | 'cancelOrder' | 'cancelVendorOrder'>
  >;
  let trackingService: jest.Mocked<Pick<CustomerOrderTrackingService, 'getOrderTracking'>>;
  let controller: OrdersController;

  beforeEach(() => {
    ordersService = {
      checkout: jest.fn().mockResolvedValue(order),
      getCustomerOrders: jest.fn().mockResolvedValue({ items: [order], total: 1, page: 1, pageSize: 20 }),
      getCustomerOrderById: jest.fn().mockResolvedValue(order),
      cancelOrder: jest.fn().mockResolvedValue(order),
      cancelVendorOrder: jest.fn().mockResolvedValue(order),
    };
    trackingService = {
      getOrderTracking: jest.fn().mockResolvedValue(tracking),
    };
    controller = new OrdersController(
      ordersService as unknown as OrdersService,
      trackingService as unknown as CustomerOrderTrackingService,
    );
  });

  const checkoutDto = {
    deliveryAddressLine1: '1 Test Street',
    deliveryParish: 'KINGSTON' as const,
    deliveryPhone: '+18765551234',
    paymentMethod: 'CASH_ON_DELIVERY' as const,
  };

  it('checks out', async () => {
    await expect(controller.checkout(user, checkoutDto)).resolves.toEqual(order);
    expect(ordersService.checkout).toHaveBeenCalledWith('user-1', checkoutDto);
  });

  it('lists orders', async () => {
    const result = await controller.list(user, { page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
  });

  it('finds an order by id', async () => {
    await expect(controller.findById(user, 'order-1')).resolves.toEqual(order);
  });

  it('returns delivery tracking for an owned order', async () => {
    await expect(controller.trackDelivery(user, 'order-1')).resolves.toEqual(tracking);
    expect(trackingService.getOrderTracking).toHaveBeenCalledWith('user-1', 'order-1');
  });

  it('cancels an order', async () => {
    await expect(controller.cancel(user, 'order-1')).resolves.toEqual(order);
    expect(ordersService.cancelOrder).toHaveBeenCalledWith('user-1', 'order-1');
  });

  it('cancels a vendor order', async () => {
    await expect(controller.cancelVendorOrder(user, 'order-1', 'vo-1')).resolves.toEqual(order);
    expect(ordersService.cancelVendorOrder).toHaveBeenCalledWith('user-1', 'order-1', 'vo-1');
  });
});
