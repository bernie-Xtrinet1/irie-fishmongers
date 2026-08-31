import { apiGet } from '../api-client';
import {
  getCustomerOrder,
  getCustomerOrders,
  type OrderResponse,
  type PaginatedOrdersResponse,
} from './orders';

jest.mock('../api-client', () => ({
  apiGet: jest.fn(),
}));

const mockApiGet = apiGet as jest.MockedFunction<typeof apiGet>;

const order: OrderResponse = {
  id: 'order-1',
  customerId: 'customer-1',
  deliveryAddressLine1: '10 Harbour Street',
  deliveryAddressLine2: null,
  deliveryParish: 'KINGSTON',
  deliveryPhone: '8765551234',
  deliveryZoneId: 'zone-1',
  vendorOrders: [
    {
      id: 'vendor-order-1',
      orderId: 'order-1',
      vendorId: 'vendor-1',
      status: 'PENDING',
      subtotal: '5000.00',
      createdAt: '2026-08-31T12:00:00.000Z',
      items: [
        {
          id: 'order-item-1',
          productId: 'product-1',
          productName: 'Fresh Red Snapper',
          unitPrice: '2500.00',
          unit: 'PER_POUND',
          quantity: 2,
          subtotal: '5000.00',
        },
      ],
    },
  ],
  createdAt: '2026-08-31T12:00:00.000Z',
};

const paginatedOrders: PaginatedOrdersResponse = {
  items: [order],
  total: 1,
  page: 1,
  pageSize: 20,
};

describe('orders API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('gets the authenticated customer order history with default pagination', async () => {
    mockApiGet.mockResolvedValue(paginatedOrders);

    await expect(getCustomerOrders()).resolves.toEqual(paginatedOrders);

    expect(mockApiGet).toHaveBeenCalledWith(
      '/orders?page=1&pageSize=20',
    );
  });

  it('gets a requested page of customer orders', async () => {
    mockApiGet.mockResolvedValue({
      ...paginatedOrders,
      page: 2,
      pageSize: 10,
    });

    await getCustomerOrders(2, 10);

    expect(mockApiGet).toHaveBeenCalledWith(
      '/orders?page=2&pageSize=10',
    );
  });

  it('gets a single customer-owned order', async () => {
    mockApiGet.mockResolvedValue(order);

    await expect(getCustomerOrder('order-1')).resolves.toEqual(order);

    expect(mockApiGet).toHaveBeenCalledWith('/orders/order-1');
  });

  it('URL-encodes the order id before requesting the detail route', async () => {
    mockApiGet.mockResolvedValue(order);

    await getCustomerOrder('order/with spaces');

    expect(mockApiGet).toHaveBeenCalledWith(
      '/orders/order%2Fwith%20spaces',
    );
  });
});
