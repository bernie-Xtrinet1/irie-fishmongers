import { UserRole, UserStatus, type AuthUser } from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OrdersView } from './orders-view';
import {
  getCustomerOrders,
  type OrderResponse,
  type PaginatedOrdersResponse,
} from '@/lib/api/orders';
import { useAuth } from '@/lib/auth/auth-context';

jest.mock('@/lib/api/orders');
jest.mock('@/lib/auth/auth-context');

const mockGetCustomerOrders =
  getCustomerOrders as jest.MockedFunction<typeof getCustomerOrders>;
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
  id: 'vendor-1',
  email: 'vendor@example.com',
  firstName: 'Vendor',
  roles: [UserRole.VENDOR],
};

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
      items: [],
    },
  ],
  createdAt: '2026-08-31T12:00:00.000Z',
};

const populatedOrders: PaginatedOrdersResponse = {
  items: [order],
  total: 1,
  page: 1,
  pageSize: 20,
};

function renderOrders(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <OrdersView />
    </QueryClientProvider>,
  );

  return queryClient;
}

describe('OrdersView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prompts an unauthenticated visitor to sign in without requesting orders', () => {
    mockUseAuth.mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderOrders();

    expect(
      screen.getByRole('heading', { name: 'Your orders' }),
    ).toBeInTheDocument();

    expect(
      screen.getByText('Sign in to view your order history.'),
    ).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?returnUrl=%2Forders',
    );

    expect(mockGetCustomerOrders).not.toHaveBeenCalled();
  });

  it('does not request customer orders for a non-customer account', () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: vendor,
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderOrders();

    expect(
      screen.getByText('Order history is available to customer accounts.'),
    ).toBeInTheDocument();

    expect(mockGetCustomerOrders).not.toHaveBeenCalled();
  });

  it('shows the empty order-history state for a customer', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    mockGetCustomerOrders.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });

    renderOrders();

    expect(
      await screen.findByText('You have not placed any orders yet.'),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('link', { name: 'Browse the marketplace' }),
    ).toHaveAttribute('href', '/');

    expect(mockGetCustomerOrders).toHaveBeenCalledWith(1, 20);
  });

  it('renders stored order values without inventing currency', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    mockGetCustomerOrders.mockResolvedValue(populatedOrders);

    renderOrders();

    expect(
      await screen.findByRole('link', { name: 'Order order-1' }),
    ).toHaveAttribute('href', '/orders/order-1');

    expect(screen.getByText('Ready For Pickup')).toBeInTheDocument();

    expect(
      screen.getByText('Fresh Red Snapper — 2 × 2,500.00 per pound'),
    ).toBeInTheDocument();

    expect(screen.getByText('6,650.00')).toBeInTheDocument();

    expect(screen.queryByText(/JMD/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('shows an error state and retries the order request', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    mockGetCustomerOrders
      .mockRejectedValueOnce(new Error('Request failed'))
      .mockResolvedValueOnce(populatedOrders);

    renderOrders();

    const retryButton = await screen.findByRole('button', {
      name: 'Try again',
    });

    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(mockGetCustomerOrders).toHaveBeenCalledTimes(2);
    });

    expect(
      await screen.findByRole('link', { name: 'Order order-1' }),
    ).toBeInTheDocument();
  });

  it('requests the next page when the customer selects Next', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    mockGetCustomerOrders
      .mockResolvedValueOnce({
        ...populatedOrders,
        total: 21,
      })
      .mockResolvedValueOnce({
        ...populatedOrders,
        total: 21,
        page: 2,
      });

    renderOrders();

    const nextButton = await screen.findByRole('button', { name: 'Next' });

    fireEvent.click(nextButton);

    await waitFor(() => {
      expect(mockGetCustomerOrders).toHaveBeenCalledWith(2, 20);
    });

    expect(await screen.findByText('Page 2')).toBeInTheDocument();
  });

  it('keeps Previous disabled on the first page', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    mockGetCustomerOrders.mockResolvedValue(populatedOrders);

    renderOrders();

    expect(
      await screen.findByRole('button', { name: 'Previous' }),
    ).toBeDisabled();
  });
});
