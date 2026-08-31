import { UserRole, UserStatus, type AuthUser } from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CartView } from './cart-view';
import {
  getCart,
  removeCartItem,
  updateCartItemQuantity,
  type CartResponse,
} from '@/lib/api/cart';
import { useAuth } from '@/lib/auth/auth-context';

jest.mock('@/lib/api/cart');
jest.mock('@/lib/auth/auth-context');

const mockGetCart = getCart as jest.MockedFunction<typeof getCart>;
const mockRemoveCartItem = removeCartItem as jest.MockedFunction<typeof removeCartItem>;
const mockUpdateCartItemQuantity =
  updateCartItemQuantity as jest.MockedFunction<typeof updateCartItemQuantity>;
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

function renderCart(): QueryClient {
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
      <CartView />
    </QueryClientProvider>,
  );

  return queryClient;
}

describe('CartView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prompts an unauthenticated visitor to sign in without requesting the cart', () => {
    mockUseAuth.mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderCart();

    expect(screen.getByRole('heading', { name: 'Your cart' })).toBeInTheDocument();
    expect(screen.getByText('Sign in to view and manage your cart.')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?returnUrl=%2Fcart',
    );

    expect(mockGetCart).not.toHaveBeenCalled();
  });

  it('does not request a customer cart for a non-customer account', () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: vendor,
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderCart();

    expect(
      screen.getByText('Shopping carts are available to customer accounts.'),
    ).toBeInTheDocument();

    expect(mockGetCart).not.toHaveBeenCalled();
  });

  it('shows the empty-cart state for a customer', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    mockGetCart.mockResolvedValue(emptyCart);

    renderCart();

    expect(await screen.findByText('Your cart is empty.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue shopping' })).toHaveAttribute(
      'href',
      '/',
    );

    expect(mockGetCart).toHaveBeenCalledTimes(1);
  });

  it('renders customer cart items and total', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    mockGetCart.mockResolvedValue(populatedCart);

    renderCart();

    expect(await screen.findByText('Red Snapper')).toBeInTheDocument();
    expect(screen.getByText('Subtotal: 5000.00')).toBeInTheDocument();
    expect(screen.getByText('5000.00', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('2')).toBeInTheDocument();
  });

  it('updates an item quantity through the cart API', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    mockGetCart.mockResolvedValue(populatedCart);

    const originalItem = populatedCart.items[0];

    if (!originalItem) {
      throw new Error('Expected populated cart fixture to contain an item.');
    }

    const updatedCart: CartResponse = {
      ...populatedCart,
      items: [
        {
          ...originalItem,
          quantity: 3,
          subtotal: '7500.00',
        },
      ],
      total: '7500.00',
    };

    mockUpdateCartItemQuantity.mockResolvedValue(updatedCart);

    renderCart();

    const quantityInput = await screen.findByDisplayValue('2');

    fireEvent.change(quantityInput, {
      target: { value: '3' },
    });

    await waitFor(() => {
      expect(mockUpdateCartItemQuantity).toHaveBeenCalledWith('item-1', 3);
    });

    expect(await screen.findByDisplayValue('3')).toBeInTheDocument();
  });

  it('removes an item through the cart API', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    mockGetCart.mockResolvedValue(populatedCart);
    mockRemoveCartItem.mockResolvedValue(emptyCart);

    renderCart();

    const removeButton = await screen.findByRole('button', { name: 'Remove' });

    fireEvent.click(removeButton);

    await waitFor(() => {
      expect(mockRemoveCartItem).toHaveBeenCalledWith(
        'item-1',
        expect.anything(),
      );
    });

    expect(await screen.findByText('Your cart is empty.')).toBeInTheDocument();
  });
});
