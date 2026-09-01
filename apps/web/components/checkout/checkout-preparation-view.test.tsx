import {
  UserRole,
  UserStatus,
  type AuthUser,
} from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CheckoutPreparationView } from './checkout-preparation-view';
import { getCart, type CartResponse } from '@/lib/api/cart';
import { resolveDeliveryZone } from '@/lib/api/delivery-zones';
import { useAuth } from '@/lib/auth/auth-context';

jest.mock('@/lib/api/cart');
jest.mock('@/lib/api/delivery-zones', () => {
  const actual =
    jest.requireActual<typeof import('@/lib/api/delivery-zones')>(
      '@/lib/api/delivery-zones',
    );

  return {
    ...actual,
    resolveDeliveryZone: jest.fn(),
  };
});
jest.mock('@/lib/auth/auth-context');

const mockGetCart = getCart as jest.MockedFunction<typeof getCart>;
const mockResolveDeliveryZone =
  resolveDeliveryZone as jest.MockedFunction<typeof resolveDeliveryZone>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

const customer: AuthUser = {
  id: 'customer-1',
  email: 'customer@example.com',
  firstName: 'Customer',
  lastName: 'One',
  phone: '8765551234',
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

const populatedCart: CartResponse = {
  id: 'cart-1',
  items: [
    {
      id: 'item-1',
      productId: 'product-1',
      productName: 'Red Snapper',
      vendorId: 'vendor-1',
      unitPrice: '2500.00',
      unit: 'LB',
      quantity: 2,
      subtotal: '5000.00',
    },
  ],
  total: '5000.00',
};

const emptyCart: CartResponse = {
  id: 'cart-1',
  items: [],
  total: '0.00',
};

function renderCheckout(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <CheckoutPreparationView />
    </QueryClientProvider>,
  );

  return queryClient;
}

function mockAuthenticatedCustomer(
  user: AuthUser = customer,
): void {
  mockUseAuth.mockReturnValue({
    status: 'authenticated',
    user,
    login: jest.fn(),
    logout: jest.fn(),
  });
}

describe('CheckoutPreparationView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the session-loading state without requesting the cart', () => {
    mockUseAuth.mockReturnValue({
      status: 'loading',
      user: null,
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderCheckout();

    expect(
      screen.getByText('Loading checkout preparation…'),
    ).toBeInTheDocument();
    expect(mockGetCart).not.toHaveBeenCalled();
  });

  it('prompts an unauthenticated visitor to sign in with the checkout return URL', () => {
    mockUseAuth.mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderCheckout();

    expect(
      screen.getByRole('heading', { name: 'Delivery details' }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('link', { name: 'Sign in' }),
    ).toHaveAttribute(
      'href',
      '/login?returnUrl=%2Fcheckout',
    );

    expect(mockGetCart).not.toHaveBeenCalled();
  });

  it('does not expose checkout preparation to a non-customer account', () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: vendor,
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderCheckout();

    expect(
      screen.getByText(
        'Checkout preparation is available to customer accounts.',
      ),
    ).toBeInTheDocument();

    expect(mockGetCart).not.toHaveBeenCalled();
    expect(mockResolveDeliveryZone).not.toHaveBeenCalled();
  });

  it('requires a non-empty cart before showing delivery preparation', async () => {
    mockAuthenticatedCustomer();
    mockGetCart.mockResolvedValue(emptyCart);

    renderCheckout();

    expect(
      await screen.findByText(
        'Add an item to your cart before preparing checkout.',
      ),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('link', { name: 'Continue shopping' }),
    ).toHaveAttribute('href', '/');

    expect(mockResolveDeliveryZone).not.toHaveBeenCalled();
  });

  it('renders the populated cart summary without placing an order', async () => {
    mockAuthenticatedCustomer();
    mockGetCart.mockResolvedValue(populatedCart);

    renderCheckout();

    expect(await screen.findByText('Red Snapper')).toBeInTheDocument();
    expect(screen.getByText('Quantity 2')).toBeInTheDocument();
    expect(screen.getAllByText('5,000.00')).toHaveLength(2);

    expect(
      screen.getByText(
        /Order placement and payment are not enabled in this preparation stage/,
      ),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('button', {
        name: 'Complete delivery details',
      }),
    ).toBeDisabled();
  });

  it('prefills the delivery phone from the authenticated customer', async () => {
    mockAuthenticatedCustomer();
    mockGetCart.mockResolvedValue(populatedCart);

    renderCheckout();

    expect(
      await screen.findByLabelText('Delivery phone'),
    ).toHaveValue('8765551234');
  });

  it('resolves the selected parish and reports available coverage', async () => {
    mockAuthenticatedCustomer();
    mockGetCart.mockResolvedValue(populatedCart);
    mockResolveDeliveryZone.mockResolvedValue({
      zoneId: 'zone-1',
    });

    renderCheckout();

    const parishSelect = await screen.findByLabelText('Parish');

    fireEvent.change(parishSelect, {
      target: {
        value: 'ST_ANDREW',
      },
    });

    await waitFor(() => {
      expect(mockResolveDeliveryZone).toHaveBeenCalledWith(
        'ST_ANDREW',
      );
    });

    expect(
      await screen.findByText(
        'Delivery coverage is available for this parish.',
      ),
    ).toBeInTheDocument();
  });

  it('reports when a parish has no delivery-zone mapping', async () => {
    mockAuthenticatedCustomer();
    mockGetCart.mockResolvedValue(populatedCart);
    mockResolveDeliveryZone.mockResolvedValue({
      zoneId: null,
    });

    renderCheckout();

    fireEvent.change(await screen.findByLabelText('Parish'), {
      target: {
        value: 'PORTLAND',
      },
    });

    expect(
      await screen.findByText(
        'This parish is not currently mapped to a delivery zone.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps order placement disabled after valid delivery preparation', async () => {
    mockAuthenticatedCustomer();
    mockGetCart.mockResolvedValue(populatedCart);
    mockResolveDeliveryZone.mockResolvedValue({
      zoneId: 'zone-1',
    });

    renderCheckout();

    fireEvent.change(
      await screen.findByLabelText('Address line 1'),
      {
        target: {
          value: '12 Harbour Street',
        },
      },
    );

    fireEvent.change(screen.getByLabelText('Parish'), {
      target: {
        value: 'KINGSTON',
      },
    });

    expect(
      await screen.findByText(
        'Delivery coverage is available for this parish.',
      ),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('button', {
        name: 'Order placement coming later',
      }),
    ).toBeDisabled();
  });

  it('prefills the customer phone after authentication is restored', async () => {
    mockUseAuth.mockReturnValue({
      status: 'loading',
      user: null,
      login: jest.fn(),
      logout: jest.fn(),
    });

    mockGetCart.mockResolvedValue(populatedCart);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
        mutations: {
          retry: false,
        },
      },
    });

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <CheckoutPreparationView />
      </QueryClientProvider>,
    );

    expect(
      screen.getByText('Loading checkout preparation…'),
    ).toBeInTheDocument();

    mockAuthenticatedCustomer();

    rerender(
      <QueryClientProvider client={queryClient}>
        <CheckoutPreparationView />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByLabelText('Delivery phone'),
    ).toHaveValue('8765551234');
  });

  it('rejects an implausible delivery phone during preparation', async () => {
    mockAuthenticatedCustomer({
      ...customer,
      phone: null,
    });
    mockGetCart.mockResolvedValue(populatedCart);

    renderCheckout();

    const phoneInput =
      await screen.findByLabelText('Delivery phone');

    fireEvent.change(phoneInput, {
      target: {
        value: 'abc123',
      },
    });

    expect(
      screen.getByText('Enter a valid delivery phone number.'),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('button', {
        name: 'Complete delivery details',
      }),
    ).toBeDisabled();
  });
});
