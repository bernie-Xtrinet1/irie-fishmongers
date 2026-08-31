import { UserRole, UserStatus, type AuthUser } from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OrderDetailView } from './order-detail-view';
import { ApiError } from '@/lib/api-client';
import {
  getCustomerOrder,
  type OrderResponse,
} from '@/lib/api/orders';
import { useAuth } from '@/lib/auth/auth-context';

jest.mock('@/lib/api/orders');
jest.mock('@/lib/auth/auth-context');

const mockGetCustomerOrder =
  getCustomerOrder as jest.MockedFunction<typeof getCustomerOrder>;

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

const customer: AuthUser = {
  id: 'customer-1',
  email: 'customer@example.com',
  firstName: 'Customer',
  lastName: 'One',
  phone: null,
  status: UserStatus.ACTIVE,
  roles: [UserRole.CUSTOMER],
  createdAt: '2026-08-31T00:00:00.000Z',
};

const vendor: AuthUser = {
  ...customer,
  id: 'vendor-user-1',
  email: 'vendor@example.com',
  firstName: 'Vendor',
  roles: [UserRole.VENDOR],
};

const order: OrderResponse = {
  id: 'order-1',
  customerId: 'customer-1',
  deliveryAddressLine1: '10 Harbour Street',
  deliveryAddressLine2: 'Apartment 2',
  deliveryParish: 'KINGSTON',
  deliveryPhone: '8765551234',
  deliveryZoneId: 'zone-1',
  vendorOrders: [
    {
      id: 'vendor-order-1',
      orderId: 'order-1',
      vendorId: 'vendor-1',
      status: 'READY_FOR_PICKUP',
      subtotal: '5000.00',
      createdAt: '2026-08-31T12:00:00.000Z',
      items: [
        {
          id: 'item-1',
          productId: 'product-1',
          productName: 'Fresh Red Snapper',
          unitPrice: '2500.00',
          unit: 'PER_POUND',
          quantity: 2,
          subtotal: '5000.00',
        },
      ],
    },
    {
      id: 'vendor-order-2',
      orderId: 'order-1',
      vendorId: 'vendor-2',
      status: 'PENDING',
      subtotal: '1650.00',
      createdAt: '2026-08-31T12:00:00.000Z',
      items: [
        {
          id: 'item-2',
          productId: 'product-2',
          productName: 'Jumbo Shrimp',
          unitPrice: '1650.00',
          unit: 'PER_POUND',
          quantity: 1,
          subtotal: '1650.00',
        },
      ],
    },
  ],
  createdAt: '2026-08-31T12:00:00.000Z',
};

function renderOrderDetail(orderId = 'order-1'): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <OrderDetailView orderId={orderId} />
    </QueryClientProvider>,
  );

  return queryClient;
}

describe('OrderDetailView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prompts an unauthenticated visitor to sign in without requesting the order', () => {
    mockUseAuth.mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderOrderDetail();

    expect(
      screen.getByRole('heading', { name: 'Order details' }),
    ).toBeInTheDocument();

    expect(screen.getByText('Sign in to view this order.')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?returnUrl=%2Forders%2Forder-1',
    );

    expect(mockGetCustomerOrder).not.toHaveBeenCalled();
  });

  it('encodes the order return URL safely', () => {
    mockUseAuth.mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderOrderDetail('order/with spaces');

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?returnUrl=%2Forders%2Forder%252Fwith%2520spaces',
    );

    expect(mockGetCustomerOrder).not.toHaveBeenCalled();
  });

  it('does not request an order for an authenticated non-customer account', () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: vendor,
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderOrderDetail();

    expect(
      screen.getByText('Order details are available to customer accounts.'),
    ).toBeInTheDocument();

    expect(mockGetCustomerOrder).not.toHaveBeenCalled();
  });

  it('renders the stored order detail without inventing currency', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    mockGetCustomerOrder.mockResolvedValue(order);

    renderOrderDetail();

    expect(
      await screen.findByRole('heading', { name: 'Order order-1' }),
    ).toBeInTheDocument();

    expect(mockGetCustomerOrder).toHaveBeenCalledWith('order-1');

    expect(screen.getByText('10 Harbour Street, Apartment 2')).toBeInTheDocument();
    expect(screen.getByText('Kingston')).toBeInTheDocument();
    expect(screen.getByText('8765551234')).toBeInTheDocument();

    expect(screen.getByText('Ready For Pickup')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();

    expect(screen.getByText('Fresh Red Snapper')).toBeInTheDocument();
    expect(screen.getByText('Quantity: 2')).toBeInTheDocument();
    expect(screen.getByText('Unit price: 2,500.00 per pound')).toBeInTheDocument();

    expect(screen.getByText('Jumbo Shrimp')).toBeInTheDocument();
    expect(screen.getByText('Quantity: 1')).toBeInTheDocument();
    expect(screen.getByText('Unit price: 1,650.00 per pound')).toBeInTheDocument();

    expect(screen.getByText('6,650.00')).toBeInTheDocument();

    expect(screen.queryByText(/JMD/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();

    expect(
      screen.getByRole('link', { name: /Back to your orders/i }),
    ).toHaveAttribute('href', '/orders');
  });

  it('shows a not-found state without retrying a missing order', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    mockGetCustomerOrder.mockRejectedValue(
      new ApiError('Order not found', 404),
    );

    renderOrderDetail();

    expect(await screen.findByText('Order not found.')).toBeInTheDocument();

    expect(
      screen.queryByRole('button', { name: 'Try again' }),
    ).not.toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Back to your orders' })).toHaveAttribute(
      'href',
      '/orders',
    );
  });

  it('shows a general error state and retries the request', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    mockGetCustomerOrder
      .mockRejectedValueOnce(new Error('Request failed'))
      .mockResolvedValueOnce(order);

    renderOrderDetail();

    const retryButton = await screen.findByRole('button', {
      name: 'Try again',
    });

    expect(screen.getByText('We could not load this order.')).toBeInTheDocument();

    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(mockGetCustomerOrder).toHaveBeenCalledTimes(2);
    });

    expect(
      await screen.findByRole('heading', { name: 'Order order-1' }),
    ).toBeInTheDocument();
  });
});
